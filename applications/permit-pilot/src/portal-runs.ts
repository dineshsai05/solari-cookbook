import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Most recent completed run directory for a case, or null. Pure function of the artifacts folder. */
export async function latestRun(artifacts: string, caseName: string): Promise<string | null> {
  let names: string[];
  try { names = await readdir(artifacts); } catch { return null; }
  const suffix = `-${caseName}-live`;
  const candidates = names.filter(n => n.endsWith(suffix) && /^\d+-/.test(n)).sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]));
  for (const name of candidates) {
    const dir = join(artifacts, name);
    try {
      await stat(join(dir, 'snapshot.json'));
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      if (manifest.status === 'completed') return dir;
    } catch { /* incomplete run: keep looking */ }
  }
  return null;
}
