import { z } from 'zod';

// A portal snapshot is what the browser observed at one moment, nothing more.
// Dates keep the portal's own M/D/YYYY strings; `iso` conversions exist only
// for ordering and replay filtering.
const text = z.string().max(4000).nullable();
export const ReviewSchema = z.object({
  recordId: z.string().min(1).max(80),
  type: z.string().max(80), reviewer: z.string().max(120), status: z.string().max(60),
  submitted: text, completed: text, dueDate: text,
  group: text, remarks: text, notes: z.string().max(20000),
  detailUrl: z.string().url(), sha256: z.string().length(64),
});
export const AttachmentSchema = z.object({
  key: z.string().min(1).max(80), label: z.string().max(200), name: z.string().max(200), url: z.string().url(),
  void: z.boolean(), keyTimestampHint: z.string().nullable(),
  downloaded: z.object({ id: z.string(), role: z.string(), sha256: z.string().length(64), bytes: z.number().int(), matchesPinned: z.boolean() }).nullable(),
});
export const SnapshotSchema = z.object({
  version: z.literal(1), capturedAt: z.string(), permitNumber: z.string(), portalUrl: z.string().url(), sessionId: z.string().nullable(),
  permit: z.object({ type: text, subtype: text, description: text, status: text, siteAddress: text, appliedDate: text, approvedDate: text, issuedDate: text, finaledDate: text, expirationDate: text }),
  reviews: z.array(ReviewSchema).max(200),
  attachments: z.array(AttachmentSchema).max(500),
  replay: z.object({ asOf: z.string(), from: z.string() }).nullable(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Portal dates look like 1/8/2025. Returns YYYY-MM-DD or null when unparseable. */
export function toIso(value: string | null | undefined): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(value ?? '');
  if (!m) return null;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** eTRAKiT attachment keys embed an upload timestamp: ECON:250428073641504 → 2025-04-28T07:36:41. This is a hint read from the key, not a portal-labelled date. */
export function parseAttachmentKey(key: string): { prefix: string; hint: string | null } {
  const m = /^([A-Z]+):(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d*$/.exec(key);
  if (!m) return { prefix: key.split(':')[0] ?? key, hint: null };
  const [, prefix, yy, mo, dd, hh, mi, ss] = m;
  const [month, day, hour, minute, second] = [Number(mo), Number(dd), Number(hh), Number(mi), Number(ss)];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return { prefix: prefix!, hint: null };
  return { prefix: prefix!, hint: `20${yy}-${mo}-${dd}T${hh}:${mi}:${ss}` };
}

export interface SnapshotDiff {
  changed: boolean;
  permit: { field: string; from: string | null; to: string | null }[];
  reviews: { added: string[]; removed: string[]; changed: { recordId: string; fields: string[] }[] };
  attachments: { added: string[]; removed: string[]; changed: { key: string; fields: string[] }[] };
}

/** Compares two captures of the same permit. Capture timestamps and session IDs are ignored; only portal content counts. */
export function diffSnapshots(previous: Snapshot, next: Snapshot): SnapshotDiff {
  if (previous.permitNumber !== next.permitNumber) throw new Error('Snapshots describe different permits');
  const diff: SnapshotDiff = { changed: false, permit: [], reviews: { added: [], removed: [], changed: [] }, attachments: { added: [], removed: [], changed: [] } };
  for (const field of Object.keys(next.permit) as (keyof Snapshot['permit'])[]) {
    if (previous.permit[field] !== next.permit[field]) diff.permit.push({ field, from: previous.permit[field], to: next.permit[field] });
  }
  const compare = <T extends Record<string, unknown>>(a: T[], b: T[], id: keyof T, fields: (keyof T)[]) => {
    const before = new Map(a.map(x => [String(x[id]), x])); const after = new Map(b.map(x => [String(x[id]), x]));
    const added = [...after.keys()].filter(k => !before.has(k)); const removed = [...before.keys()].filter(k => !after.has(k));
    const changed = [...after.entries()].filter(([k]) => before.has(k)).map(([k, x]) => ({ key: k, fields: fields.filter(f => before.get(k)![f] !== x[f]).map(String) })).filter(c => c.fields.length);
    return { added, removed, changed };
  };
  const r = compare(previous.reviews, next.reviews, 'recordId', ['type', 'reviewer', 'status', 'submitted', 'completed', 'dueDate', 'group', 'remarks', 'sha256']);
  diff.reviews = { added: r.added, removed: r.removed, changed: r.changed.map(c => ({ recordId: c.key, fields: c.fields })) };
  const a = compare(previous.attachments, next.attachments, 'key', ['label', 'name', 'void']);
  diff.attachments = a;
  diff.changed = diff.permit.length > 0 || r.added.length > 0 || r.removed.length > 0 || r.changed.length > 0 || a.added.length > 0 || a.removed.length > 0 || a.changed.length > 0;
  return diff;
}

/**
 * Reconstructs what the portal would have shown on an earlier date, from the
 * event history visible today. Reviews submitted after `asOf` disappear;
 * reviews completed after `asOf` become pending; dated permit milestones after
 * `asOf` are cleared. Attachments use the key timestamp hint. The result is
 * labelled as a replay and must never be presented as a live observation.
 */
export function replaySnapshot(snapshot: Snapshot, asOf: string): Snapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Replay date must be YYYY-MM-DD');
  if (snapshot.replay) throw new Error('Cannot replay a replay');
  const after = (value: string | null) => { const iso = toIso(value); return iso !== null && iso > asOf; };
  const permit = { ...snapshot.permit };
  for (const field of ['approvedDate', 'issuedDate', 'finaledDate', 'expirationDate'] as const) if (after(permit[field])) permit[field] = null;
  if (after(snapshot.permit.approvedDate) || after(snapshot.permit.issuedDate) || after(snapshot.permit.finaledDate)) permit.status = 'REPLAY: not yet approved on this date';
  const reviews = snapshot.reviews.filter(r => !after(r.submitted)).map(r => after(r.completed) ? { ...r, completed: null, status: 'REPLAY: pending on this date', notes: '', remarks: null, sha256: r.sha256 } : r);
  const attachments = snapshot.attachments.filter(a => a.keyTimestampHint === null || a.keyTimestampHint.slice(0, 10) <= asOf);
  return { ...snapshot, permit, reviews, attachments, replay: { asOf, from: snapshot.capturedAt } };
}

/** Reviews of one discipline across cycles, in submission order. "BUILDING EXPEDITE" and "BUILDING" are the same discipline. */
export const discipline = (type: string) => type.replace(/\s+EXPEDITE$/i, '').trim().toUpperCase();
export function disciplineChain(snapshot: Snapshot, recordId: string): Review[] {
  const own = snapshot.reviews.find(r => r.recordId === recordId);
  if (!own) return [];
  return snapshot.reviews.filter(r => discipline(r.type) === discipline(own.type)).sort((a, b) => (toIso(a.submitted) ?? '').localeCompare(toIso(b.submitted) ?? ''));
}
