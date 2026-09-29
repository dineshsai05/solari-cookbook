import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function publishDemo(live?: { url: string; expiresAt: string }) {
  const run = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();
  const repo = await run(root, 'rev-parse', '--show-toplevel');
  await run(repo, 'fetch', 'fork', 'gh-pages');
  const wt = await mkdtemp(join(tmpdir(), 'permit-pilot-pages-'));
  await run(repo, 'worktree', 'add', '--detach', wt, 'fork/gh-pages');
  try {
    for (const file of ['try.html', 'demo.css', 'demo.js', '404.html']) await copyFile(join(root, 'public', file), join(wt, file));
    // Also accept the trailing-dot URL the original demo was shared with.
    await rm(join(wt, 'try.'), { force: true });
    if (live) await writeFile(join(wt, 'live.json'), JSON.stringify(live, null, 2));
    else { try { await readFile(join(wt, 'live.json')); } catch { await copyFile(join(root, 'public', 'live.json'), join(wt, 'live.json')); } }
    for (const slug of ['pinecrest', 'atherton']) await copyFile(join(root, 'proof', slug, 'report.html'), join(wt, slug, 'report.html'));
    await copyFile(join(root, 'proof', 'pinecrest', 'replay.json'), join(wt, 'pinecrest', 'replay.json'));
    const g = (...args: string[]) => run(wt, ...args);
    await g('add', '-A', '--', 'try.html', 'demo.css', 'demo.js', '404.html', 'live.json', 'pinecrest/report.html', 'atherton/report.html', 'pinecrest/replay.json');
    await g('add', '-u');
    if (await g('diff', '--cached', '--name-only')) {
      await g('-c', 'user.name=dineshsai05', '-c', 'user.email=dineshsai050106@gmail.com', 'commit', '-m', 'Publish guided PermitPilot demo with explicit live availability');
      await g('push', 'fork', 'HEAD:gh-pages');
    }
    console.log('Demo published: https://dineshsai05.github.io/solari-cookbook/try.html');
  } finally { await run(repo, 'worktree', 'remove', '--force', wt).catch(() => undefined); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await publishDemo();
