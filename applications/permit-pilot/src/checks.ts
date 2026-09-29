import { normalize, type Analysis, type Document, type Finding, type Project, type Source } from './schema.js';

export function check(project: Project, docs: Document[], analysis: Analysis, sources: Source[]): Finding[] {
  const findings: Finding[] = [];
  const sourceHas = (id: string, phrase: string) => sources.some(s => s.id === id && normalize(s.text).includes(normalize(phrase)));
  const plans = docs.filter(d => d.role === 'plans');
  const incomplete = plans.some(d => d.error || !d.pages.length || d.pages.some(p => p.text.length < 80 || p.textTruncated));
  for (const kind of ['site', 'structural', 'elevation'] as const) {
    const evidence = analysis.pages.filter(p => plans.some(d => d.id === p.documentId)).flatMap(p => p.kinds.filter(k => k.kind === kind).map(k => ({ documentId: p.documentId, page: p.page, quote: k.quote })));
    const verified = sourceHas('drawings', kind === 'elevation' ? 'elevation drawing' : `${kind} plans`);
    findings.push({ id: `${kind}-drawing`, title: `${kind} drawing information`, status: !verified ? 'needs_review' : evidence.length ? 'evidence_found' : incomplete ? 'needs_review' : 'missing', sourceId: 'drawings', evidence,
      explanation: !verified ? 'The current source does not confirm the reviewed requirement. Check changed guidance.' : evidence.length ? 'Supporting text was located; drawing content and adequacy still require human review.' : incomplete ? 'Some plan pages could not be fully read. Absence cannot be established.' : 'No supporting drawing text was identified in the supplied plan files. Verify against the originals.' });
  }
  const addresses = analysis.pages.flatMap(p => p.addresses.map(a => ({ ...a, documentId: p.documentId, page: p.page })));
  const mismatched = addresses.filter(a => normalize(a.value) !== normalize(project.address));
  findings.push({ id: 'address-consistency', title: 'Project address consistency', status: mismatched.length ? 'conflict' : !addresses.length || incomplete ? 'needs_review' : 'evidence_found', sourceId: null,
    explanation: mismatched.length ? 'A document address differs from the project input. Formatting differences also require confirmation; values are not silently replaced.' : 'Checks only addresses extracted from readable text; it does not verify jurisdiction or ownership.',
    evidence: addresses.map(({ documentId, page, quote }) => ({ documentId, page, quote })) });
  const sizes = new Set(plans.flatMap(d => d.pages.map(p => `${Math.round(p.width)}x${Math.round(p.height)}`)));
  findings.push({ id: 'sheet-sizes', title: 'Consistent plan sheet sizes', status: !sourceHas('files', 'same sheet size') || plans.some(d => d.error) || !sizes.size ? 'needs_review' : sizes.size > 1 ? 'conflict' : 'evidence_found', sourceId: 'files', evidence: [], explanation: `Observed plan page sizes in points: ${[...sizes].join(', ') || 'unavailable'}.` });
  findings.push({ id: 'combined-plans', title: 'Single plan-set PDF', status: !sourceHas('files', 'single PDF file') ? 'needs_review' : plans.length === 1 ? 'evidence_found' : plans.length === 0 ? 'missing' : 'conflict', sourceId: 'files', evidence: [], explanation: `${plans.length} file(s) were declared as plans. The pipeline preserves original plan files; it does not silently merge or change drawings.` });
  for (const d of docs) if (d.encrypted || d.error || d.pages.some(p => p.text.length < 80 || p.textTruncated)) findings.push({ id: `readability-${d.id}`, title: `Readability: ${d.name}`, status: 'needs_review', sourceId: 'files', evidence: [], explanation: d.encrypted ? 'Password-protected PDF; provide an unprotected copy.' : d.error || 'Some pages have insufficient text or exceeded the extraction limit. OCR/visual review is not implemented in this prototype.' });
  const missing = [!project.owner.name && 'owner name', !project.applicant.name && 'applicant name', !project.valuation && 'valuation', !project.contractor.name && 'contractor name', !project.contractor.license && 'contractor license'].filter(Boolean);
  findings.push({ id: 'project-fields', title: 'Core application inputs', status: missing.length ? 'missing' : 'evidence_found', sourceId: 'application', evidence: [], explanation: missing.length ? `Missing: ${missing.join(', ')}.` : 'Core supplied fields are present. Contact details, license validity, signatures and other applicable form fields still need review.' });
  findings.push({ id: 'scope-review', title: 'Site conditions and applicability', status: 'needs_review', sourceId: 'changes', evidence: [], explanation: project.scopeConfirmed ? 'User confirmed the narrow project scope. Parcel, current local rules, site conditions, design adequacy and signatures still require professional/applicant review.' : 'Confirm jurisdiction and narrow deck scope; review overlays, site conditions, ground disturbance, loads and applicable supplemental forms.' });
  return findings;
}
