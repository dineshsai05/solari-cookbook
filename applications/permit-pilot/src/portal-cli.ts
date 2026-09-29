import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { Solari } from '@solarisdk/browser';
import { captureSnapshot, type PortalCase } from './portal-pinecrest.js';
import { diffSnapshots, replaySnapshot, SnapshotSchema, type Snapshot, type SnapshotDiff } from './portal-snapshot.js';
import { analyzePortal, attachmentDocId, reviewDocuments, type PortalAnalysisResult } from './portal-analysis.js';
import { portalReport } from './portal-report.js';
import { withPythonSandbox } from './sandbox-python.js';
import type { PassageDocument } from './passages.js';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: join(root, '.env'), quiet: true });
const { values } = parseArgs({ options: { compare: { type: 'string' }, replay: { type: 'string' }, 'no-model': { type: 'boolean', default: false }, help: { type: 'boolean' } }, strict: true });
if (values.help) {
  console.log('npm run demo:pinecrest -- [--compare artifacts/<previous>] [--replay YYYY-MM-DD] [--no-model]\nRead-only public portal capture. Requires SOLARI_API_KEY; AIML_API_KEY and AIML_MODEL unless --no-model.');
} else {
  try { await main(); } catch (error) {
    let message = error instanceof Error ? error.message : 'Portal run failed';
    for (const key of ['SOLARI_API_KEY', 'AIML_API_KEY']) if (process.env[key]) message = message.split(process.env[key]!).join('[REDACTED]');
    console.error(message.replace(/https?:\/\/[^\s]+/g, '[URL omitted]').slice(0, 1200)); process.exitCode = 1;
  }
}

async function main() {
  const required = values['no-model'] ? ['SOLARI_API_KEY'] : ['SOLARI_API_KEY', 'AIML_API_KEY', 'AIML_MODEL'];
  for (const key of required) if (!process.env[key]?.trim()) throw new Error(`${key} is missing`);
  const c: PortalCase = JSON.parse(await readFile(join(root, 'cases/pinecrest.json'), 'utf8'));
  let previous: Snapshot | undefined;
  if (values.compare) previous = SnapshotSchema.parse(JSON.parse(await readFile(join(resolve(values.compare), 'snapshot.json'), 'utf8')));
  const out = join(root, 'artifacts', `${Date.now()}-pinecrest-live`);
  await mkdir(join(out, 'attachments'), { recursive: true });
  const event = async (name: string, detail: unknown = {}) => { console.log(name); await appendFile(join(out, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), name, detail }) + '\n'); };
  const manifest = { mode: 'live-public-portal', status: 'running', case: c.name, permitNumber: c.permitNumber, startedAt: new Date().toISOString(), provider: values['no-model'] ? null : 'aiml', model: values['no-model'] ? null : process.env.AIML_MODEL, comparedWith: values.compare ? resolve(values.compare) : null, replayAsOf: values.replay ?? null, browserSessionId: null as string | null };
  const save = () => writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await save();
  try {
    const client = new Solari({ apiKey: process.env.SOLARI_API_KEY! });
    let browser: Awaited<ReturnType<Solari['launch']>> | undefined;
    let captured: Awaited<ReturnType<typeof captureSnapshot>>;
    try {
      browser = await client.launch({ recording: true });
      manifest.browserSessionId = browser.id; await save();
      await event('browser_created', { id: browser.id });
      const page = await browser.newPage();
      captured = await captureSnapshot(page, c, out, event, browser.id);
    } finally { try { if (browser) await browser.close(); } finally { await client.close(); } }
    const { snapshot, files } = captured;
    await writeFile(join(out, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    await event('snapshot_saved', { reviews: snapshot.reviews.length, attachments: snapshot.attachments.length });

    const extracted = await withPythonSandbox(process.env.SOLARI_API_KEY!, event, async ({ sandbox, run, python, work }) => {
      const staged = [...files.entries()].map(([id, bytes], i) => ({ id, file: `att-${i}.pdf`, bytes, url: snapshot.attachments.find(a => a.downloaded?.id === id)!.url }));
      for (const s of staged) await sandbox.files.write(`${work}/${s.file}`, s.bytes);
      await sandbox.files.write(`${work}/attachments.json`, JSON.stringify(staged.map(({ id, file, url }) => ({ id, file, url }))));
      await sandbox.files.write(`${work}/extract.py`, await readFile(join(root, 'python/portal_extract.py')));
      await run(python, [`${work}/extract.py`, work]);
      return JSON.parse(Buffer.from(await sandbox.files.read(`${work}/documents.json`)).toString()) as { id: string; url: string; pages: PassageDocument['pages'] }[];
    });
    for (const pin of c.attachments) if (extracted.find(d => d.id === pin.id)?.pages.length !== pin.pages) throw new Error(`Attachment page count changed: ${pin.id}`);
    const documents: PassageDocument[] = [...reviewDocuments(snapshot), ...extracted.map(d => ({ id: attachmentDocId(d.id), url: d.url, pages: d.pages }))];
    await writeFile(join(out, 'documents.json'), JSON.stringify(documents, null, 2));
    await event('attachments_extracted', { documents: extracted.length, pages: extracted.reduce((n, d) => n + d.pages.length, 0) });

    let diff: SnapshotDiff | null = null;
    if (previous) { diff = diffSnapshots(previous, snapshot); await writeFile(join(out, 'diff.json'), JSON.stringify(diff, null, 2)); await event('snapshot_compared', { changed: diff.changed }); }
    let replay: Snapshot | null = null;
    if (values.replay) { replay = replaySnapshot(snapshot, values.replay); await writeFile(join(out, 'replay.json'), JSON.stringify(replay, null, 2)); await event('replay_reconstructed', { asOf: values.replay, reviews: replay.reviews.length }); }

    let analysis: PortalAnalysisResult | null = null; let model: string | null = null; let usage: unknown = null;
    if (!values['no-model']) {
      const result = await analyzePortal(snapshot, documents, process.env.AIML_API_KEY!, process.env.AIML_MODEL!, r => writeFile(join(out, 'model-response.json'), JSON.stringify(r, null, 2)));
      analysis = result.analysis; model = result.model; usage = result.usage;
      await writeFile(join(out, 'analysis.json'), JSON.stringify(result, null, 2));
      await event('checklist_generated', { items: analysis.items.length, questions: analysis.questions.length });
    }
    await writeFile(join(out, 'report.html'), portalReport(c, snapshot, { model, usage, capturedAt: snapshot.capturedAt, diff, comparedWith: previous?.capturedAt ?? null, replay, analysis, documents, sessionId: snapshot.sessionId }));
    manifest.status = 'completed'; await save(); await event('portal_report_generated');
    console.log(`Report: ${join(out, 'report.html')}`);
  } catch (error) { manifest.status = 'failed'; await save(); await event('failed', { errorType: error instanceof Error ? error.name : 'unknown' }); throw error; }
}
