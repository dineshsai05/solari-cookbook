import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/checks.js';
import { analyzeFixtures, validateAnalysis } from '../src/model.js';
import { ProjectSchema, type Document, type Source } from '../src/schema.js';
import { isOfficial } from '../src/sources.js';

const contact = { name: 'Example', address: null, cityStateZip: null, phone: null, email: null };
const project = ProjectSchema.parse({ name: 'test', synthetic: true, jurisdiction: 'portland-or', permitType: 'attached-uncovered-residential-deck', address: '123 Example Lane', cityStateZip: 'Portland', parcel: null, description: 'Deck', deckAreaSqFt: 192, valuation: 100, owner: contact, contractor: { ...contact, license: null }, applicant: { ...contact, business: null }, scopeConfirmed: false, documents: [{ path: 'plans.pdf', role: 'plans' }] });
const sources: Source[] = [{ id: 'drawings', text: 'Site plans. Structural plans. Elevation drawing.' }, { id: 'files', text: 'same sheet size; single PDF file' }].map(s => ({ ...s, url: 'https://www.portland.gov/', title: '', capturedAt: '', sha256: '', mode: 'reference-excerpt' }));
const doc = (text: string, extra = {}): Document => ({ id: 'd1', name: 'plans.pdf', role: 'plans', sha256: 'test', encrypted: false, error: null, pages: [{ number: 1, width: 612, height: 792, text, textTruncated: false }], ...extra });
const structural = 'Drawing type: structural\nProject address: 123 Example Lane\nThis is a synthetic structural illustration with enough text to test extraction.';

test('missing drawing and conflicting address are distinct findings', () => {
  const docs = [doc(structural.replace('123 Example Lane', '321 Example Lane'))];
  const findings = check(project, docs, analyzeFixtures(docs), sources);
  assert.equal(findings.find(f => f.id === 'site-drawing')?.status, 'missing');
  assert.equal(findings.find(f => f.id === 'address-consistency')?.status, 'conflict');
});
test('unreadable page cannot establish a missing document', () => {
  const docs = [doc('')];
  assert.equal(check(project, docs, analyzeFixtures(docs), sources).find(f => f.id === 'site-drawing')?.status, 'needs_review');
});
test('a changed official source prevents passing a requirement', () => {
  const docs = [doc(structural)];
  assert.equal(check(project, docs, analyzeFixtures(docs), []).find(f => f.id === 'structural-drawing')?.status, 'needs_review');
});
test('reject fabricated citations, addresses, duplicate and omitted pages', () => {
  const docs = [doc(structural)];
  assert.throws(() => validateAnalysis({ pages: [] }, docs));
  const good = analyzeFixtures(docs);
  assert.throws(() => validateAnalysis({ pages: [...good.pages, ...good.pages] }, docs));
  assert.throws(() => validateAnalysis({ pages: [{ documentId: 'd1', page: 1, kinds: [{ kind: 'site', quote: 'invented' }], addresses: [] }] }, docs));
  assert.throws(() => validateAnalysis({ pages: [{ documentId: 'd1', page: 1, kinds: [], addresses: [{ value: 'invented', quote: '123 Example Lane' }] }] }, docs));
});
test('drawing mentions in supporting documents do not satisfy plan requirements', () => {
  const docs = [doc(structural, { role: 'supporting' })];
  assert.equal(check(project, docs, analyzeFixtures(docs), sources).find(f => f.id === 'structural-drawing')?.status, 'missing');
});
test('website identity checks reject lookalikes and insecure schemes', () => {
  assert.equal(isOfficial('https://www.portland.gov/ppd'), true);
  for (const url of ['https://www.portland.gov.evil.test', 'http://www.portland.gov', 'https://user:pass@www.portland.gov', 'file:///tmp/a']) assert.equal(isOfficial(url), false);
});
test('inconsistent plan sizes are flagged and review remains required', () => {
  const d = doc(structural); d.pages.push({ ...d.pages[0]!, number: 2, width: 792, height: 612 });
  const findings = check(project, [d], analyzeFixtures([d]), sources);
  assert.equal(findings.find(f => f.id === 'sheet-sizes')?.status, 'conflict');
  assert.equal(findings.find(f => f.id === 'scope-review')?.status, 'needs_review');
});
