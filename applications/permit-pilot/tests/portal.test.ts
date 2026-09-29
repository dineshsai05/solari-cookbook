import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewDetail, isPortalUrl, collapse, type PortalCase } from '../src/portal-pinecrest.js';
import { diffSnapshots, disciplineChain, parseAttachmentKey, replaySnapshot, toIso, SnapshotSchema, type Snapshot } from '../src/portal-snapshot.js';
import { validatePortalAnalysis, reviewDocuments, attachmentDocId, reviewDocId } from '../src/portal-analysis.js';
import { passagesFor, resolveEvidence } from '../src/passages.js';
import { portalReport } from '../src/portal-report.js';
import { digest } from '../src/sources.js';

const detailText = `\n\nGroup:\n\tAUTO\n\nType:\n\tBUILDING\n\nStatus:\n\tDENIED\n\nDate Submitted:\n\t12/17/2024\n\nDate Due:\n\t1/8/2025\n\nDate Completed:\n\t1/8/2025\n\nReviewer:\n\tARDESHIR MAHTABFAR\n\nRemarks:\n\t\n\nNotes:\n\t\n1/8/2025 11:41:08 AM\n1. MAIN POOL 12&quot; FLOOR WITH REINFORCING 1; NEEDS CLARIFICATION.\n2. INDICATE SIZE OF FOUNDATION FOR CHAIN LINK FENCE &amp; GATE POSTS.\n\n\n\n `;
const notes = '1/8/2025 11:41:08 AM\n1. MAIN POOL 12" FLOOR WITH REINFORCING 1; NEEDS CLARIFICATION.\n2. INDICATE SIZE OF FOUNDATION FOR CHAIN LINK FENCE & GATE POSTS.';
const c: PortalCase = { name: 'test', authority: 'Test Village', origin: 'https://pine-trk.aspgov.com', searchPath: '/eTRAKiT/Search/permit.aspx', permitNumber: 'BL2024-1706', expectedSiteAddress: '6290 CHAPMAN FIELD DR', qualifiedAt: '2026-09-29', attachments: [] };
const review = (recordId: string, extra: Partial<Snapshot['reviews'][number]> = {}) => ({ recordId, type: 'BUILDING', reviewer: 'A. REVIEWER', status: 'DENIED', submitted: '12/17/2024', completed: '1/8/2025', dueDate: '1/8/2025', group: 'AUTO', remarks: null, notes, detailUrl: `https://pine-trk.aspgov.com/eTRAKiT/moreinfo/reviewInfo.aspx?RecordID=${recordId}`, sha256: digest(notes), ...extra });
const attachment = (key: string, label: string, name: string, downloaded: Snapshot['attachments'][number]['downloaded'] = null) => ({ key, label, name, url: `https://pine-trk.aspgov.com/eTRAKiT/viewAttachment.aspx?key=${encodeURIComponent(key)}`, void: /^VOID/.test(label), keyTimestampHint: parseAttachmentKey(key).hint, downloaded });
const base: Snapshot = SnapshotSchema.parse({ version: 1, capturedAt: '2026-09-29T00:00:00.000Z', permitNumber: 'BL2024-1706', portalUrl: 'https://pine-trk.aspgov.com/eTRAKiT/Search/permit.aspx', sessionId: null,
  permit: { type: 'E_SWIMMING POOL', subtype: 'RESIDENTIAL', description: 'POOL', status: 'FINALED', siteAddress: '6290 CHAPMAN FIELD DR', appliedDate: '12/17/2024', approvedDate: '5/2/2025', issuedDate: '5/21/2025', finaledDate: '8/21/2026', expirationDate: '2/17/2027' },
  reviews: [review('ECON:1'), review('EM:2', { type: 'BUILDING EXPEDITE', status: 'INCOMPLETE', submitted: '3/18/2025', completed: '3/25/2025', notes: '3/25/2025 MAIN POOL FLOOR NEEDS CLARIFICATION. PLEASE SEE S-01.' }), review('LEO:3', { type: 'BUILDING EXPEDITE', status: 'APPROVED', submitted: '4/28/2025', completed: '5/1/2025', notes: '' })],
  attachments: [attachment('ECO:24121707002633', 'Structural Plan', '7. S-01.pdf'), attachment('EPRS:250318110926699', 'VOID Structural Plan Rev1', '7. S-01 Rev1.pdf'), attachment('ECON:250428073641504', 'Answer Sheet Rev2', 'ANSWER SHEET REV _2.pdf', { id: 'applicant-response-rev2', role: 'applicant_response', sha256: digest('x'), bytes: 10, matchesPinned: true })],
  replay: null });

