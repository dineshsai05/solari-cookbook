// Re-render recorded evidence with current disclosure/UI logic. Does not recapture or call APIs.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portalReport } from '../src/portal-report.js';
import { replaySnapshot, SnapshotSchema } from '../src/portal-snapshot.js';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const slug of ['pinecrest', 'atherton']) {
  const dir = join(root, 'proof', slug);
  const json = async (name: string) => JSON.parse(await readFile(join(dir, name), 'utf8'));
  const c = JSON.parse(await readFile(join(root, 'cases', slug + '.json'), 'utf8'));
  const snapshot = SnapshotSchema.parse(await json('snapshot.json'));
  const manifest = await json('manifest.json');
  const analysis = await json('analysis.json').catch(() => null);
  const replay = manifest.replayAsOf ? replaySnapshot(snapshot, manifest.replayAsOf) : null;
  if (replay) await writeFile(join(dir, 'replay.json'), JSON.stringify(replay, null, 2));
  const html = portalReport(c, snapshot, {
    model: analysis?.model ?? null, usage: analysis?.usage ?? null, capturedAt: snapshot.capturedAt,
    diff: await json('diff.json').catch(() => null), comparedWith: 'the earlier recorded capture', replay,
    analysis: analysis?.analysis ?? null, documents: await json('documents.json'), sessionId: null,
    desktop: manifest.desktop ? { app: 'libreoffice', screenshot: 'desktop-tracker.png' } : null,
    replaySaved: manifest.replaySaved,
    checklistSkipped: !snapshot.reviews.some(r => r.notes.trim()) ? 'This portal publishes no reviewer notes for this permit, so there is no comment text to link.' : null,
  });
  await writeFile(join(dir, 'report.html'), html);
}
