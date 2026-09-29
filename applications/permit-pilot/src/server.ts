import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from 'dotenv';
import { restoreJobs, saveJob as saveLocalJob, RunBudget, type Job } from './web-state.js';
import { adminPage } from './admin-ui.js';
import type { PostgresStore } from './postgres-store.js';
import { listPortals, PERMIT_NUMBER, slugify } from './portal-cases.js';

// A small web front end for the portal adapter. A visitor picks a portal,
// types a permit number, and the server runs one bounded CLI job for it and
// serves the resulting report. One job at a time; nothing is submitted to
// any portal; API keys stay in this process and its child.

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: join(root, '.env'), quiet: true });
const PORT = Number(process.env.PORT || 8080);
const WEB = resolve(process.env.PERMITPILOT_DATA_DIR || join(root, 'artifacts', 'web'));
const LIVE = process.env.PERMITPILOT_LIVE !== '0';
const MAX_QUEUE = 8, PER_IP_PER_HOUR = 5, JOB_TIMEOUT_MS = 10 * 60_000;
const DESKTOP = process.env.PERMITPILOT_WEB_DESKTOP === '1';
const CONTACT = process.env.PERMITPILOT_CONTACT || '';

let running: { job: Job; child: ChildProcess } | null = null;
const ADMIN_KEY = process.env.PERMITPILOT_ADMIN_KEY ?? '';
let database: PostgresStore | null = null;
if (process.env.DATABASE_URL) {
  if (ADMIN_KEY.length < 32) throw new Error('PostgreSQL mode requires PERMITPILOT_ADMIN_KEY with at least 32 characters');
  const { PostgresStore } = await import('./postgres-store.js');
  database = new PostgresStore(process.env.DATABASE_URL, () => { running?.child.kill('SIGKILL'); process.exit(1); });
  await database.open();
}
if (database) setInterval(() => { void database!.ping().catch(() => { running?.child.kill('SIGKILL'); process.exit(1); }); }, 15_000).unref();
const jobs = database ? await database.restore(WEB) : await restoreJobs(WEB);
const queue: Job[] = [...jobs.values()].filter(j => j.status === 'queued');
async function saveJob(job: Job) { if (database) await database.save(job); await saveLocalJob(job); }
function authorized(req: IncomingMessage) {
  if (!ADMIN_KEY) return false;
  const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + ADMIN_KEY);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const dailyLimit = Number(process.env.PERMITPILOT_DAILY_LIMIT || 10);
if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100) throw new Error('Daily run limit must be between 1 and 100');
const budget = new RunBudget(join(WEB, 'budget.json'), dailyLimit, PER_IP_PER_HOUR); if (!database) await budget.load();
let admission = Promise.resolve();
let starting = false;
let stopping = false;
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = admission; let release!: () => void;
  admission = new Promise<void>(resolve => { release = resolve; });
  await previous; try { return await fn(); } finally { release(); }
}

