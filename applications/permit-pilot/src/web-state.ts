import { mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface Job { id: string; portal: string; portalLabel: string; permit: string; email: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; status: 'queued' | 'running' | 'completed' | 'failed'; dir: string; error: string | null }
export async function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
export const saveJob = (job: Job) => atomicJson(join(job.dir, 'job.json'), job);
export async function restoreJobs(root: string): Promise<Map<string, Job>> {
  await mkdir(root, { recursive: true });
  const jobs = new Map<string, Job>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let job: Job;
    try { job = JSON.parse(await readFile(join(root, entry.name, 'job.json'), 'utf8')); }
    catch { continue; }
    if (!/^[a-f0-9]{12}$/.test(job.id) || !['queued', 'running', 'completed', 'failed'].includes(job.status)) continue;
    job.dir = join(root, entry.name);
    if (job.status === 'running' || job.status === 'queued') {
      job.status = 'failed'; job.finishedAt = new Date().toISOString();
      job.error = 'The server restarted during this run. Start a new capture; no portal changes were made.';
      await saveJob(job);
    }
    jobs.set(job.id, job);
  }
  return jobs;
}
/** One persistent global budget. Changing a header or restarting cannot reset it. */
export class RunBudget {
  private starts: number[] = [];
  private ips = new Map<string, number[]>();
  constructor(private path: string, private dailyLimit = 10, private hourlyIpLimit = 5) {}
  async load() {
    try { const data = JSON.parse(await readFile(this.path, 'utf8')); this.starts = data.starts; this.ips = new Map(data.ips); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Run budget is unreadable; refusing paid runs'); }
    if (!Array.isArray(this.starts) || this.starts.some(n => typeof n !== 'number')) throw new Error('Invalid run budget');
  }
  // Caller serializes admission, including this disk write, before launching work.
  async reserve(ip: string, now = Date.now()) {
    this.starts = this.starts.filter(t => now - t < 86_400_000);
    for (const [key, values] of this.ips) { const recent = values.filter(t => now - t < 3_600_000); if (recent.length) this.ips.set(key, recent); else this.ips.delete(key); }
    const recent = this.ips.get(ip) ?? [];
    if (this.starts.length >= this.dailyLimit) throw new Error('The demo has reached its daily run allowance. Please explore the recorded example or try again tomorrow.');
    if (recent.length >= this.hourlyIpLimit) throw new Error('The hourly run allowance for this connection is reached. Please try again later.');
    this.starts.push(now); this.ips.set(ip, [...recent, now]);
    await atomicJson(this.path, { starts: this.starts, ips: [...this.ips] });
  }
}
