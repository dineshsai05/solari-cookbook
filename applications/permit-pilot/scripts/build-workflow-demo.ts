// Curate existing run evidence; never publish environment, raw session IDs or campaign data.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportHTML } from '../src/report.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = async (p: string) => JSON.parse(await readFile(join(root, p), 'utf8'));
const c = await read('cases/farmdale.json');
const { analysis } = await read('proof/farmdale/reviewed-analysis.json');
const groups = ['Before demolition', 'Before grading', 'Confirm applicability', 'Confirm applicability', 'Before final inspection', 'Partition / future work', 'Partition', 'Partition', 'Before issuance', 'Before issuance', 'Partition', 'Before issuance', 'Historical notice'];
const suggestedOwners = ['Permit coordinator', 'Civil engineer', 'Permit coordinator', 'Permit coordinator', 'Civil engineer', 'Civil engineer / legal', 'Surveyor / legal', 'Surveyor / legal', 'Fire protection engineer', 'Surveyor', 'Permit coordinator', 'Permit coordinator', 'Permit coordinator'];
const data = {
  name: c.name, location: c.location, projectPage: c.projectPage, caseIds: c.caseIds,
  capturedAt: '2026-09-29', authorityStatus: 'Recorded MOC decision: partial approval (December 11, 2025). Building permit status not established.',
  coverage: 'Selected historical land-use documents; 43 text-analysis pages and 42 drawing pages indexed only. Original June final decision and a complete building-permit checklist are not included. Current fulfillment is unknown.',
  overview: analysis.overview, files: c.files.map(({ id, url, pages, bytes, analyze }: any) => ({ id, url, pages, bytes, analyze })),
  tasks: analysis.tasks.map((t: any, i: number) => ({ ...t, id: `FD-${String(i + 1).padStart(2, '0')}`, group: groups[i], suggestedOwner: suggestedOwners[i] })),
  timeline: analysis.timeline, changes: analysis.changes, questions: analysis.questions,
  preparation: [] as any[],
};
for (const [variant, path, label] of [
  ['incomplete', 'artifacts/1790655617572-live', 'Recorded live Solari + AIML run · September 29, 2026'],
  ['corrected', 'artifacts/workflow-corrected-20260930', 'Local verification of revised sample · deterministic parser, no new AI run'],
]) {
  const source = join(root, path!), dest = join(root, 'proof/preparation', variant!);
  await mkdir(join(dest, 'inputs'), { recursive: true });
  const result = JSON.parse(await readFile(join(source, 'result.json'), 'utf8'));
  const sources = JSON.parse(await readFile(join(source, 'sources.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  if (manifest.status !== 'completed' || manifest.synthetic !== true) throw new Error('Only completed synthetic preparation runs may be published');
  for (const name of ['draft-application.pdf', 'result.json', 'documents.json', 'field-values.json']) await copyFile(join(source, name), join(dest, name));
  await copyFile(join(source, 'inputs/document-1.pdf'), join(dest, 'inputs/document-1.pdf'));
  await writeFile(join(dest, 'report.html'), reportHTML(result.project, result.mode, result.findings, sources));
  await writeFile(join(dest, 'manifest.json'), JSON.stringify({ mode: manifest.mode, synthetic: true, status: manifest.status, startedAt: manifest.startedAt, provider: manifest.provider, model: manifest.model }, null, 2));
  const events = (await readFile(join(source, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => { const { name, at } = JSON.parse(line); return { name, at }; });
  await writeFile(join(dest, 'events.json'), JSON.stringify(events, null, 2));
  data.preparation.push({ variant, label, base: `preparation/${variant}`, result, events, sources: sources.map(({ id, url, title, capturedAt }: any) => ({ id, url, title, capturedAt })) });
}
await writeFile(join(root, 'public/workflow-data.json'), JSON.stringify(data, null, 2) + '\n');
console.log('Curated workflow data and preparation evidence. Session IDs excluded.');