export interface JobRequest { portal: string; permit: string; email: string | null }
/** Validates a request body against the known portals. Pure: exported for tests. */
export function parseJobRequest(body: unknown, portals: { slug: string }[]): JobRequest {
  if (!body || typeof body !== 'object') throw new Error('Send a JSON object');
  const b = body as Record<string, unknown>;
  const permit = String(b.permit ?? '').trim();
  if (!PERMIT_NUMBER.test(permit)) throw new Error('Permit numbers are 2 to 25 letters, digits, dots or dashes, like BL2024-1706');
  let portal = String(b.portal ?? '').trim();
  if (!portals.some(p => p.slug === portal)) throw new Error('Choose one of the supported portals. Custom portal addresses are not accepted by this public demo.');
  const email = String(b.email ?? '').trim();
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) throw new Error('That email address does not look right');
  return { portal, permit, email: email || null };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const STYLE = `<style>[hidden]{display:none!important}:root{--bg:#f4f5f0;--ink:#20312e;--muted:#52645e;--rule:#d7dfd8;--card:#fff;--accent:#197967;--accent-ink:#0f5a4c;--warn:#fff1cc;color-scheme:light}@media(prefers-color-scheme:dark){:root{--bg:#15201d;--ink:#e6ece8;--muted:#a3b3ad;--rule:#2d3d38;--card:#1c2925;--accent:#5fbfa9;--accent-ink:#8fd6c5;--warn:#3d3410;color-scheme:dark}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif;padding:36px 20px}main{max-width:760px;margin:0 auto;display:grid;gap:26px}h1{font-size:clamp(28px,5vw,40px);line-height:1.1;margin:0;text-wrap:balance}h2{font-size:22px;margin:0}p{margin:0}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:12px;color:var(--muted);font-weight:600}a{color:var(--accent-ink)}.muted{color:var(--muted)}form,.card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:22px;display:grid;gap:14px}label{display:grid;gap:6px;font-weight:600}input,select{font:inherit;padding:10px 12px;border:1px solid var(--rule);border-radius:6px;background:var(--bg);color:var(--ink);width:100%}button{font:inherit;font-weight:600;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:12px 18px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent-ink);outline-offset:2px}.err{color:#8a2f2f;font-weight:600}.notice{background:var(--warn);border-radius:10px;padding:14px 18px}ol.steps{margin:0;padding-left:20px;display:grid;gap:6px}.step{display:flex;gap:10px;align-items:baseline}.step .dot{width:10px;height:10px;border-radius:50%;background:var(--rule);flex:none}.step.done .dot{background:var(--accent)}.step.now .dot{background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 30%,transparent)}small{color:var(--muted)}ul{margin:0;padding-left:20px}</style>`;

