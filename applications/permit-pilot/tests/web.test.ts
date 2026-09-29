import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectAttachments } from '../src/portal-etrakit.js';
import { parseAttachmentKey, type Attachment } from '../src/portal-snapshot.js';
import { resolveCase, listPortals, PERMIT_NUMBER } from '../src/portal-cases.js';

const att = (key: string, label: string, name: string): Attachment => ({ key, label, name, url: `https://pine-trk.aspgov.com/eTRAKiT/viewAttachment.aspx?key=${encodeURIComponent(key)}`, void: /^VOID/.test(label), keyTimestampHint: parseAttachmentKey(key).hint, downloaded: null });
const listing = [
  att('ECON:250428073641504', 'Answer Sheet Rev2', 'ANSWER SHEET REV _2 (04-28-2025).pdf'),
  att('ECON:250428073641503', 'Structural Calculations', '7559-Structural Calculations SS.pdf'),
  att('ECON:250428073641502', 'Structural Plan Rev2', '7. S-01 Rev2.pdf'),
  att('EPRS:250318110926699', 'VOID Structural Plan Rev1', '7. S-01 Rev1.pdf'),
  att('EPRS:250318110926700', 'Electrical Plan Rev1', '8. E-01 Rev1.pdf'),
  att('ECO:24121707002633', 'VOID Structural Plan', '7. S-01.pdf'),
  att('ECO:24121707002637', 'Permit Application', 'Pool Permit App 6290.pdf'),
  att('ECO:24121707002638', 'Survey', 'Survey 6290 Chapman.pdf'),
];
test('automatic selection takes responses, newest drawings, and the VOID revision each superseded', () => {
  const chosen = selectAttachments(listing);
  assert.deepEqual(chosen.map(c => [c.id, c.role]), [
    ['answer-sheet-rev-2-04-28-2025', 'applicant_response'],
    ['7559-structural-calculations-ss', 'drawing_current'],
    ['7-s-01-rev2', 'drawing_current'],
    ['8-e-01-rev1', 'drawing_current'],
    ['7-s-01-rev1', 'drawing_superseded'],
  ]);
  assert.ok(chosen.every(c => c.pin === null));
  assert.equal(selectAttachments(listing, 2).length, 2, 'bounded by max');
  assert.deepEqual(selectAttachments([]), []);
});
test('permit numbers and portals are validated before anything touches the network', async () => {
  for (const ok of ['BL2024-1706', 'BP26-00421', '0392571', '2607-0001']) assert.ok(PERMIT_NUMBER.test(ok), ok);
  for (const bad of ['', 'a', 'BL 2024', 'x'.repeat(30), '../etc', 'BL;2024']) assert.ok(!PERMIT_NUMBER.test(bad), bad);
  const dir = await mkdtemp(join(tmpdir(), 'cases-'));
  await writeFile(join(dir, 'pinecrest.json'), JSON.stringify({ name: 'Pinecrest permit BL2024-1706', authority: 'Village of Pinecrest', origin: 'https://pine-trk.aspgov.com', searchPath: '/eTRAKiT/Search/permit.aspx', permitNumber: 'BL2024-1706', expectedSiteAddress: '6290 CHAPMAN FIELD DR', qualifiedAt: '2026-09-29', attachments: [{ id: 'a', match: 'ANSWER', role: 'applicant_response', sha256: 'x'.repeat(64), pages: 1 }] }));
  const pinned = await resolveCase(dir, 'pinecrest', undefined);
  assert.equal(pinned.slug, 'pinecrest'); assert.equal(pinned.c.attachments.length, 1);
  const same = await resolveCase(dir, 'pinecrest', 'BL2024-1706');
  assert.equal(same.slug, 'pinecrest', 'the pinned permit keeps its pins');
  const other = await resolveCase(dir, 'pinecrest', 'BL2025-0001');
  assert.equal(other.slug, 'pinecrest-bl2025-0001'); assert.equal(other.c.attachments.length, 0); assert.equal(other.c.autoAttachments, true); assert.equal(other.c.expectedSiteAddress, ''); assert.equal(other.c.origin, 'https://pine-trk.aspgov.com');
  const url = await resolveCase(dir, 'https://athr-trk.aspgov.com/eTRAKiT/Search/permit.aspx', 'BP26-00421');
  assert.equal(url.slug, 'athr-trk-aspgov-com-bp26-00421'); assert.equal(url.c.origin, 'https://athr-trk.aspgov.com'); assert.match(url.c.notes ?? '', /Unqualified/);
  await assert.rejects(resolveCase(dir, 'https://u:p@evil.test', 'BL1'), /credentials/);
  await assert.rejects(resolveCase(dir, '../pinecrest', 'BL1'), /case name/);
  await assert.rejects(resolveCase(dir, 'pinecrest', 'bad permit'), /unexpected characters/);
  assert.deepEqual((await listPortals(dir)).map(p => p.slug), ['pinecrest']);
});
