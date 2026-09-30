import pg from 'pg';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Job } from './web-state.js';

export interface PermitTask { id: string; jobId: string; title: string; owner: string; dueDate: string | null; status: 'open' | 'in_progress' | 'done'; notes: string; version: number; updatedAt: string }
export class PostgresStore {
  private pool: pg.Pool;
  private lease?: pg.PoolClient;
  private healthy = false;
  constructor(connectionString: string, private onLeaseLost = () => {}) {
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, query_timeout: 10000 });
    this.pool.on('error', () => {}); // Failed queries still reject; the worker lease has its own fail-stop handler.
  }
  async open() {
    this.lease = await this.pool.connect();
    this.lease.on('error', () => { this.healthy = false; this.onLeaseLost(); });
    const lock = await this.lease.query('SELECT pg_try_advisory_lock(714026091) AS acquired');
    if (!lock.rows[0].acquired) { await this.close(); throw new Error('Another PermitPilot runner owns this database. Only one active runner is supported.'); }
    await this.lease.query(`
      CREATE TABLE IF NOT EXISTS pp_jobs (
        id text PRIMARY KEY, payload jsonb NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','completed','failed')),
        created_at timestamptz NOT NULL DEFAULT now(), ip_hash text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pp_jobs_created ON pp_jobs(created_at);
      CREATE TABLE IF NOT EXISTS pp_artifacts (
        job_id text NOT NULL REFERENCES pp_jobs(id), name text NOT NULL, content bytea NOT NULL,
        PRIMARY KEY(job_id,name)
      );
      CREATE TABLE IF NOT EXISTS pp_tasks (
        id text PRIMARY KEY, job_id text NOT NULL REFERENCES pp_jobs(id), title text NOT NULL,
        owner text NOT NULL DEFAULT '', due_date date, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done')),
        notes text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS pp_tasks_job ON pp_tasks(job_id);
      CREATE TABLE IF NOT EXISTS pp_task_audit (
        id bigserial PRIMARY KEY, task_id text NOT NULL REFERENCES pp_tasks(id), action text NOT NULL,
        before_value jsonb, after_value jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now()
      );
    `);
    this.healthy = true;
  }
  private assertHealthy() { if (!this.healthy) throw new Error('Database runner lease is unavailable'); }
  async restore(root: string) {
    this.assertHealthy();
    const { rows } = await this.pool.query('SELECT payload, status FROM pp_jobs ORDER BY created_at');
    const jobs = new Map<string, Job>();
    for (const row of rows) {
      const job = row.payload as Job; job.status = row.status; job.dir = join(root, basename(job.dir));
      if (job.status === 'running') {
        job.status = 'failed'; job.finishedAt = new Date().toISOString(); job.error = 'The runner restarted during capture. Start a new run; this attempt was not automatically retried.';
        await this.save(job);
      }
      jobs.set(job.id, job);
    }
    return jobs;
  }
  async enqueue(job: Job, ip: string, dailyLimit: number, hourlyLimit: number, maxQueued: number) {
    this.assertHealthy(); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(714026092)');
      const ipHash = createHash('sha256').update(ip).digest('hex');
      const { rows } = await client.query(`SELECT count(*) FILTER (WHERE created_at > now()-interval '24 hours')::int AS daily,
        count(*) FILTER (WHERE created_at > now()-interval '1 hour' AND ip_hash=$1)::int AS hourly,
        count(*) FILTER (WHERE status='queued')::int AS queued FROM pp_jobs`, [ipHash]);
      if (rows[0].daily >= dailyLimit) throw new Error('The daily capture allowance has been reached.');
      if (rows[0].hourly >= hourlyLimit) throw new Error('The hourly capture allowance for this connection has been reached.');
      if (rows[0].queued >= maxQueued) throw new Error('The capture queue is full.');
      await client.query('INSERT INTO pp_jobs(id,payload,status,ip_hash) VALUES($1,$2,$3,$4)', [job.id, job, 'queued', ipHash]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async save(job: Job) {
    this.assertHealthy();
    const result = await this.pool.query('UPDATE pp_jobs SET payload=$2,status=$3 WHERE id=$1', [job.id, job, job.status]);
    if (!result.rowCount) throw new Error('Cannot update an unknown capture');
  }
  async archive(jobId: string, files: Map<string, Buffer>) {
    this.assertHealthy();
    const packed = [...files].map(([name, data]) => {
      if (data.length > 25 * 1024 * 1024) throw new Error('Report file exceeds storage limit');
      return [name, gzipSync(data)] as const;
    });
    const size = packed.reduce((n, [, data]) => n + data.length, 0);
    if (size > 20 * 1024 * 1024) throw new Error('Report exceeds storage limit');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(714026093)');
      const usage = await client.query('SELECT COALESCE(sum(octet_length(content)),0)::bigint AS bytes FROM pp_artifacts WHERE job_id <> $1', [jobId]);
      if (Number(usage.rows[0].bytes) + size > 100 * 1024 * 1024) throw new Error('Report storage allowance reached');
      await client.query('DELETE FROM pp_artifacts WHERE job_id=$1', [jobId]);
      for (const [name, data] of packed) await client.query('INSERT INTO pp_artifacts(job_id,name,content) VALUES($1,$2,$3)', [jobId,name,data]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async artifact(jobId: string, name: string): Promise<Buffer | null> {
    this.assertHealthy();
    const result = await this.pool.query('SELECT content FROM pp_artifacts WHERE job_id=$1 AND name=$2', [jobId,name]);
    return result.rowCount ? gunzipSync(result.rows[0].content, { maxOutputLength: 25 * 1024 * 1024 }) : null;
  }
  async listJobs() {
    this.assertHealthy();
    const { rows } = await this.pool.query('SELECT payload FROM pp_jobs ORDER BY created_at DESC LIMIT 200');
    return rows.map(({ payload: j }) => ({ id: j.id, portal: j.portalLabel, permit: j.permit, status: j.status, createdAt: j.createdAt, error: j.error }));
  }
  private task(row: Record<string, any>): PermitTask {
    return { id: row.id, jobId: row.job_id, title: row.title, owner: row.owner, dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null, status: row.status, notes: row.notes, version: row.version, updatedAt: new Date(row.updated_at).toISOString() };
  }
  async listTasks(jobId: string) {
    const { rows } = await this.pool.query('SELECT *, due_date::text FROM pp_tasks WHERE job_id=$1 ORDER BY updated_at DESC', [jobId]);
    return rows.map(r => this.task(r));
  }
  async createTask(jobId: string, input: TaskInput) {
    this.assertHealthy(); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomBytes(12).toString('hex');
      const { rows } = await client.query(`INSERT INTO pp_tasks(id,job_id,title,owner,due_date,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *,due_date::text`, [id, jobId, input.title, input.owner, input.dueDate, input.status, input.notes]);
      const task = this.task(rows[0]);
      await client.query("INSERT INTO pp_task_audit(task_id,action,after_value) VALUES($1,'created',$2)", [id, task]);
      await client.query('COMMIT'); return task;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async updateTask(id: string, input: TaskInput, version: number) {
    this.assertHealthy(); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT *,due_date::text FROM pp_tasks WHERE id=$1 FOR UPDATE', [id]);
      if (!before.rowCount) throw new Error('Task not found');
      if (before.rows[0].version !== version) throw new Error('Task changed since you opened it. Refresh before saving.');
      const { rows } = await client.query('UPDATE pp_tasks SET title=$2,owner=$3,due_date=$4,status=$5,notes=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING *,due_date::text', [id, input.title, input.owner, input.dueDate, input.status, input.notes]);
      const task = this.task(rows[0]);
      await client.query("INSERT INTO pp_task_audit(task_id,action,before_value,after_value) VALUES($1,'updated',$2,$3)", [id, this.task(before.rows[0]), task]);
      await client.query('COMMIT'); return task;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async audit(id: string) { return (await this.pool.query('SELECT action,before_value,after_value,at FROM pp_task_audit WHERE task_id=$1 ORDER BY id', [id])).rows; }
  async ping() { this.assertHealthy(); await this.lease!.query('SELECT 1'); }
  async close() { this.healthy = false; this.lease?.release(true); this.lease = undefined; await this.pool.end(); }
}
export type TaskInput = Pick<PermitTask, 'title' | 'owner' | 'dueDate' | 'status' | 'notes'>;
export function validateTask(value: unknown): TaskInput {
  if (!value || typeof value !== 'object') throw new Error('Task must be an object');
  const v = value as Record<string, unknown>;
  const str = (key: string, max: number) => { if (typeof v[key] !== 'string' || v[key].length > max) throw new Error(`Invalid task ${key}`); return (v[key] as string).trim(); };
  const title = str('title', 500); if (!title) throw new Error('Task title is required');
  const owner = str('owner', 120), notes = str('notes', 4000);
  if (!['open', 'in_progress', 'done'].includes(String(v.status))) throw new Error('Invalid task status');
  const dueDate = v.dueDate === null || v.dueDate === '' ? null : String(v.dueDate);
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || new Date(dueDate+'T00:00:00Z').toISOString().slice(0,10) !== dueDate)) throw new Error('Invalid due date');
  return { title, owner, notes, dueDate, status: v.status as TaskInput['status'] };
}
