// Usage: node --import tsx scripts/bundle-proof.ts artifacts/<run> proof/<name>
// Copies one run's evidence into a tracked proof folder. Session identifiers
// and local absolute paths are redacted; downloaded PDFs are not copied because
// the snapshot records their public URLs and SHA-256 hashes.
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error('Pass the run directory and the proof directory');
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const keep = /^(report\.html|snapshot\.json|documents\.json|analysis\.json|reviewed-analysis\.json|model-response\.json|diff\.json|replay\.json|manifest\.json|events\.jsonl|[a-z-]+\.png|project-page\.txt)$/;
const redactValue = (key: string, value: unknown): unknown => {
  if (typeof value === 'string') {
    if (['sessionId', 'browserSessionId'].includes(key) || (key === 'id' && value.length > 60)) return '[redacted session id]';
    if (value.startsWith('/') && value.includes(root)) return basename(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(v => redactValue(key, v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(k, v)]));
  return value;
};
await mkdir(target, { recursive: true });
for (const name of (await readdir(source)).filter(n => keep.test(n)).sort()) {
  const from = join(source, name), to = join(target, name);
  if (name.endsWith('.json')) await writeFile(to, JSON.stringify(redactValue('', JSON.parse(await readFile(from, 'utf8'))), null, 2) + '\n');
  else if (name.endsWith('.jsonl')) await writeFile(to, (await readFile(from, 'utf8')).trim().split('\n').map(l => JSON.stringify(redactValue('', JSON.parse(l)))).join('\n') + '\n');
  else if (name.endsWith('.html') || name.endsWith('.txt')) await writeFile(to, (await readFile(from, 'utf8')).split(root).join('…'));
  else await copyFile(from, to);
  console.log(`${name} -> ${to}`);
}
