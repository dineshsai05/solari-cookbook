import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { Solari } from '@solarisdk/browser';
import { captureSnapshot, type PortalCase } from './portal-etrakit.js';
import { trackerCsv, updateTrackerOnDesktop } from './desktop-tracker.js';
import { latestRun } from './portal-runs.js';
import { resolveCase } from './portal-cases.js';
import { diffSnapshots, replaySnapshot, SnapshotSchema, type Snapshot, type SnapshotDiff } from './portal-snapshot.js';
import { analyzePortal, attachmentDocId, reviewDocuments, type PortalAnalysisResult } from './portal-analysis.js';
import { portalReport } from './portal-report.js';
import { withPythonSandbox } from './sandbox-python.js';
import type { PassageDocument } from './passages.js';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: join(root, '.env'), quiet: true });
const { values } = parseArgs({ options: { case: { type: 'string' }, portal: { type: 'string' }, permit: { type: 'string' }, out: { type: 'string' }, compare: { type: 'string' }, 'no-compare': { type: 'boolean', default: false }, replay: { type: 'string' }, 'no-model': { type: 'boolean', default: false }, desktop: { type: 'boolean', default: false }, help: { type: 'boolean' } }, strict: true });
if (values.help) {
  console.log('npm run demo:pinecrest -- [--case pinecrest|atherton] [--portal <case|https://host> --permit <number>] [--out DIR] [--compare DIR | --no-compare] [--replay YYYY-MM-DD] [--no-model] [--desktop]\nRead-only public portal capture. Compares against the latest earlier run of the same case unless told otherwise.\nRequires SOLARI_API_KEY; AIML_API_KEY and AIML_MODEL unless --no-model. --desktop opens the tracker on a Solari Desktop.');
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
  const { c, slug } = await resolveCase(join(root, 'cases'), values.portal ?? values.case ?? 'pinecrest', values.permit);
  const artifacts = values.out ? dirname(resolve(values.out)) : join(root, 'artifacts');
  let previous: Snapshot | undefined; let previousDir: string | null = null;
  if (values.compare) previousDir = resolve(values.compare);
  else if (!values['no-compare']) previousDir = await latestRun(artifacts, slug);
  if (previousDir) {
    previous = SnapshotSchema.parse(JSON.parse(await readFile(join(previousDir, 'snapshot.json'), 'utf8')));
    if (previous.permitNumber !== c.permitNumber) throw new Error('Previous snapshot is for a different permit');
  }
  const out = values.out ? resolve(values.out) : join(artifacts, `${Date.now()}-${slug}-live`);
  if (values.out && !basename(out).endsWith(`-${slug}-live`)) throw new Error(`--out must end with -${slug}-live so later runs can find it`);
  await mkdir(join(out, 'attachments'), { recursive: true });
  const event = async (name: string, detail: unknown = {}) => { console.log(name); await appendFile(join(out, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), name, detail }) + '\n'); };
  const manifest = { mode: 'live-public-portal', status: 'running', case: c.name, slug, portal: c.origin, permitNumber: c.permitNumber, startedAt: new Date().toISOString(), provider: values['no-model'] ? null : 'aiml', model: values['no-model'] ? null : process.env.AIML_MODEL, comparedWith: previousDir, replayAsOf: values.replay ?? null, browserSessionId: null as string | null, desktop: values.desktop, replaySaved: false };
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
    // The rrweb replay uploads asynchronously after release; poll briefly and keep going without it.
    if (browser) {
      const replayClient = new Solari({ apiKey: process.env.SOLARI_API_KEY! });
      try {
        for (let attempt = 1; attempt <= 4; attempt++) {
          await new Promise(r => setTimeout(r, 3000));
          try { const blob = await replayClient.sessions.downloadReplay(browser.id); await writeFile(join(out, 'replay.ndjson'), blob); manifest.replaySaved = true; await save(); await event('replay_saved', { bytes: blob.length, events: Buffer.from(blob).toString().split('\n').filter(Boolean).length }); break; }
          catch (error) { if (attempt === 4) await event('replay_unavailable', { errorType: error instanceof Error ? error.name : 'unknown' }); }
        }
      } finally { await replayClient.close(); }
    }
    await writeFile(join(out, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    await event('snapshot_saved', { reviews: snapshot.reviews.length, attachments: snapshot.attachments.length });

    const extracted = files.size === 0 ? [] : await withPythonSandbox(process.env.SOLARI_API_KEY!, event, async ({ sandbox, run, python, work }) => {
      const staged = [...files.entries()].map(([id, bytes], i) => ({ id, file: `att-${i}.pdf`, bytes, url: snapshot.attachments.find(a => a.downloaded?.id === id)!.url }));
      for (const s of staged) await sandbox.files.write(`${work}/${s.file}`, s.bytes);
      await sandbox.files.write(`${work}/attachments.json`, JSON.stringify(staged.map(({ id, file, url }) => ({ id, file, url }))));
      await sandbox.files.write(`${work}/extract.py`, await readFile(join(root, 'python/portal_extract.py')));
      await run(python, [`${work}/extract.py`, work]);
      return JSON.parse(Buffer.from(await sandbox.files.read(`${work}/documents.json`)).toString()) as PassageDocument[];
    });
    if (files.size === 0) await event('sandbox_skipped', { reason: 'no attachments to extract' });
    for (const pin of c.attachments) if (extracted.find(d => d.id === pin.id)?.pages.length !== pin.pages) throw new Error(`Attachment page count changed: ${pin.id}`);
    const documents: PassageDocument[] = [...reviewDocuments(snapshot), ...extracted.map(d => ({ ...d, id: attachmentDocId(d.id) }))];
    await writeFile(join(out, 'documents.json'), JSON.stringify(documents, null, 2));
    await event('attachments_extracted', { documents: extracted.length, pages: extracted.reduce((n, d) => n + d.pages.length, 0) });

    let diff: SnapshotDiff | null = null;
    if (previous) { diff = diffSnapshots(previous, snapshot); await writeFile(join(out, 'diff.json'), JSON.stringify(diff, null, 2)); await event('snapshot_compared', { with: previousDir, changed: diff.changed }); }
    else await event('first_capture', { reason: values['no-compare'] ? 'comparison disabled' : 'no earlier completed run for this case' });
    let replay: Snapshot | null = null;
    if (values.replay) { replay = replaySnapshot(snapshot, values.replay); await writeFile(join(out, 'replay.json'), JSON.stringify(replay, null, 2)); await event('replay_reconstructed', { asOf: values.replay, reviews: replay.reviews.length }); }

    let analysis: PortalAnalysisResult | null = null; let model: string | null = null; let usage: unknown = null; let checklistSkipped: string | null = null;
    if (!values['no-model'] && documents.length === 0) { checklistSkipped = 'This portal publishes no reviewer notes or attachments for this permit, so there is nothing for the checklist to link.'; await event('checklist_skipped', { reason: checklistSkipped }); }
    else if (!values['no-model']) {
      const result = await analyzePortal(snapshot, documents, process.env.AIML_API_KEY!, process.env.AIML_MODEL!, r => writeFile(join(out, 'model-response.json'), JSON.stringify(r, null, 2)));
      analysis = result.analysis; model = result.model; usage = result.usage;
      await writeFile(join(out, 'analysis.json'), JSON.stringify(result, null, 2));
      await event('checklist_generated', { items: analysis.items.length, questions: analysis.questions.length });
    }
    let desktop: { app: string; screenshot: string } | null = null;
    const csv = trackerCsv(snapshot, analysis); await writeFile(join(out, 'tracker.csv'), csv);
    if (values.desktop) desktop = await updateTrackerOnDesktop(process.env.SOLARI_API_KEY!, csv, out, event);
    await writeFile(join(out, 'report.html'), portalReport(c, snapshot, { model, usage, capturedAt: snapshot.capturedAt, diff, comparedWith: previous?.capturedAt ?? null, replay, analysis, documents, sessionId: snapshot.sessionId, checklistSkipped, desktop, replaySaved: manifest.replaySaved }));
    manifest.status = 'completed'; await save(); await event('portal_report_generated');
    console.log(`Report: ${join(out, 'report.html')}`);
  } catch (error) { manifest.status = 'failed'; await save(); await event('failed', { errorType: error instanceof Error ? error.name : 'unknown' }); throw error; }
}

