import { SandboxClient, type Sandbox } from '@solarisdk/sandbox';

export type Run = (cmd: string, args: string[], timeoutMs?: number) => Promise<void>;
export interface PythonSandbox { sandbox: Sandbox; run: Run; python: string; work: string }

/**
 * Creates a Solari sandbox with an isolated interpreter and pinned pypdfium2,
 * hands it to `fn`, and destroys it afterwards whatever happens. The sandbox
 * receives only files the host writes; it never sees API keys.
 */
export async function withPythonSandbox<T>(apiKey: string, event: (name: string, detail?: unknown) => Promise<void>, fn: (box: PythonSandbox) => Promise<T>): Promise<T> {
  const client = new SandboxClient({ apiKey, baseUrl: 'https://api.getsolari.com', callTimeoutMs: 180_000 });
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await client.create({ template: 'base', timeoutMs: 300_000 });
    await event('sandbox_created', { id: sandbox.id });
    await sandbox.connect();
    const run: Run = async (cmd, args, timeoutMs = 180_000) => {
      const r = await sandbox!.commands.run(cmd, { args, timeoutMs });
      if (r.exitCode !== 0) throw new Error(`Sandbox ${cmd} failed (exit ${r.exitCode})`);
    };
    const work = '/tmp/permit-pilot';
    await run('mkdir', ['-p', work]);
    // Solari's base image has pip but lacks ensurepip: let system pip populate an isolated venv.
    await run('python3', ['-m', 'venv', '--without-pip', `${work}/venv`]);
    const python = `${work}/venv/bin/python`;
    await run('python3', ['-m', 'pip', '--python', python, 'install', '--disable-pip-version-check', '--no-input', 'pypdfium2==5.13.0']);
    return await fn({ sandbox, run, python, work });
  } finally {
    if (sandbox) { try { await sandbox.kill(); await event('sandbox_destroyed'); } finally { sandbox.close(); } }
  }
}
