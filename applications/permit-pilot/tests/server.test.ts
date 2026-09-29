import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { Script } from 'node:vm';

// Exercise the real HTTP server with an isolated fake worker. Never loads .env or calls paid APIs.
test('HTTP admission, script syntax, artifact permissions and reports survive restart', { timeout: 30_000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'permit-http-')); let child: ChildProcess | undefined;
  const stop = async () => { if (!child || child.exitCode !== null) return; const exited = new Promise<void>(r => child!.once('exit', () => r())); child.kill('SIGTERM'); await exited; };
  try {
    await mkdir(join(dir, 'src')); await cp(join(root, 'cases'), join(dir, 'cases'), { recursive: true });
    for (const f of ['server.ts', 'web-state.ts', 'portal-cases.ts', 'admin-ui.ts']) await copyFile(join(root, 'src', f), join(dir, 'src', f));
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'));
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'src', 'portal-cli.ts'), `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';const out=process.argv[process.argv.indexOf('--out')+1];await writeFile(join(out,'report.html'),'Test report');await writeFile(join(out,'events.jsonl'),JSON.stringify({name:'portal_report_generated',at:new Date().toISOString()})+'\\n');await writeFile(join(out,'replay.ndjson'),'{}');await writeFile(join(out,'model-response.json'),'private');`);
    const start = () => new Promise<string>((resolve, reject) => {
      child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: dir, env: { ...process.env, DATABASE_URL: '', PORT: '0', SOLARI_API_KEY: 'fake', AIML_API_KEY: 'fake', AIML_MODEL: 'fake', PERMITPILOT_DATA_DIR: join(dir, 'data'), PERMITPILOT_DAILY_LIMIT: '3' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout!.on('data', b => { output += b; const match = /http:\/\/localhost:(\d+)/.exec(output); if (match) resolve(`http://127.0.0.1:${match[1]}`); });
      child.stderr!.on('data', b => { output += b; }); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(output)); });
    });
    let url = await start();
    const home = await fetch(url).then(r => r.text());
    for (const match of home.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]!);
    const request = (portal = 'pinecrest', ip = '1.2.3.4') => fetch(url + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ portal, origin: 'https://127.0.0.1', permit: 'BL2024-1706' }) });
    assert.equal((await request('other')).status, 400);
    const accepted = await request(); assert.equal(accepted.status, 202); const { id } = await accepted.json() as { id: string };
    const jobHtml = await fetch(url + '/jobs/' + id).then(r => r.text());
    for (const match of jobHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]!);
    for (let i = 0; i < 100; i++) {
      const job = await fetch(url + '/api/jobs/' + id).then(r => r.json()) as { status: string; events: {name:string;at:string}[] };
      if (job.status === 'completed') { assert.ok(job.events[0]!.at); break; }
      if (i === 99) assert.fail('worker never completed');
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal((await fetch(url + '/r/' + id + '/report.html')).status, 200);
    assert.equal((await fetch(url + '/r/' + id + '/replay.ndjson')).status, 200);
    assert.equal((await fetch(url + '/r/' + id + '/model-response.json')).status, 404);
    const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => request('pinecrest', 'spoof-' + i)));
    assert.equal(responses.filter(r => r.status === 202).length, 2);
    assert.equal(responses.filter(r => r.status === 429).length, 3);
    await stop(); url = await start();
    assert.equal((await fetch(url + '/r/' + id + '/report.html')).status, 200);
    assert.equal((await request()).status, 429, 'restarting cannot reset the daily allowance');
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
