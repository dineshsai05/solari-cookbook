import { freshState, restoreState, updateTask, addRecord, summary, trackerCsv, handoff, responseDraft } from './workflow-state.js';
const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const link = (text, href) => { const a = node('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
const button = (text, fn, cls = 'button secondary') => { const b = node('button', text, cls); b.type = 'button'; b.onclick = fn; return b; };
const p = (text, cls) => node('p', text, cls);
const card = (title, text) => { const c = node('article', undefined, 'work-card'); c.append(node('h3', title), p(text)); return c; };
function field(label, value = '', type = 'text') { const l = node('label', label); const i = node(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') i.type = type; i.value = value; l.append(i); return [l, i]; }
function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type })); const a = link(name, url); a.download = name; a.removeAttribute('target'); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
const KEY = 'permitpilot-workflow-demo-v1';
let data, state, stage = 'project', selected = 'FD-01', prepVariant = 'incomplete';
const stages = [['project', '1 · Project brief'], ['prepare', '2 · Prepare'], ['package', '3 · Package'], ['track', '4 · Track'], ['respond', '5 · Respond'], ['proof', 'Working preparation run']];
function evidence(items) {
  const details = node('details'); details.append(node('summary', `Source evidence (${items.length})`));
  for (const e of items) { const file = data.files.find(f => f.id === e.documentId); const quote = node('blockquote', e.quote); quote.append(node('br'), link(`${e.documentId} · PDF page ${e.page}`, `${file.url}#page=${e.page}`)); details.append(quote); }
  return details;
}
function save(message) { try { localStorage.setItem(KEY, JSON.stringify(state)); $('save-status').textContent = message + ' Saved in this browser only.'; } catch { $('save-status').textContent = message + ' Browser storage is unavailable; export before closing this page.'; } renderSummary(); }
function renderSummary() {
  const s = summary(data, state); $('summary').replaceChildren();
  for (const [value, label] of [[s.total, 'selected requirements'], [s.assigned, 'assigned by you'], [s.recorded, 'with team evidence notes'], ['Unknown', 'building permit status']]) { const c = node('div'); c.append(node('b', value), node('span', label)); $('summary').append(c); }
}
function go(next, scroll = true) { stage = next; location.hash = next; render(); if (scroll) $('steps').scrollIntoView({ behavior: 'auto', block: 'start' }); }
function intro(title, text) { const c = $('content'); c.append(node('h2', title), p(text, 'muted')); return c; }
function nextStep(target, text) { const c = node('div', undefined, 'next-step'); c.append(button(text, () => go(target), 'button primary')); $('content').append(c); }
function project() {
  const c = intro('Start with the job—not a permit number.', 'A coordinator preparing the next applications needs to know which earlier conditions affect the package, who owns them, and where the supporting records are.');
  const cols = node('div', undefined, 'two-column');
  const brief = card('The project brief', data.overview.summary); brief.append(evidence(data.overview.evidence), link('Official Woodburn project page ↗', data.projectPage));
  const job = card('Your job in this demonstration', 'Build a coordinator handoff for the subsequent demolition, grading and building-permit work. The selected planning records provide dependencies; they are not the complete checklist for those applications.');
  const list = node('ol', undefined, 'checklist'); for (const text of ['Find the utility demolition plan requirement and assign it.', 'Record a document reference or leave it clearly outstanding.', 'Export the package index and team tracker.', 'Follow the historical application milestones and draft the next evidence request.']) list.append(node('li', text)); job.append(list); cols.append(brief, job); c.append(cols);
  c.append(p('Scenario boundary: this is a planning exercise based on a historical public packet. We have not verified the project’s current construction or permit status.', 'notice'));
  const block = card('Before PermitPilot', 'The coordinator reads several letters and decisions, copies requirements into a spreadsheet, asks consultants for documents, and checks which version was used.'); block.append(p('In this workspace, each selected condition already has its source attached. You turn it into assigned work, keep internal targets separate from city deadlines, and carry the evidence into a handoff.')); c.append(block);
  nextStep('prepare', 'Prepare the document checklist →');
}
function prepare() {
  const c = intro('Turn requirements into work someone owns.', 'Choose a requirement, assign an owner, and record a document reference. Suggested roles are illustrative. “Evidence recorded” is a team note; authority fulfillment remains unknown.');
  c.append(p('Try FD-01: assign “Demo civil engineer,” set an internal target, and note which utility demolition plan needs to be prepared. Save it as “In progress.”', 'demo-callout'));
  const board = node('div', undefined, 'task-board'), list = node('div', undefined, 'task-list'), editor = node('div');
  list.setAttribute('aria-label', 'Requirements');
  for (const t of data.tasks) { const v = state.tasks[t.id]; const b = button('', () => { selected = t.id; render(); }, ''); b.setAttribute('aria-pressed', String(t.id === selected)); b.append(node('strong', `${t.id} · ${t.title}`), node('small', `${t.group} · ${v.owner || 'Unassigned'} · ${v.status.replaceAll('_', ' ')}`)); list.append(b); }
  const t = data.tasks.find(t => t.id === selected), value = state.tasks[t.id];
  editor.append(node('span', t.group, 'status-label'), node('h3', t.title), p(t.action), p(`Recorded timing: ${t.timing}`), evidence(t.evidence));
  const form = node('form'); const [ol, owner] = field('Owner / team (demo)', value.owner); owner.maxLength = 120; owner.placeholder = t.suggestedOwner;
  const [dl, due] = field('Internal target date—not an authority deadline', value.due, 'date');
  const sl = node('label', 'Team work state'), status = node('select'); for (const [key, label] of [['not_started', 'Not started'], ['in_progress', 'In progress'], ['evidence_recorded', 'Evidence recorded — verify separately']]) { const o = node('option', label); o.value = key; status.append(o); } status.value = value.status; sl.append(status);
  const [nl, notes] = field('Evidence reference / work still needed', value.notes, 'textarea'); notes.maxLength = 2000; notes.placeholder = 'Document name, revision, page, and what was checked. Use demo notes only.';
  const error = p('', 'error'); error.setAttribute('role', 'status'); const submit = node('button', 'Save task', 'button primary'); submit.type = 'submit';
  form.append(ol, dl, sl, nl, p('No confidential information. This shared demo does not upload or validate the document you reference.', 'fine'), error, submit);
  form.onsubmit = e => { e.preventDefault(); try { state = updateTask(state, t.id, { owner: owner.value, due: due.value, status: status.value, notes: notes.value }); save(t.id + ' updated.'); render(); } catch (x) { error.textContent = x.message; } }; editor.append(form); board.append(list, editor); c.append(board);
  nextStep('package', 'Check the handoff package →');
}
function packageView() {
  const c = intro('A useful handoff, with the gaps still visible.', 'This package connects the project brief, selected requirements, team assignments and evidence notes. It is not a completed Farmdale permit application.');
  const s = summary(data, state); c.append(p(`${s.recorded} of ${s.total} selected requirements have team evidence notes. Submission readiness: not established.`, 'notice'));
  const table = node('table'), head = node('tr'); for (const title of ['Document in the public packet', 'Pages', 'What has been processed']) head.append(node('th', title)); const thead = node('thead'); thead.append(head); table.append(thead); const body = node('tbody');
  for (const f of data.files) { const row = node('tr'), name = node('td'); name.append(link(f.id.replaceAll('-', ' '), f.url)); row.append(name, node('td', f.pages), node('td', f.analyze ? 'Readable text extracted; source-linked interpretation' : 'Indexed only; drawings have not been checked')); body.append(row); } table.append(body); const wrap = node('div', undefined, 'table-wrap'); wrap.append(table); c.append(wrap);
  const gaps = card('Still required before any submission', 'Obtain the full applicable municipal checklist and original June decision; verify the current form, parcel, designs, signatures, fees and relevant conditions with the responsible professionals. The selected register does not establish that every requirement is covered.'); c.append(gaps);
  const actions = node('div', undefined, 'action-row'); actions.append(button('Download handoff JSON', () => download('farmdale-demo-handoff.json', JSON.stringify(handoff(data, state), null, 2), 'application/json')), button('Download team tracker CSV', () => download('farmdale-demo-tracker.csv', trackerCsv(data, state), 'text/csv')), button('See an actual generated application', () => go('proof'))); c.append(actions);
  c.append(p('The download is assembled from your current demo edits. No signatures are added, no fees are paid, and no government portal is changed.', 'fine')); nextStep('track', 'Track the application and its requests →');
}
function track() {
  const c = intro('Track receipt, completeness and decisions separately.', 'These milestones belong to Farmdale’s recorded modification-of-conditions case. They do not establish approval of a later building-permit application. Past notice dates are historical, not current overdue alerts.');
  c.append(p(data.authorityStatus, 'notice'));
  const cols = node('div', undefined, 'two-column'), history = node('div'), manual = node('div');
  history.append(node('h3', 'Recorded authority history'));
  for (const t of [...data.timeline].sort((a, b) => a.date.localeCompare(b.date))) { const item = node('article', undefined, 'timeline-item'); item.append(node('time', t.date), node('h3', t.title), p(t.detail), evidence(t.evidence)); history.append(item); }
  const box = card('Record a receipt or status observation', 'Practice logging a subsequent application. This is a manual demo note, not a portal lookup or proof of submission.');
  const form = node('form'); const [rl, reference] = field('Application reference (demo)'); reference.placeholder = 'DEMO-DEMO-001'; reference.required = true; reference.maxLength = 120;
  const [sl, status] = field('Observed status'); status.placeholder = 'e.g. Demo receipt received'; status.required = true; status.maxLength = 120;
  const [dl, observed] = field('Observation date', '', 'date'); observed.required = true;
  const [nl, source] = field('Receipt or source reference (demo)', '', 'textarea'); source.required = true; source.minLength = 10; source.maxLength = 1500;
  const error = p('', 'error'); error.setAttribute('role', 'status'); const submit = node('button', 'Save manual observation', 'button primary'); submit.type = 'submit'; form.append(rl, sl, dl, nl, error, submit);
  form.onsubmit = e => { e.preventDefault(); try { state = addRecord(state, { reference: reference.value, status: status.value, observed: observed.value, source: source.value }); save('Manual demo observation recorded.'); render(); } catch (x) { error.textContent = x.message; } }; box.append(form); manual.append(box);
  for (const r of state.records) { const entry = card(`${r.reference} · ${r.status}`, r.source); entry.prepend(node('span', `Manual demo note · ${r.observed}`, 'status-label warn')); manual.append(entry); }
  const live = card('Try an actual portal capture separately', 'The live Pinecrest and Atherton examples fetch public records and compare them with the previous successful capture. Farmdale’s Woodburn application is not connected to that adapter.'); live.append(link('Open live portal capture ↗', 'try.html#live')); manual.append(live); cols.append(history, manual); c.append(cols); nextStep('respond', 'Handle a request and prepare the next action →');
}
function respond() {
  const c = intro('Keep the request, decision and team response together.', 'A coordinator must carry a changed condition into the next plan set and supporting documents. A requested change is not automatically an accepted change.');
  for (const change of data.changes) { const item = card(change.topic, ''); const cols = node('div', undefined, 'two-column'); cols.append(card('Applicant requested', change.requested), card('Authority recorded', change.decided)); item.append(cols, evidence(change.evidence)); c.append(item); }
  for (const q of data.questions) { const item = card(q.title, q.detail); item.append(evidence(q.evidence)); c.append(item); }
  const action = node('div', undefined, 'action-row'); action.append(button('Assign the corridor follow-up', () => { selected = 'FD-06'; go('prepare'); }), button('Draft an internal evidence request', () => { output.value = responseDraft(data, state); output.hidden = false; exportButton.hidden = false; output.focus(); }, 'button primary')); c.append(action);
  c.append(p('The draft uses the actual selected conditions and your current task notes. It asks for evidence and makes no claim that work is complete. It is generated locally from a template; it is not an AI call or a sent message.', 'fine'));
  const output = node('textarea', undefined, 'text-output'); output.readOnly = true; output.hidden = true; output.setAttribute('aria-label', 'Internal evidence request draft'); const exportButton = button('Download this draft', () => download('farmdale-demo-evidence-request.txt', output.value, 'text/plain')); exportButton.hidden = true; c.append(output, exportButton);
  const audit = node('details'); audit.append(node('summary', `Your demo activity (${state.audit.length})`)); for (const a of [...state.audit].reverse()) audit.append(p(`${a.at} · ${a.action}`, 'fine')); c.append(audit); nextStep('proof', 'See the pre-submission document pipeline →');
}
function proof() {
  const c = intro('Before a permit exists: inspect the plans and draft the application.', 'A Portland contractor is preparing an attached residential deck application. This narrow example runs the original preparation pipeline: official requirements → PDF checks → unsigned application. The project and drawings are synthetic; the city guidance, form and recorded processing are real.');
  c.append(p('Try the original packet, then the revised packet. Compare the missing site drawing, conflicting address and mixed sheet sizes. The contractor license and professional scope review stay unresolved.', 'demo-callout'));
  const controls = node('div', undefined, 'revision-controls'); for (const [id, label] of [['incomplete', '1 · Original packet'], ['corrected', '2 · Revised packet']]) { const b = button(label, () => { prepVariant = id; render(); }); b.setAttribute('aria-pressed', String(id === prepVariant)); controls.append(b); } c.append(controls);
  const run = data.preparation.find(r => r.variant === prepVariant); c.append(p(run.label, 'status-label'), p('This panel replays saved results. Switching packets does not start a new Solari or model run.', 'fine'));
  const actions = node('div', undefined, 'proof-links'); actions.append(link('Input sample plans ↗', run.base + '/inputs/document-1.pdf'), link('Unsigned application PDF ↗', run.base + '/draft-application.pdf'), link('Full readiness report ↗', run.base + '/report.html'), link('Run manifest ↗', run.base + '/manifest.json')); c.append(actions);
  const findings = node('div', undefined, 'findings');
  for (const f of run.result.findings) { const item = node('article', undefined, 'finding ' + f.status); item.append(node('span', f.status.replaceAll('_', ' '), 'status-label' + (f.status === 'evidence_found' ? '' : ' warn')), node('h3', f.title), p(f.explanation)); if (f.evidence.length) { const details = node('details'); details.append(node('summary', 'Plan evidence')); for (const e of f.evidence) { const q = node('blockquote', e.quote); q.append(node('br'), link(`Input page ${e.page}`, `${run.base}/inputs/${e.documentId}.pdf#page=${e.page}`)); details.append(q); } item.append(details); } const source = run.sources.find(s => s.id === f.sourceId); if (source) item.append(link('Official requirement ↗', source.url)); findings.append(item); } c.append(findings);
  c.append(p('Evidence found means readable text was located. It does not verify structural design, establish the right jurisdiction for an address, or make this packet submission-ready. Both example drafts remain unsigned and marked “Do not submit.”', 'notice'));
  const events = node('details'); events.append(node('summary', 'Recorded processing trail')); for (const e of run.events) events.append(p(`${e.at} · ${e.name.replaceAll('_', ' ')}`, 'fine')); c.append(events); nextStep('project', 'Return to the project workflow →');
}
function render() {
  $('steps').replaceChildren(); for (const [key, label] of stages) { const b = button(label, () => go(key), ''); if (key === stage) b.setAttribute('aria-current', 'step'); $('steps').append(b); }
  $('content').replaceChildren(); ({ project, prepare, package: packageView, track, respond, proof })[stage]();
}
try {
  const response = await fetch('workflow-data.json'); if (!response.ok) throw new Error('Demo evidence could not be loaded.'); data = await response.json();
  let saved; try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* no usable local state */ } state = restoreState(data, saved);
  const requested = location.hash.slice(1); if (stages.some(([key]) => key === requested)) stage = requested;
  renderSummary(); render(); $('save-status').textContent = 'Demo edits stay in this browser. Nothing is sent to the project owner or authority.';
  $('start-tour').onclick = () => go('project'); $('open-preparation').onclick = () => go('proof');
  $('reset').onclick = () => { if (!confirm('Reset only your local demonstration assignments, observations and history?')) return; state = freshState(data); save('Demo edits reset.'); render(); };
  window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (stages.some(([key]) => key === next) && next !== stage) { stage = next; render(); } });
} catch (error) { $('save-status').textContent = error.message; $('content').append(p('Please reload. The recorded reports remain available from the main demo.', 'error')); }
