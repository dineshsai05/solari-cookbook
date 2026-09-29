import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunBudget, restoreJobs, saveJob, type Job } from '../src/web-state.js';

test('budget survives restart and global cap applies across different clients', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'permit-budget-'));
  try {
    const path = join(dir, 'budget.json'); const first = new RunBudget(path, 2, 1); await first.load();
    await first.reserve('ip1', 1000);
    await assert.rejects(first.reserve('ip1', 1001), /hourly/);
    const restarted = new RunBudget(path, 2, 1); await restarted.load();
    await restarted.reserve('ip2', 1002);
    await assert.rejects(restarted.reserve('ip3', 1003), /daily/);
    await restarted.reserve('ip3', 86_402_000);
    await writeFile(path, '{broken'); await assert.rejects(new RunBudget(path).load(), /unreadable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('saved jobs survive restart; interrupted work is failed instead of charged again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'permit-jobs-'));
  try {
    for (const [id, status] of [['abcdef123456', 'completed'], ['123456abcdef', 'running']] as const) {
      const jobDir = join(dir, id); await mkdir(jobDir);
      const job: Job = { id, portal: 'pinecrest', portalLabel: 'Pinecrest', permit: 'BL2024-1706', email: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, status, dir: '/old-host/path', error: null };
      await saveJob({ ...job, dir: jobDir }); await writeFile(join(jobDir, 'report.html'), 'Saved report');
    }
    const jobs = await restoreJobs(dir);
    assert.equal(jobs.get('abcdef123456')!.status, 'completed');
    assert.equal(await readFile(join(jobs.get('abcdef123456')!.dir, 'report.html'), 'utf8'), 'Saved report');
    assert.equal(jobs.get('123456abcdef')!.status, 'failed');
    assert.match(jobs.get('123456abcdef')!.error!, /restarted/);
    assert.equal((await restoreJobs(dir)).get('123456abcdef')!.status, 'failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
