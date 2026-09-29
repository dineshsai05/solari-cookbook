// Usage: node --import tsx scripts/host-on-solari.ts [--stop] [--status]
// Hosts the web demo inside a Solari sandbox and exposes it on a public
// *.preview.getsolari.com URL. The sandbox runs this application's server,
// which in turn creates its own browser, sandbox and desktop sessions per run.
// Solari clamps sandbox lifetime (about five hours on this account), so this
// script stays in the foreground sending a keep-alive; run it again to re-host.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from 'dotenv';
import { SandboxClient } from '@solarisdk/sandbox';
const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: join(root, '.env'), quiet: true });
const state = join(root, 'artifacts', 'web-host.json');
const client = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: 'https://api.getsolari.com', callTimeoutMs: 300_000 });
const PORT = 8080;
if (process.argv.includes('--stop')) {
  const saved = JSON.parse(await readFile(state, 'utf8')); await client.kill(saved.sandboxId); console.log('stopped', saved.url.split('?')[0]); process.exit(0);
}
if (process.argv.includes('--status')) {
  const saved = JSON.parse(await readFile(state, 'utf8')); const v = await client.get(saved.sandboxId).catch(() => null); console.log(v ? `${v.state} until ${saved.expiresAt}: ${saved.url}` : 'gone'); process.exit(0);
}
for (const key of ['SOLARI_API_KEY', 'AIML_API_KEY', 'AIML_MODEL']) if (!process.env[key]?.trim()) throw new Error(`${key} is missing`);
const tmp = await mkdtemp(join(tmpdir(), 'permit-pilot-host-'));
const tarball = join(tmp, 'app.tgz');
// Ship the working tree, not a git export, so an unpushed fix can be hosted. Secrets, runs and proof stay home.
await promisify(execFile)('tar', ['-czf', tarball, '-C', root, '--exclude=node_modules', '--exclude=.venv', '--exclude=artifacts', '--exclude=proof', '--exclude=fixtures/generated', '--exclude=.env', '--exclude=python/__pycache__', '.']);
const bytes = await readFile(tarball);
const sandbox = await client.create({ template: 'base', timeoutMs: 5 * 3_600_000, metadata: { app: 'permit-pilot-web' } });
console.log('sandbox', sandbox.id.slice(0, 12) + '…', 'expires', sandbox.expiresAt);
try {
  await sandbox.connect();
  const run = async (cmd: string, args: string[], timeoutMs = 300_000) => { const r = await sandbox.commands.run(cmd, { args, timeoutMs }); if (r.exitCode !== 0) throw new Error(`${cmd} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(-600)}`); return r; };
  await run('mkdir', ['-p', '/app']);
  await sandbox.files.write('/app/app.tgz', bytes);
  await run('tar', ['-xzf', '/app/app.tgz', '-C', '/app']);
  await sandbox.files.write('/app/.env', `SOLARI_API_KEY=${process.env.SOLARI_API_KEY}\nAIML_API_KEY=${process.env.AIML_API_KEY}\nAIML_MODEL=${process.env.AIML_MODEL}\nPORT=${PORT}\nPERMITPILOT_WEB_DESKTOP=${process.env.PERMITPILOT_WEB_DESKTOP ?? '0'}\nPERMITPILOT_CONTACT=${process.env.PERMITPILOT_CONTACT ?? ''}\n`, 0o600);
  console.log('installing dependencies in the sandbox…');
  await run('sh', ['-c', 'cd /app && npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -3'], 600_000);
  await run('sh', ['-c', `cd /app && nohup node --import tsx src/server.ts > /app/server.log 2>&1 &`]);
  const { url } = await sandbox.previewUrl(PORT);
  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) { await new Promise(r => setTimeout(r, 2000)); try { healthy = (await fetch(url.replace(/\?.*$/, '/healthz$&').replace('/healthz?', '/healthz?'))).ok; } catch { /* not yet */ } }
  if (!healthy) { const log = await sandbox.files.readText('/app/server.log').catch(() => ''); throw new Error('Server did not come up:\n' + log.slice(-1500)); }
  await writeFile(state, JSON.stringify({ sandboxId: sandbox.id, url, createdAt: new Date().toISOString(), expiresAt: sandbox.expiresAt }, null, 2));
  console.log('\nLIVE:', url, '\n\nKeep this process running. Ctrl-C leaves the sandbox up until', sandbox.expiresAt, '; --stop kills it.');
  process.on('SIGINT', () => { console.log('\nleaving the sandbox running; use --stop to end it'); sandbox.close(); process.exit(0); });
  while (true) {
    await new Promise(r => setTimeout(r, 180_000));
    try { await sandbox.commands.run('true', { timeoutMs: 30_000 }); const h = await fetch(url.replace(/\?.*$/, '/healthz$&')).then(r => r.json()).catch(() => null); console.log(new Date().toISOString(), 'alive', JSON.stringify(h)); }
    catch (error) { console.log(new Date().toISOString(), 'keep-alive failed:', error instanceof Error ? error.message.slice(0, 120) : error); }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message.split(process.env.SOLARI_API_KEY!).join('[REDACTED]') : error);
  await sandbox.kill().catch(() => undefined); sandbox.close(); process.exit(1);
}
