// The public workspace is a local demonstration. Authority facts stay immutable.
export const VERSION = 1;
export const TASK_STATES = ['not_started', 'in_progress', 'evidence_recorded'];
export function freshState(data) {
  return { version: VERSION, demo: true, tasks: Object.fromEntries(data.tasks.map(t => [t.id, { owner: '', due: '', status: 'not_started', notes: '' }])), records: [], audit: [] };
}
export function restoreState(data, saved) {
  const state = freshState(data);
  if (!saved || saved.version !== VERSION || saved.demo !== true) return state;
  for (const t of data.tasks) {
    try { state.tasks[t.id] = validateTask(saved.tasks?.[t.id]); } catch { /* discard malformed local edits */ }
  }
  state.records = Array.isArray(saved.records) ? saved.records.slice(-50).flatMap(r => { try { return [validateRecord(r)]; } catch { return []; } }) : [];
  state.audit = Array.isArray(saved.audit) ? saved.audit.slice(-200).filter(a => a && typeof a.at === 'string' && typeof a.action === 'string').map(a => ({ at: a.at.slice(0, 40), action: a.action.slice(0, 500) })) : [];
  return state;
}
export function validateTask(value) {
  if (!value || !TASK_STATES.includes(value.status)) throw new Error('Choose a task state.');
  const task = { owner: String(value.owner ?? '').trim().slice(0, 120), due: String(value.due ?? ''), status: value.status, notes: String(value.notes ?? '').trim().slice(0, 2000) };
  if (task.due && !/^\d{4}-\d{2}-\d{2}$/.test(task.due)) throw new Error('Choose a valid internal target date.');
  if (task.status === 'evidence_recorded' && task.notes.length < 10) throw new Error('Record the document reference and what it establishes before marking evidence recorded.');
  return task;
}
export function validateRecord(value) {
  const record = { reference: String(value?.reference ?? '').trim().slice(0, 120), status: String(value?.status ?? '').trim().slice(0, 120), source: String(value?.source ?? '').trim().slice(0, 1500), observed: String(value?.observed ?? '') };
  if (!record.reference || !record.status || record.source.length < 10 || !/^\d{4}-\d{2}-\d{2}$/.test(record.observed)) throw new Error('Add a reference, status, observation date and a supporting receipt or source note.');
  return record;
}
export function updateTask(state, id, value, now = new Date().toISOString()) {
  if (!Object.hasOwn(state.tasks, id)) throw new Error('Unknown task.');
  const next = structuredClone(state); next.tasks[id] = validateTask(value);
  next.audit.push({ at: now, action: `${id}: ${next.tasks[id].status}; owner ${next.tasks[id].owner || 'unassigned'}; internal target ${next.tasks[id].due || 'unset'}. ${next.tasks[id].notes}` });
  next.audit = next.audit.slice(-200); return next;
}
export function addRecord(state, value, now = new Date().toISOString()) {
  const next = structuredClone(state), record = validateRecord(value);
  if (next.records.length >= 50) throw new Error('This demo supports up to 50 manual observations. Export and reset to start again.');
  next.records.push(record); next.audit.push({ at: now, action: `Manual demo observation: ${record.reference} — ${record.status}.` }); next.audit = next.audit.slice(-200); return next;
}
export function summary(data, state) {
  const values = data.tasks.map(t => state.tasks[t.id]);
  return { total: values.length, recorded: values.filter(t => t.status === 'evidence_recorded').length, assigned: values.filter(t => t.owner).length, inProgress: values.filter(t => t.status === 'in_progress').length, authorityStatus: data.authorityStatus, submissionReady: false };
}
const csvCell = value => { let s = String(value ?? ''); if (/^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
export function trackerCsv(data, state) {
  const rows = [['demo_only', 'project', 'requirement', 'recorded_timing', 'coordinator_owner', 'internal_target', 'team_state', 'evidence_notes', 'authority_fulfillment', 'source']];
  for (const t of data.tasks) { const v = state.tasks[t.id]; rows.push(['true', data.name, t.title, t.timing, v.owner, v.due, v.status, v.notes, 'unknown', t.evidence.map(e => `${data.files.find(f => f.id === e.documentId).url}#page=${e.page}`).join(' | ')]); }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function handoff(data, state) {
  return { demo: true, generatedAt: new Date().toISOString(), project: data.name, location: data.location, purpose: 'Coordinator handoff draft; not a permit application or submission', authorityStatus: data.authorityStatus, submissionReady: false, coverage: data.coverage, tasks: data.tasks.map(t => ({ ...t, team: state.tasks[t.id], authorityFulfillment: 'unknown' })), manualObservations: state.records, audit: state.audit };
}
export function responseDraft(data, state) {
  return ['DEMONSTRATION — INTERNAL COORDINATION DRAFT — NOT SENT', `Project: ${data.name} | ${data.location}`, 'Purpose: Request the outstanding evidence before preparing subsequent permit applications.', '', ...data.tasks.filter(t => state.tasks[t.id].status !== 'evidence_recorded').flatMap(t => [`${t.title}`, `Requested action: ${t.action}`, `Assigned internally: ${state.tasks[t.id].owner || 'Unassigned'}`, `Recorded condition timing: ${t.timing}`, `Internal target: ${state.tasks[t.id].due || 'Not set'}`, `Notes: ${state.tasks[t.id].notes || 'No evidence reference recorded.'}`, `Source: ${data.files.find(f => f.id === t.evidence[0].documentId).url}#page=${t.evidence[0].page}`, '']), 'Recorded team evidence is not authority acceptance. Confirm the complete municipal checklist, designs, application forms, signatures and current case status before submission.'].join('\n');
}
