import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { ProjectSchema } from './schema.js';
import { collectLive, collectReference, digest } from './sources.js';
import { createProcessor, type InputFile, type Processor } from './processor.js';
import { analyzeFixtures, analyzeLive } from './model.js';
import { check } from './checks.js';
import { reportHTML } from './report.js';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: join(root, '.env'), quiet: true });
const { values } = parseArgs({ options: { mode: { type: 'string', default: 'live' }, project: { type: 'string' }, out: { type: 'string' }, python: { type: 'string', default: 'python3' }, doctor: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
if (values.help) {
  console.log('npm start -- --project fixtures/generated/incomplete/project.json [--mode live|local] [--python python3] [--out NEW_DIRECTORY]\nnpm start -- --doctor\nLocal mode uses real PDF processing but a deterministic fixture parser, NOT Solari or AI.');
} else if (values.doctor) {
  for (const key of ['SOLARI_API_KEY', 'AIML_API_KEY', 'AIML_MODEL']) console.log(`${key}: ${process.env[key]?.trim() ? 'configured' : 'missing'}`);
  process.exitCode = ['SOLARI_API_KEY', 'AIML_API_KEY', 'AIML_MODEL'].every(k => process.env[k]?.trim()) ? 0 : 1;
} else {
  try { await main(); }
  catch (error) {
    // Vendor errors can include request URLs, authentication data or PDF text.
    console.error(error instanceof Error && ['ZodError'].includes(error.name) ? 'Invalid project input; check the documented schema.' : redact(error instanceof Error ? error.message : 'Run failed'));
    process.exitCode = 1;
  }
}

function redact(message: string) {
  let result = message;
  for (const key of ['SOLARI_API_KEY', 'AIML_API_KEY', 'OPENAI_API_KEY']) if (process.env[key]) result = result.split(process.env[key]!).join('[REDACTED]');
  return result.replace(/https?:\/\/[^\s]+/g, '[URL omitted]').slice(0, 1500);
}

async function main() {
  if (values.mode !== 'live' && values.mode !== 'local') throw new Error('Mode must be live or local');
  const mode = values.mode;
  if (!values.project) throw new Error('Provide --project PATH. Use npm run fixtures for sample inputs.');
  if (mode === 'live') {
    const missing = ['SOLARI_API_KEY', 'AIML_API_KEY', 'AIML_MODEL'].filter(k => !process.env[k]?.trim());
    if (missing.length) throw new Error(`Live run requires ${missing.join(', ')} in the ignored .env. No sessions created.`);
  }
  const projectPath = await realpath(resolve(values.project));
  const base = dirname(projectPath);
  const projectBytes = await readFile(projectPath);
  const project = ProjectSchema.parse(JSON.parse(projectBytes.toString()));
  if (mode === 'local' && !project.synthetic) throw new Error('Local fixture mode only accepts synthetic projects');
  const inputs: InputFile[] = [];
  let total = 0;
  for (const [i, doc] of project.documents.entries()) {
    const path = await realpath(resolve(base, doc.path));
    const rel = relative(base, path);
    if (rel.startsWith('..') || isAbsolute(rel) || !path.toLowerCase().endsWith('.pdf')) throw new Error('Document paths must be PDFs inside the project directory');
    const bytes = await readFile(path); total += bytes.length;
    if (bytes.length > 10_000_000 || total > 30_000_000 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF or upload size limit exceeded');
    inputs.push({ id: `document-${i + 1}`, name: basename(path), role: doc.role, bytes });
  }
  const out = resolve(values.out || join(root, 'artifacts', `${Date.now()}-${mode}`));
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Refuse existing output directories: previous evidence is immutable.
  await mkdir(join(out, 'sources')); await mkdir(join(out, 'inputs'));
  const event = async (name: string, detail: unknown) => {
    await appendFile(join(out, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), name, detail }) + '\n');
    console.log(name);
  };
  const manifest = { version: 1, mode, provider: mode === 'live' ? 'aiml' : null, model: mode === 'live' ? process.env.AIML_MODEL : null, projectSha256: digest(projectBytes), startedAt: new Date().toISOString(), status: 'running', synthetic: project.synthetic };
  const saveManifest = () => writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await saveManifest();
  let processor: Processor | undefined;
  try {
    for (const file of inputs) await writeFile(join(out, 'inputs', `${file.id}.pdf`), file.bytes);
    await event('started', { mode });
    const { sources, form } = mode === 'live' ? await collectLive(process.env.SOLARI_API_KEY!, out, event) : await collectReference(root, out);
    await writeFile(join(out, 'sources.json'), JSON.stringify(sources, null, 2));
    processor = await createProcessor({ mode, root, out, inputs, apiKey: process.env.SOLARI_API_KEY, python: values.python!, event });
    const documents = await processor.inspect();
    if (documents.reduce((n, d) => n + d.pages.reduce((s, p) => s + p.text.length, 0), 0) > 100_000) throw new Error('Extracted text exceeds prototype model-input budget; reduce the document set');
    await writeFile(join(out, 'documents.json'), JSON.stringify(documents, null, 2));
    await event('documents_extracted', { count: documents.length });
    const interpreted = mode === 'live' ? await analyzeLive(documents, process.env.AIML_API_KEY!, process.env.AIML_MODEL!) : { analysis: analyzeFixtures(documents), usage: null, responseId: null };
    await writeFile(join(out, 'analysis.json'), JSON.stringify(interpreted, null, 2));
    const findings = check(project, documents, interpreted.analysis, sources);
    await processor.build(project, form);
    await writeFile(join(out, 'result.json'), JSON.stringify({ mode, project: project.name, status: 'draft_requires_review', findings, inputs: documents.map(({ id, name, sha256 }) => ({ id, name, sha256 })) }, null, 2));
    await writeFile(join(out, 'report.html'), reportHTML(project.name, mode, findings, sources));
    await event('draft_generated', { findings: findings.length });
    await processor.close(); processor = undefined;
    manifest.status = 'completed'; await saveManifest();
    console.log(`Artifacts: ${out}\nDraft generated; human review remains required.`);
  } catch (error) {
    manifest.status = 'failed'; await saveManifest();
    await event('failed', { errorType: error instanceof Error ? error.name : 'unknown' });
    throw error;
  } finally { if (processor) await processor.close(); }
}
