import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from 'dotenv';
import { listPortals, PERMIT_NUMBER, slugify } from './portal-cases.js';

// A small web front end for the portal adapter. A visitor picks a portal,
// types a permit number, and the server runs one bounded CLI job for it and
// serves the resulting report. One job at a time; nothing is submitted to
// any portal; API keys stay in this process and its child.

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: join(root, '.env'), quiet: true });
const PORT = Number(process.env.PORT || 8080);
const WEB = join(root, 'artifacts', 'web');
const MAX_QUEUE = 8, PER_IP_PER_HOUR = 5, JOB_TIMEOUT_MS = 10 * 60_000;
const DESKTOP = process.env.PERMITPILOT_WEB_DESKTOP === '1';
const CONTACT = process.env.PERMITPILOT_CONTACT || '';

interface Job { id: string; portal: string; portalLabel: string; permit: string; email: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; status: 'queued' | 'running' | 'completed' | 'failed'; dir: string; error: string | null }
const jobs = new Map<string, Job>(); const queue: Job[] = []; let running: { job: Job; child: ChildProcess } | null = null;
const ipLog = new Map<string, number[]>();

export interface JobRequest { portal: string; permit: string; email: string | null }
/** Validates a request body against the known portals. Pure: exported for tests. */
export function parseJobRequest(body: unknown, portals: { slug: string }[]): JobRequest {
  if (!body || typeof body !== 'object') throw new Error('Send a JSON object');
  const b = body as Record<string, unknown>;
  const permit = String(b.permit ?? '').trim();
  if (!PERMIT_NUMBER.test(permit)) throw new Error('Permit numbers are 2 to 25 letters, digits, dots or dashes, like BL2024-1706');
  let portal = String(b.portal ?? '').trim();
  if (portal === 'other') {
    const origin = String(b.origin ?? '').trim();
    let url: URL; try { url = new URL(origin); } catch { throw new Error('Enter the portal address, like https://pine-trk.aspgov.com'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Portal address must be https:// with no credentials');
    portal = url.origin;
  } else if (!portals.some(p => p.slug === portal)) throw new Error('Pick a portal');
  const email = String(b.email ?? '').trim();
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) throw new Error('That email address does not look right');
  return { portal, permit, email: email || null };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const STYLE = `<style>[hidden]{display:none!important}:root{--bg:#f4f5f0;--ink:#20312e;--muted:#52645e;--rule:#d7dfd8;--card:#fff;--accent:#197967;--accent-ink:#0f5a4c;--warn:#fff1cc;color-scheme:light}@media(prefers-color-scheme:dark){:root{--bg:#15201d;--ink:#e6ece8;--muted:#a3b3ad;--rule:#2d3d38;--card:#1c2925;--accent:#5fbfa9;--accent-ink:#8fd6c5;--warn:#3d3410;color-scheme:dark}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif;padding:36px 20px}main{max-width:760px;margin:0 auto;display:grid;gap:26px}h1{font-size:clamp(28px,5vw,40px);line-height:1.1;margin:0;text-wrap:balance}h2{font-size:22px;margin:0}p{margin:0}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:12px;color:var(--muted);font-weight:600}a{color:var(--accent-ink)}.muted{color:var(--muted)}form,.card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:22px;display:grid;gap:14px}label{display:grid;gap:6px;font-weight:600}input,select{font:inherit;padding:10px 12px;border:1px solid var(--rule);border-radius:6px;background:var(--bg);color:var(--ink);width:100%}button{font:inherit;font-weight:600;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:12px 18px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent-ink);outline-offset:2px}.err{color:#8a2f2f;font-weight:600}.notice{background:var(--warn);border-radius:10px;padding:14px 18px}ol.steps{margin:0;padding-left:20px;display:grid;gap:6px}.step{display:flex;gap:10px;align-items:baseline}.step .dot{width:10px;height:10px;border-radius:50%;background:var(--rule);flex:none}.step.done .dot{background:var(--accent)}.step.now .dot{background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 30%,transparent)}small{color:var(--muted)}ul{margin:0;padding-left:20px}</style>`;

function formPage(portals: { slug: string; authority: string; permitNumber: string }[]) {
  const options = portals.map(p => `<option value="${esc(p.slug)}">${esc(p.authority)}</option>`).join('') + '<option value="other">Another eTRAKiT portal (enter its address)</option>';
  const examples = portals.map(p => `<li>${esc(p.authority)}: try <code>${esc(p.permitNumber)}</code></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PermitPilot</title>${STYLE}</head><body><main>
<header style="display:grid;gap:12px"><span class="eyebrow">PermitPilot · live demo</span><h1>Type a permit number. Get back what the city's portal says about it, with every reviewer comment linked to its source.</h1><p class="muted">A Solari cloud browser searches the public permit portal, opens every departmental review and the reviewer's comment page, lists attachments with the portal's own labels, downloads the applicant's response and drawing revisions, and links each comment to what the applicant said about it. Takes about one to two minutes.</p></header>
<form id="f"><label>Portal<select id="portal" name="portal">${options}</select></label><label id="originRow" hidden>Portal address<input id="origin" name="origin" placeholder="https://pine-trk.aspgov.com" autocomplete="off"></label><label>Permit number<input id="permit" name="permit" placeholder="BL2024-1706" required autocomplete="off" maxlength="25"></label><label>Your email <small style="font-weight:400">(optional, only so I can ask what you thought)</small><input id="email" name="email" type="email" placeholder="you@company.com" autocomplete="email"></label><button id="go" type="submit">Run it</button><p id="err" class="err" hidden></p><small>Public records only. The tool never logs in, submits, pays, or changes anything on the portal; the only form it fills is the public search box. Reports are kept on this server so you can share the link.</small></form>
<section class="card"><h2>Try a known permit first</h2><ul>${examples}</ul><p class="muted">Portals verified so far: Village of Pinecrest, FL and Town of Atherton, CA. Other CentralSquare eTRAKiT cities usually work; if the page layout differs the run stops and says so.</p></section>
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
<section class="card"><h2>Progress</h2><div id="steps" style="display:grid;gap:8px"></div><p id="done" hidden><a id="link" href="#"><b>Open the report</b></a> · <a id="csv" href="#">tracker.csv</a> · <a id="snap" href="#">snapshot.json</a></p><p id="fail" class="err" hidden></p></section>
<p class="muted"><a href="../">Run another permit</a></p></main><script>
const id=${JSON.stringify(job.id)};const labels=${JSON.stringify(STEP_LABELS)};const q=location.search;
async function tick(){const r=await fetch('../api/jobs/'+id+q);const j=await r.json();document.getElementById('state').textContent=j.status==='queued'?'Queued behind '+j.ahead+' other run'+(j.ahead===1?'':'s')+'.':j.status==='running'?'Running on Solari. Usually one to two minutes.':j.status==='completed'?'Done.':'Failed.';
const steps=document.getElementById('steps');steps.innerHTML=j.events.map((e,i)=>'<div class="step '+(j.status==='running'&&i===j.events.length-1?'now':'done')+'"><span class="dot"></span><span>'+(labels[e]||e)+'</span></div>').join('');
if(j.status==='completed'){document.getElementById('link').href='../r/'+id+'/report.html'+q;document.getElementById('csv').href='../r/'+id+'/tracker.csv'+q;document.getElementById('snap').href='../r/'+id+'/snapshot.json'+q;document.getElementById('done').hidden=false;return;}
if(j.status==='failed'){const f=document.getElementById('fail');f.textContent=j.error||'The run stopped. Nothing was changed on the portal.';f.hidden=false;return;}
setTimeout(tick,2500);}
tick();</script></body></html>`;
}

async function readJobDir(job: Job) {
  let events: string[] = [];
  try { events = (await readFile(join(job.dir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l).name).filter((n: string) => n in STEP_LABELS); } catch { /* not started */ }
  return events;
}
function saveJob(job: Job) { return writeFile(join(job.dir, 'job.json'), JSON.stringify(job, null, 2)); }
function pump() {
  if (running || !queue.length) return;
  const job = queue.shift()!; job.status = 'running'; job.startedAt = new Date().toISOString();
  const args = ['--import', 'tsx', 'src/portal-cli.ts', '--portal', job.portal, '--permit', job.permit, '--out', job.dir, ...(DESKTOP ? ['--desktop'] : [])];
  const log = open(join(job.dir, 'server-log.txt'), 'w');
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  running = { job, child };
  void log.then(h => { child.stdout?.on('data', d => h.write(d)); child.stderr?.on('data', d => h.write(d)); child.on('close', () => h.close()); });
  const timer = setTimeout(() => { job.error = 'Run exceeded ten minutes and was stopped.'; child.kill('SIGKILL'); }, JOB_TIMEOUT_MS);
  child.on('close', async code => {
    clearTimeout(timer); running = null; job.finishedAt = new Date().toISOString();
    if (code === 0) job.status = 'completed'; else { job.status = 'failed'; if (!job.error) { try { const tail = (await readFile(join(job.dir, 'server-log.txt'), 'utf8')).trim().split('\n').slice(-1)[0] ?? ''; job.error = tail.replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 300) || 'The run stopped.'; } catch { job.error = 'The run stopped.'; } } }
    await saveJob(job).catch(() => undefined); pump();
  });
  void saveJob(job);
}
function json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function html(res: ServerResponse, status: number, body: string) { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); res.end(body); }
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.gif': 'image/gif' };
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const c of req) { size += c.length; if (size > 10_000) throw new Error('Request too large'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }

const portals = (await listPortals(join(root, 'cases'))).sort((a, b) => (a.slug === 'pinecrest' ? -1 : b.slug === 'pinecrest' ? 1 : a.slug.localeCompare(b.slug)));
await mkdir(WEB, { recursive: true });
for (const key of ['SOLARI_API_KEY', 'AIML_API_KEY', 'AIML_MODEL']) if (!process.env[key]?.trim()) throw new Error(`${key} is missing; the web demo needs live credentials`);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]!.trim();
    if (req.method === 'GET' && path === '/') return html(res, 200, formPage(portals));
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, running: running ? 1 : 0, queued: queue.length });
    if (req.method === 'POST' && path === '/api/jobs') {
      const now = Date.now(); const recent = (ipLog.get(ip) ?? []).filter(t => now - t < 3_600_000);
      if (recent.length >= PER_IP_PER_HOUR) return json(res, 429, { error: 'That is a few runs in an hour from one place. Try again a little later.' });
      if (queue.length >= MAX_QUEUE) return json(res, 503, { error: 'The queue is full right now. Try again in a few minutes.' });
      const r = parseJobRequest(await body(req), portals);
      const portalLabel = portals.find(p => p.slug === r.portal)?.authority ?? new URL(r.portal).hostname;
      const id = randomBytes(6).toString('hex');
      const slug = /^https:/.test(r.portal) ? `${slugify(new URL(r.portal).hostname)}-${slugify(r.permit)}` : (r.permit === portals.find(p => p.slug === r.portal)!.permitNumber ? r.portal : `${r.portal}-${slugify(r.permit)}`);
      const job: Job = { id, portal: r.portal, portalLabel, permit: r.permit, email: r.email, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, status: 'queued', dir: join(WEB, `${Date.now()}-${slug}-live`), error: null };
      await mkdir(job.dir, { recursive: true }); await saveJob(job);
      jobs.set(id, job); queue.push(job); ipLog.set(ip, [...recent, now]); pump();
      return json(res, 202, { id });
    }
    const jobMatch = /^\/(api\/jobs|jobs|r)\/([a-f0-9]{12})(?:\/(.*))?$/.exec(path);
    if (req.method === 'GET' && jobMatch) {
      const [, kind, id, file] = jobMatch; const job = jobs.get(id!);
      if (!job) return kind === 'api/jobs' ? json(res, 404, { error: 'Unknown job' }) : html(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>PermitPilot</title>${STYLE}</head><body><main><h1>Unknown run</h1><p><a href="../">Start a new one</a></p></main></body></html>`);
      if (kind === 'api/jobs') return json(res, 200, { id, status: job.status, ahead: queue.indexOf(job), events: await readJobDir(job), error: job.error, permit: job.permit, portal: job.portalLabel });
      if (kind === 'jobs') return html(res, 200, jobPage(job));
      const name = file || 'report.html';
      if (!/^[a-z0-9._-]+$/i.test(name) || name.includes('..') || name === 'job.json' || name === 'server-log.txt' || name.startsWith('attachments')) return html(res, 404, 'Not found');
      const type = TYPES[extname(name).toLowerCase()]; const full = resolve(job.dir, name);
      if (!type || !full.startsWith(job.dir)) return html(res, 404, 'Not found');
      try { const s = await stat(full); res.writeHead(200, { 'content-type': type, 'content-length': s.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); createReadStream(full).pipe(res); return; } catch { return html(res, 404, 'Not found'); }
    }
    html(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>PermitPilot</title>${STYLE}</head><body><main><h1>Not found</h1><p><a href="/">Home</a></p></main></body></html>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    if (!res.headersSent) json(res, 400, { error: message.replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 300) });
  }
});
server.listen(PORT, () => console.log(`PermitPilot web demo on http://localhost:${PORT} (desktop step ${DESKTOP ? 'on' : 'off'})`));