function formPage(portals: { slug: string; authority: string; permitNumber: string }[]) {
  const options = portals.map(p => `<option value="${esc(p.slug)}">${esc(p.authority)}</option>`).join('');
  const examples = portals.map(p => `<li>${esc(p.authority)}: try <code>${esc(p.permitNumber)}</code></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PermitPilot</title>${STYLE}</head><body><main>
<header style="display:grid;gap:12px"><span class="eyebrow">PermitPilot · live demo</span><h1>Type a permit number. Get back what the city's portal says about it, with every reviewer comment linked to its source.</h1><p class="muted">A Solari cloud browser searches the public permit portal, opens every departmental review and the reviewer's comment page, lists attachments with the portal's own labels, downloads the applicant's response and drawing revisions, and links each comment to what the applicant said about it. Usually takes two to five minutes. Busy portals can take longer.</p></header>
<form id="f"><label>Portal<select id="portal" name="portal">${options}</select></label><label id="originRow" hidden>Portal address<input id="origin" name="origin" placeholder="https://pine-trk.aspgov.com" autocomplete="off"></label><label>Permit number<input id="permit" name="permit" placeholder="BL2024-1706" required autocomplete="off" maxlength="25"></label><label>Your email <small style="font-weight:400">(optional, only so I can ask what you thought)</small><input id="email" name="email" type="email" placeholder="you@company.com" autocomplete="email"></label><button id="go" type="submit">Run it</button><p id="err" class="err" hidden></p><small>Public records only. The tool never logs in, submits, pays, or changes anything on the portal; the only form it fills is the public search box. Anyone with a report link can read it. Use public permit numbers only. Trial-host reports are available only while that host exists; download your report and tracker.</small></form>
<section class="card"><h2>Try a known permit first</h2><ul>${examples}</ul><p class="muted">Portals verified so far: Village of Pinecrest, FL and Town of Atherton, CA. The public trial supports these two portals. If a portal changes or is unavailable, the run stops with an explanation.</p></section>
<section class="card"><h2>How to use PermitPilot</h2><ol class="steps"><li>Choose a city and paste its permit number. Start with one of the examples above.</li><li>Select Run it. Keep the progress page open to follow the timestamped activity trail. Refreshing this page will not start another run.</li><li>Open the report. Read the current permit status first, then review cycles, document coverage and source-linked comments.</li><li>Download the tracker CSV and snapshot. Run the same permit again to see changes against the last successful capture on this host.</li></ol><p class="muted">An applicant response is a claim, not proof that a drawing was corrected. Older denied reviews remain in the history even after approval. Selected PDFs have page limits, shown in the report.</p><p><a href="https://dineshsai05.github.io/solari-cookbook/try.html">Recorded walkthrough, instructions and feedback</a></p></section>
<section class="card"><h2>What you get</h2><ul><li>Overall status separated from the review history, and the review rows grouped by submission cycle.</li><li>Every reviewer comment verbatim, with that discipline's outcome across cycles.</li><li>A comment-to-response checklist where each claim cites the exact source text, checked by the server.</li><li>Attachments with VOID labels, a tracker CSV, and a snapshot you can diff against the next run.</li></ul></section>
${CONTACT ? `<p class="muted">Questions or feedback: ${esc(CONTACT)}</p>` : ''}
</main><script>
const f=document.getElementById('f'),portal=document.getElementById('portal'),originRow=document.getElementById('originRow'),err=document.getElementById('err'),go=document.getElementById('go');
portal.addEventListener('change',()=>{originRow.hidden=portal.value!=='other';});
f.addEventListener('submit',async e=>{e.preventDefault();err.hidden=true;go.disabled=true;go.textContent='Starting…';
try{const r=await fetch('api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({portal:portal.value,origin:document.getElementById('origin').value,permit:document.getElementById('permit').value,email:document.getElementById('email').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Could not start');location.href='jobs/'+j.id+location.search;}
catch(x){err.textContent=x.message;err.hidden=false;go.disabled=false;go.textContent='Run it';}});
</script></body></html>`;
}
const STEP_LABELS: Record<string, string> = { browser_created: 'Solari browser started', portal_permit_opened: 'Permit found on the portal', portal_permit_info_captured: 'Permit info read', portal_attachments_listed: 'Attachments listed', portal_reviews_captured: 'Reviews and reviewer comments read', portal_attachments_selected: 'Attachments chosen', portal_attachment_downloaded: 'Attachment downloaded', sandbox_created: 'Solari sandbox started', attachments_extracted: 'Attachment text extracted', sandbox_destroyed: 'Sandbox destroyed', snapshot_compared: 'Compared with the previous run', first_capture: 'First capture of this permit', checklist_generated: 'Checklist generated and checked', checklist_skipped: 'Checklist skipped (no notes published)', desktop_created: 'Solari desktop started', desktop_tracker_opened: 'Tracker opened in LibreOffice', portal_report_generated: 'Report ready', failed: 'Run failed' };
function jobPage(job: Job) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PermitPilot</title>${STYLE}</head><body><main>
<header style="display:grid;gap:12px"><span class="eyebrow">PermitPilot · ${esc(job.portalLabel)}</span><h1>Permit ${esc(job.permit)}</h1><p id="state" class="muted">Queued.</p></header>
<section class="card"><h2>Live activity trail</h2><div id="steps" style="display:grid;gap:8px"></div><p id="done" hidden><a id="link" href="#"><b>Open the report</b></a> · <a id="csv" href="#">tracker.csv</a> · <a id="snap" href="#">snapshot.json</a></p><p id="fail" class="err" hidden></p></section>
<p class="muted"><a href="../">Run another permit</a></p></main><script>
const id=${JSON.stringify(job.id)};const labels=${JSON.stringify(STEP_LABELS)};const q=location.search;
async function tick(){try{const r=await fetch('../api/jobs/'+id+q);const j=await r.json();if(!r.ok)throw new Error(j.error||'Connection interrupted');document.getElementById('state').textContent=j.status==='queued'?'Queued behind '+j.ahead+' other run'+(j.ahead===1?'':'s')+'.':j.status==='running'?'Running on Solari. Usually one to two minutes.':j.status==='completed'?'Done.':'Failed.';
const steps=document.getElementById('steps');steps.innerHTML=j.events.map((e,i)=>'<div class="step '+(j.status==='running'&&i===j.events.length-1?'now':'done')+'"><span class="dot"></span><span>'+(labels[e.name]||'Activity')+' <small>'+new Date(e.at).toLocaleTimeString()+'</small>'+'</span></div>').join('');
if(j.status==='completed'){document.getElementById('link').href='../r/'+id+'/report.html'+q;document.getElementById('csv').href='../r/'+id+'/tracker.csv'+q;document.getElementById('snap').href='../r/'+id+'/snapshot.json'+q;document.getElementById('done').hidden=false;return;}
if(j.status==='failed'){const f=document.getElementById('fail');f.textContent=j.error||'The run stopped. Nothing was changed on the portal.';f.hidden=false;return;}
}catch(x){document.getElementById('state').textContent='Connection interrupted. Retrying in five seconds…';}setTimeout(tick,5000);}
tick();</script></body></html>`;
}

async function readJobDir(job: Job) {
  let events: { name: string; at: string }[] = [];
  try { events = (await readFile(join(job.dir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).flatMap(l => { try { const e = JSON.parse(l); return e.name in STEP_LABELS ? [{ name: e.name, at: String(e.at ?? '') }] : []; } catch { return []; } }); } catch { /* not started */ }
  return events;
}
async function pump() {
  if (stopping || starting || running || !queue.length) return;
  starting = true;
  const job = queue.shift()!; job.status = 'running'; job.startedAt = new Date().toISOString();
  try { await mkdir(job.dir, { recursive: true }); await saveJob(job); } catch { starting = false; job.status = 'failed'; job.error = 'Could not persist run state.'; void pump(); return; }
  if (stopping) { job.status = 'queued'; job.startedAt = null; await saveJob(job); starting = false; return; }
  const args = ['--import', 'tsx', 'src/portal-cli.ts', '--portal', job.portal, '--permit', job.permit, '--out', job.dir, ...(DESKTOP ? ['--desktop'] : [])];
  const log = open(join(job.dir, 'server-log.txt'), 'w');
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  running = { job, child }; starting = false;
  child.on('error', () => { job.error = 'The capture worker could not start.'; });
  void log.then(h => { child.stdout?.on('data', d => { void h.write(d).catch(() => undefined); }); child.stderr?.on('data', d => { void h.write(d).catch(() => undefined); }); child.on('close', () => { void h.close().catch(() => undefined); }); }).catch(() => undefined);
  const timer = setTimeout(() => { job.error = 'Run exceeded ten minutes and was stopped.'; child.kill('SIGKILL'); }, JOB_TIMEOUT_MS);
  child.on('close', async code => {
    clearTimeout(timer); running = null; job.finishedAt = new Date().toISOString();
    if (code === 0) job.status = 'completed'; else { job.status = 'failed'; if (!job.error) { try { const tail = (await readFile(join(job.dir, 'server-log.txt'), 'utf8')).trim().split('\n').slice(-1)[0] ?? ''; job.error = 'The capture could not complete. The portal or an analysis service may be unavailable. Try again later. No portal changes were made.'; } catch { job.error = 'The run stopped.'; } } }
    await saveJob(job).catch(() => undefined); pump();
  });
}
function json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function html(res: ServerResponse, status: number, body: string) { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); res.end(body); }
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.ndjson': 'application/x-ndjson', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.gif': 'image/gif' };
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const c of req) { size += c.length; if (size > 10_000) throw new Error('Request too large'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }

const portals = (await listPortals(join(root, 'cases'))).sort((a, b) => (a.slug === 'pinecrest' ? -1 : b.slug === 'pinecrest' ? 1 : a.slug.localeCompare(b.slug)));
await mkdir(WEB, { recursive: true });
for (const key of LIVE ? ['SOLARI_API_KEY', 'AIML_API_KEY', 'AIML_MODEL'] : []) if (!process.env[key]?.trim()) throw new Error(`${key} is missing; the web demo needs live credentials`);
const server = createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  if (req.url?.startsWith('/healthz')) res.setHeader('access-control-allow-origin', 'https://dineshsai05.github.io');
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const ip = req.socket.remoteAddress ?? 'unknown'; // Never trust caller-supplied forwarding headers.
    if (req.method === 'GET' && path === '/') return html(res, 200, formPage(portals));
    if (req.method === 'GET' && path === '/healthz') {
      try { if (database) await database.ping(); } catch { return json(res, 503, { ok: false, live: false }); }
      return json(res, 200, { ok: true, live: LIVE, dailyLimit, running: running ? 1 : 0, queued: queue.length, storage: database ? 'postgresql' : 'filesystem' });
    }
    if (path === '/workspace' && req.method === 'GET' && database) return html(res, 200, adminPage(STYLE));
    if (path.startsWith('/api/admin/')) {
      if (!database) return json(res, 404, { error: 'Workspace requires PostgreSQL.' });
      if (!authorized(req)) return json(res, 401, { error: 'A valid workspace access key is required.' });
      if (path === '/api/admin/jobs' && req.method === 'GET') return json(res, 200, await database.listJobs());
      const tasks = /^\/api\/admin\/jobs\/([a-f0-9]{12})\/tasks$/.exec(path);
      const task = /^\/api\/admin\/tasks\/([a-f0-9]{24})(\/audit)?$/.exec(path);
      if (tasks) {
        if (!jobs.has(tasks[1]!)) return json(res, 404, { error: 'Capture not found' });
        if (req.method === 'GET') return json(res, 200, await database.listTasks(tasks[1]!));
        if (req.method === 'POST') { const { validateTask } = await import('./postgres-store.js'); return json(res, 201, await database.createTask(tasks[1]!, validateTask(await body(req)))); }
      }
      if (task && task[2] && req.method === 'GET') return json(res, 200, await database.audit(task[1]!));
      if (task && !task[2] && req.method === 'PATCH') {
        const value = await body(req); if (!Number.isInteger(value.version) || value.version < 1) return json(res, 400, { error: 'Task revision is required' });
        const { validateTask } = await import('./postgres-store.js');
        try { return json(res, 200, await database.updateTask(task[1]!, validateTask(value), value.version)); }
        catch (error) { if ((error as Error).message.includes('changed since')) return json(res, 409, { error: (error as Error).message }); throw error; }
      }
      return json(res, 404, { error: 'Workspace route not found' });
    }
    if (req.method === 'POST' && path === '/api/jobs') {
      if (stopping || !LIVE) return json(res, 503, { error: 'Live captures are paused. Explore the recorded example instead.' });
      // Read and validate before taking the admission lock. Recheck limits inside it.
      const r = parseJobRequest(await body(req), portals);
      return await exclusive(async () => {
      if (queue.length >= MAX_QUEUE) return json(res, 503, { error: 'The queue is full right now. Try again in a few minutes.' });
      try { if (!database) await budget.reserve(ip); } catch (error) { return json(res, 429, { error: (error as Error).message }); }
      const portalLabel = portals.find(p => p.slug === r.portal)?.authority ?? new URL(r.portal).hostname;
      const id = randomBytes(6).toString('hex');
      const slug = /^https:/.test(r.portal) ? `${slugify(new URL(r.portal).hostname)}-${slugify(r.permit)}` : (r.permit === portals.find(p => p.slug === r.portal)!.permitNumber ? r.portal : `${r.portal}-${slugify(r.permit)}`);
      const job: Job = { id, portal: r.portal, portalLabel, permit: r.permit, email: r.email, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, status: 'queued', dir: join(WEB, `${Date.now()}-${slug}-live`), error: null };
      await mkdir(job.dir, { recursive: true });
      if (database) {
        try { await database.enqueue(job, ip, dailyLimit, PER_IP_PER_HOUR, MAX_QUEUE); }
        catch (error) { const msg = (error as Error).message; return json(res, /allowance|queue is full/.test(msg) ? 429 : 503, { error: /allowance|queue is full/.test(msg) ? msg : 'Capture storage is unavailable. Try again later.' }); }
      }
      await saveJob(job);
      jobs.set(id, job); queue.push(job); pump();
      return json(res, 202, { id });
      });
    }
    const jobMatch = /^\/(api\/jobs|jobs|r)\/([a-f0-9]{12})(?:\/(.*))?$/.exec(path);
    if (req.method === 'GET' && jobMatch) {
      const [, kind, id, file] = jobMatch; const job = jobs.get(id!);
      if (!job) return kind === 'api/jobs' ? json(res, 404, { error: 'Unknown job' }) : html(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>PermitPilot</title>${STYLE}</head><body><main><h1>Unknown run</h1><p><a href="../">Start a new one</a></p></main></body></html>`);
      if (kind === 'api/jobs') return json(res, 200, { id, status: job.status, ahead: queue.indexOf(job), events: await readJobDir(job), error: job.error, permit: job.permit, portal: job.portalLabel });
      if (kind === 'jobs') return html(res, 200, jobPage(job));
      const name = file || 'report.html';
      if (name === 'snapshot.json' || name === 'replay.json') {
        try { const snapshot = JSON.parse(await readFile(join(job.dir, name), 'utf8')); snapshot.sessionId = null; return json(res, 200, snapshot); }
        catch { return json(res, 404, { error: 'Snapshot not ready' }); }
      }
      if (name === 'manifest.json') {
        try { const m = JSON.parse(await readFile(join(job.dir, name), 'utf8')); return json(res, 200, { mode: m.mode, status: m.status, permitNumber: m.permitNumber, startedAt: m.startedAt, provider: m.provider, model: m.model, replaySaved: m.replaySaved }); }
        catch { return json(res, 404, { error: 'Manifest not ready' }); }
      }
      if (!/^[a-z0-9._-]+$/i.test(name) || name.includes('..') || name === 'job.json' || name === 'server-log.txt' || name.startsWith('attachments')) return html(res, 404, 'Not found');
      const type = TYPES[extname(name).toLowerCase()]; const full = resolve(job.dir, name);
      if (!type || !/^(report\.html|snapshot\.json|documents\.json|analysis\.json|diff\.json|replay\.(json|ndjson)|tracker\.csv|portal-[a-z-]+\.png|desktop-tracker\.png)$/.test(name) || !full.startsWith(job.dir)) return html(res, 404, 'Not found');
      try { const s = await stat(full); res.writeHead(200, { 'content-type': type, 'content-length': s.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); createReadStream(full).pipe(res); return; } catch { return html(res, 404, 'Not found'); }
    }
    html(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>PermitPilot</title>${STYLE}</head><body><main><h1>Not found</h1><p><a href="/">Home</a></p></main></body></html>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    if (!res.headersSent) json(res, 400, { error: message.replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 300) });
  }
});
server.requestTimeout = 15_000; server.headersTimeout = 10_000;
server.listen(PORT, () => { console.log(`PermitPilot web demo on http://localhost:${(server.address() as import('node:net').AddressInfo).port} (desktop step ${DESKTOP ? 'on' : 'off'})`); if (LIVE) void pump(); });

function shutdown() {
  if (stopping) return; stopping = true;
  server.close(); running?.child.kill('SIGTERM');
  setTimeout(() => {
    running?.child.kill('SIGKILL');
    if (database) void database.close().finally(() => process.exit(0)); else process.exit(0);
  }, 2000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
