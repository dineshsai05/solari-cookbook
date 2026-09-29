import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxClient, type Sandbox } from '@solarisdk/sandbox';
import type { Document, Project } from './schema.js';

export interface InputFile { id: string; name: string; role: 'plans' | 'supporting'; bytes: Buffer }
export interface Processor { inspect(): Promise<Document[]>; build(project: Project, form: Uint8Array): Promise<void>; close(): Promise<void> }
const execute = promisify(execFile);

export async function createProcessor(options: { mode: 'live' | 'local'; root: string; out: string; inputs: InputFile[]; apiKey?: string; python: string; event: (name: string, detail: unknown) => Promise<void> }): Promise<Processor> {
  const { root, out, mode, inputs, event } = options;
  const manifest = inputs.map((f, i) => ({ id: f.id, name: f.name, role: f.role, file: `doc-${i}.pdf` }));
  let sandbox: Sandbox | undefined;
  const work = mode === 'live' ? '/tmp/permit-pilot' : join(out, 'processing');
  const command = async (binary: string, args: string[], timeout = 60_000) => {
    if (sandbox) {
      const result = await sandbox.commands.run(binary, { args, timeoutMs: timeout });
      if (result.exitCode !== 0) throw new Error(`Sandbox tool ${binary} failed (exit ${result.exitCode}). No package completed.`);
    } else {
      await execute(binary, args, { timeout, maxBuffer: 2_000_000 });
    }
  };
  const write = async (name: string, bytes: Uint8Array | string) => { if (sandbox) await sandbox.files.write(`${work}/${name}`, bytes); else await writeFile(join(work, name), bytes); };
  const read = async (name: string) => sandbox ? Buffer.from(await sandbox.files.read(`${work}/${name}`)) : readFile(join(work, name));
  const close = async () => { if (sandbox) { try { await sandbox.kill(); await event('sandbox_destroyed', { id: sandbox.id }); } finally { sandbox.close(); } } };
  try {
    if (mode === 'live') {
      const client = new SandboxClient({ apiKey: options.apiKey!, baseUrl: 'https://api.getsolari.com', callTimeoutMs: 180_000 });
      sandbox = await client.create({ template: 'base', timeoutMs: 5 * 60_000 });
      await event('sandbox_created', { id: sandbox.id });
      await sandbox.connect();
      await command('mkdir', ['-p', work]);
      // Solari's base image has pip but lacks ensurepip. Let its system pip
      // manage an isolated interpreter instead of bootstrapping pip in it.
      await command('python3', ['-m', 'venv', '--without-pip', `${work}/venv`]);
    } else await mkdir(work, { recursive: true });
    const python = sandbox ? `${work}/venv/bin/python` : options.python;
    await write('process.py', await readFile(join(root, 'python/process.py')));
    await write('requirements.txt', await readFile(join(root, 'python/requirements.txt')));
    if (sandbox) await command('python3', ['-m', 'pip', '--python', python, 'install', '--disable-pip-version-check', '--no-input', '-r', `${work}/requirements.txt`], 180_000);
    await write('input.json', JSON.stringify(manifest));
    for (const [i, file] of inputs.entries()) await write(`doc-${i}.pdf`, file.bytes);
    return {
      async inspect() { await command(python, [`${work}/process.py`, 'inspect', work]); return JSON.parse((await read('documents.json')).toString()) as Document[]; },
      async build(project, form) {
        await write('project.json', JSON.stringify(project)); await write('form.pdf', form);
        await command(python, [`${work}/process.py`, 'build', work]);
        for (const name of ['draft-application.pdf', 'field-values.json']) await writeFile(join(out, name), await read(name));
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