test('review detail text parses into fields and decoded notes', () => {
  const parsed = parseReviewDetail(detailText);
  assert.equal(parsed.group, 'AUTO'); assert.equal(parsed.type, 'BUILDING'); assert.equal(parsed.status, 'DENIED');
  assert.equal(parsed.submitted, '12/17/2024'); assert.equal(parsed.completed, '1/8/2025'); assert.equal(parsed.reviewer, 'ARDESHIR MAHTABFAR');
  assert.equal(parsed.remarks, null); assert.equal(parsed.notes, notes);
  assert.equal(parseReviewDetail('Type:\n\tZONING\n\nReviewer:\n\tPAT\n\nRemarks:\n\tSee notes\n\nNotes:\n').remarks, 'See notes');
});
test('attachment keys yield timestamp hints only when plausible', () => {
  assert.deepEqual(parseAttachmentKey('ECON:250428073641504'), { prefix: 'ECON', hint: '2025-04-28T07:36:41' });
  assert.equal(parseAttachmentKey('ECON:259928073641504').hint, null);
  assert.equal(parseAttachmentKey('garbage').hint, null);
  assert.equal(toIso('1/8/2025'), '2025-01-08'); assert.equal(toIso('13/1/2025'), null); assert.equal(toIso(null), null);
});
test('portal identity rejects lookalikes, insecure schemes and embedded credentials', () => {
  assert.equal(isPortalUrl(c.origin, 'https://pine-trk.aspgov.com/eTRAKiT/x'), true);
  for (const url of ['https://pine-trk.aspgov.com.evil.test/', 'http://pine-trk.aspgov.com/', 'https://u:p@pine-trk.aspgov.com/', 'javascript:alert(1)']) assert.equal(isPortalUrl(c.origin, url), false);
  assert.equal(collapse('  a \n\t b  '), 'a b');
});
test('an unchanged portal produces no diff; changed rows and labels are itemized', () => {
  const same = structuredClone(base); same.capturedAt = '2026-10-01T00:00:00.000Z'; same.sessionId = 'other';
  assert.equal(diffSnapshots(base, same).changed, false);
  const next = structuredClone(base);
  next.permit.status = 'EXPIRED'; next.reviews[0]!.status = 'APPROVED'; next.reviews.push(review('NEW:4', { submitted: '9/1/2026' }));
  next.attachments[0]!.label = 'VOID Structural Plan'; next.attachments.pop();
  const diff = diffSnapshots(base, next);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.permit, [{ field: 'status', from: 'FINALED', to: 'EXPIRED' }]);
  assert.deepEqual(diff.reviews.changed, [{ recordId: 'ECON:1', fields: ['status'] }]); assert.deepEqual(diff.reviews.added, ['NEW:4']);
  assert.deepEqual(diff.attachments.changed, [{ key: 'ECO:24121707002633', fields: ['label'] }]); assert.deepEqual(diff.attachments.removed, ['ECON:250428073641504']);
  assert.throws(() => diffSnapshots(base, { ...next, permitNumber: 'BL2024-0001' }), /different permits/);
});
test('replay hides later rows, pends unfinished reviews, clears later milestones and is labelled', () => {
  const r = replaySnapshot(base, '2025-03-20');
  assert.deepEqual(r.reviews.map(x => x.recordId), ['ECON:1', 'EM:2']);
  assert.equal(r.reviews[1]!.status, 'REPLAY: pending on this date'); assert.equal(r.reviews[1]!.notes, ''); assert.equal(r.reviews[0]!.status, 'DENIED');
  assert.equal(r.permit.approvedDate, null); assert.equal(r.permit.finaledDate, null); assert.match(r.permit.status!, /^REPLAY/);
  assert.deepEqual(r.attachments.map(a => a.key), ['ECO:24121707002633', 'EPRS:250318110926699']);
  assert.deepEqual(r.replay, { asOf: '2025-03-20', from: base.capturedAt });
  assert.equal(replaySnapshot(base, '2026-09-01').permit.status, 'FINALED');
  assert.throws(() => replaySnapshot(r, '2025-01-01'), /replay a replay/); assert.throws(() => replaySnapshot(base, '3/20/2025'), /YYYY-MM-DD/);
});
test('checklist items must cite their own review, cover every noted review, and back applicant assertions with response evidence', () => {
  const docs = [...reviewDocuments(base), { id: attachmentDocId('applicant-response-rev2'), url: 'https://pine-trk.aspgov.com/a', pages: [{ number: 1, text: 'MAIN POOL FLOOR: PLEASE SEE S-01 (Rev 2)', textTruncated: false }] }];
  assert.equal(docs.filter(d => d.id.startsWith('review:')).length, 2, 'reviews without notes are not documents');
  const p = passagesFor(docs);
  const first = p.find(x => x.documentId === reviewDocId('ECON:1'))!; const own = p.find(x => x.documentId === reviewDocId('EM:2'))!; const resp = p.find(x => x.documentId === attachmentDocId('applicant-response-rev2'))!;
  const earlier = { reviewRecordId: 'ECON:1', commentSummary: 'Six building comments.', responseStatus: 'no_response_in_packet' as const, responseSummary: 'No response sheet for this cycle in the packet.', drawingReference: null, evidence: [{ passageId: first.passageId }] };
  const item = { reviewRecordId: 'EM:2', commentSummary: 'Clarify pool floor reinforcing.', responseStatus: 'applicant_asserted' as const, responseSummary: 'Applicant points to S-01 Rev 2.', drawingReference: 'S-01 Rev 2', evidence: [{ passageId: own.passageId }, { passageId: resp.passageId }] };
  const build = (second: typeof item) => ({ items: resolveEvidence([earlier, second], docs), questions: [] });
  const ok = build(item);
  assert.equal(validatePortalAnalysis(ok, base, docs).items[1]!.evidence[1]!.quote, 'MAIN POOL FLOOR: PLEASE SEE S-01 (Rev 2)');
  assert.throws(() => validatePortalAnalysis(build({ ...item, evidence: [{ passageId: own.passageId }] }), base, docs), /applicant-response evidence/);
  assert.throws(() => validatePortalAnalysis(build({ ...item, evidence: [{ passageId: resp.passageId }] }), base, docs), /own review comment/);
  assert.throws(() => validatePortalAnalysis(build({ ...item, reviewRecordId: 'LEO:3' }), base, docs), /unknown or empty review/);
  assert.throws(() => validatePortalAnalysis({ items: [ok.items[0]!, ok.items[0]!], questions: [] }, base, docs), /duplicates/);
  assert.throws(() => validatePortalAnalysis({ items: [ok.items[0]!], questions: [] }, base, docs), /does not cover review EM:2/);
  assert.throws(() => validatePortalAnalysis({ items: [ok.items[0]!, { ...ok.items[1]!, evidence: [{ documentId: reviewDocId('EM:2'), page: 1, quote: 'invented' }] }], questions: [] }, base, docs), /does not match/);
  assert.throws(() => resolveEvidence([{ ...item, evidence: [{ passageId: 'nope' }] }], docs), /Unknown source/);
});
test('discipline chains follow one department across cycles, treating EXPEDITE rows as the same discipline', () => {
  assert.deepEqual(disciplineChain(base, 'ECON:1').map(r => `${r.recordId}:${r.status}`), ['ECON:1:DENIED', 'EM:2:INCOMPLETE', 'LEO:3:APPROVED']);
  assert.deepEqual(disciplineChain(base, 'missing'), []);
});
test('portal report escapes untrusted text and labels replay, VOID and no-change states', () => {
  const hostile = structuredClone(base); hostile.reviews[0]!.notes = '<script>alert(1)</script>'; hostile.permit.description = '<img src=x>';
  const html = portalReport(c, hostile, { model: null, usage: null, capturedAt: hostile.capturedAt, diff: diffSnapshots(base, hostile), comparedWith: 'earlier', replay: replaySnapshot(hostile, '2025-03-25'), analysis: null, documents: [], sessionId: null });
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('Reconstructed, not observed')); assert.ok(html.includes('class="void"')); assert.ok(html.includes('Model step skipped'));
  assert.ok(html.includes('Portal content changed')); assert.ok(html.includes('outcomes across cycles'));
  const quiet = portalReport(c, base, { model: null, usage: null, capturedAt: base.capturedAt, diff: diffSnapshots(base, base), comparedWith: 'earlier', replay: null, analysis: null, documents: [], sessionId: null });
  assert.ok(quiet.includes('No change:'));
});
