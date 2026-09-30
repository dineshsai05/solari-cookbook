import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Browser module is deliberately dependency-free and exercised unchanged here.
// @ts-expect-error Plain browser JavaScript has no declaration file.
import { freshState, restoreState, updateTask, addRecord, summary, trackerCsv, handoff, responseDraft } from '../public/workflow-state.js';
const data = JSON.parse(await readFile(new URL('../public/workflow-data.json', import.meta.url), 'utf8'));
test('coordinator edits cannot turn a historical condition into authority approval', () => {
  const original = freshState(data);
  assert.throws(() => updateTask(original, 'FD-01', { status: 'evidence_recorded', notes: '' }), /document reference/);
  let state = original;
  for (const t of data.tasks) state = updateTask(state, t.id, { owner: 'Demo team', status: 'evidence_recorded', notes: 'Demo document reference, page 1, checked by coordinator.' });
  assert.equal(original.tasks['FD-01'].status, 'not_started');
  assert.equal(summary(data, state).recorded, data.tasks.length);
  assert.equal(summary(data, state).submissionReady, false);
  assert.equal(summary(data, state).authorityStatus, data.authorityStatus);
  assert.ok(handoff(data, state).tasks.every((t: any) => t.authorityFulfillment === 'unknown'));
  assert.match(responseDraft(data, state), /NOT SENT/);
});
test('manual observations remain separate from authority facts and survive reload', () => {
  const state = addRecord(freshState(data), { reference: 'DEMO-001', status: 'Approved (example)', observed: '2026-09-30', source: 'Synthetic observation for this test only.' });
  const restored = restoreState(data, JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.records, state.records);
  assert.equal(summary(data, restored).authorityStatus, data.authorityStatus);
  assert.equal(handoff(data, restored).demo, true);
  assert.throws(() => addRecord(state, { reference: 'x', status: 'approved' }), /supporting receipt/);
});
test('tracker export neutralizes spreadsheet formulas and reset removes demo edits', () => {
  const state = updateTask(freshState(data), 'FD-01', { owner: '=HYPERLINK("https://example.com")', status: 'in_progress', notes: '+formula' });
  const csv = trackerCsv(data, state);
  assert.ok(csv.includes('"\'=HYPERLINK('));
  assert.ok(csv.includes('"\'+formula"'));
  assert.equal(freshState(data).tasks['FD-01'].owner, '');
  assert.equal(restoreState(data, { version: 99, demo: true }).tasks['FD-01'].owner, '');
});
test('every task has traceable evidence and preparation comparison retains unresolved work', () => {
  for (const t of data.tasks) {
    assert.ok(t.evidence.length);
    for (const e of t.evidence) assert.ok(data.files.some((f: any) => f.id === e.documentId && e.page > 0 && e.page <= f.pages));
  }
  const before = data.preparation[0].result, after = data.preparation[1].result;
  assert.equal(before.mode, 'live'); assert.equal(after.mode, 'local');
  assert.equal(before.findings.find((f: any) => f.id === 'site-drawing').status, 'missing');
  assert.equal(after.findings.find((f: any) => f.id === 'site-drawing').status, 'evidence_found');
  assert.equal(after.findings.find((f: any) => f.id === 'project-fields').status, 'missing');
  assert.equal(after.status, 'draft_requires_review');
  assert.doesNotMatch(JSON.stringify(data), /browserSessionId|SOLARI_API_KEY|pt_token=/);
});
