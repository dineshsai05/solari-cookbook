import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserSession } from '@solarisdk/browser';
import { digest } from './sources.js';
import { parseAttachmentKey, SnapshotSchema, type Attachment, type Review, type Snapshot } from './portal-snapshot.js';

// Read-only adapter for CentralSquare eTRAKiT public portals (verified against
// the Village of Pinecrest, FL and the Town of Atherton, CA deployments). It
// searches, reads, and downloads. It never logs in, never posts a form other
// than the public search, and never touches the applicant record.

export interface PortalCase {
  name: string; authority: string; origin: string; searchPath: string; permitNumber: string; expectedSiteAddress: string; qualifiedAt: string; notes?: string;
  attachments: { id: string; match: string; role: string; sha256: string; pages: number }[];
}
/** Deployments label the search dropdowns differently ("PERMIT NUMBER", "Permit No", "PERMIT_NO"). Picks the option to use or returns null. */
export function pickOption(options: { label: string; value: string }[], kind: 'permitNumber' | 'equals') {
  const test = kind === 'permitNumber' ? /permit[\s_]*(number|no\b|num\b|#)/i : /^equals$/i;
  return options.find(o => test.test(o.label.trim())) ?? (kind === 'permitNumber' ? options.find(o => /permit/i.test(o.label)) ?? null : null);
}
export type Event = (name: string, detail?: unknown) => Promise<void>;
type Page = Awaited<ReturnType<BrowserSession['newPage']>>;
export const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Parses the text of a reviewInfo.aspx page: "Label:\n\tValue" blocks followed by free-text Notes. */
export function parseReviewDetail(text: string): { group: string | null; type: string | null; status: string | null; submitted: string | null; dueDate: string | null; completed: string | null; reviewer: string | null; remarks: string | null; notes: string } {
  const field = (label: string) => { const m = new RegExp(`(?:^|\\n)\\s*${label}:\\s*\\n?\\s*([^\\n]*)`).exec(text); const v = m?.[1]?.trim() ?? ''; return v ? v : null; };
  const notesAt = text.search(/(?:^|\n)\s*Notes:/);
  const notes = notesAt >= 0 ? decode(text.slice(notesAt).replace(/^\s*Notes:\s*/, '').trim()) : '';
  const remarksMatch = /(?:^|\n)[ \t]*Remarks:[ \t]*\n?([\s\S]*?)(?=\n\s*Notes:|$)/.exec(text);
  const remarks = remarksMatch?.[1]?.trim() ? decode(remarksMatch[1].trim()) : null;
  return { group: field('Group'), type: field('Type'), status: field('Status'), submitted: field('Date Submitted'), dueDate: field('Date Due'), completed: field('Date Completed'), reviewer: field('Reviewer'), remarks, notes };
}

export function isPortalUrl(origin: string, url: string) {
  try { const u = new URL(url); const o = new URL(origin); return u.protocol === 'https:' && u.hostname === o.hostname && !u.username && !u.password; } catch { return false; }
}

const label = async (page: Page, suffix: string) => { const el = page.locator(`[id$="${suffix}"]`).first(); return (await el.count()) ? collapse(await el.innerText()) || null : null; };

export async function captureSnapshot(page: Page, c: PortalCase, out: string, event: Event, sessionId: string | null): Promise<{ snapshot: Snapshot; files: Map<string, Buffer> }> {
  page.setDefaultTimeout(30_000);
  const searchUrl = c.origin + c.searchPath;
  const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!response?.ok() || !isPortalUrl(c.origin, page.url())) throw new Error('Portal search page unavailable');
  // The public search form: this is the only form the adapter submits.
  const options = (selector: string) => page.locator(`${selector} option`).evaluateAll(os => os.map(o => ({ label: o.textContent || '', value: (o as HTMLOptionElement).value })));
  const by = pickOption(await options('#cplMain_ddSearchBy'), 'permitNumber');
  if (!by) throw new Error('Portal search form has no permit-number option');
  await page.locator('#cplMain_ddSearchBy').selectOption({ value: by.value });
  await page.waitForTimeout(1500); // some deployments post back when the field changes
  const oper = pickOption(await options('#cplMain_ddSearchOper'), 'equals');
  if (!oper) throw new Error('Portal search form has no Equals operator');
  await page.locator('#cplMain_ddSearchOper').selectOption({ value: oper.value });
  await page.locator('#cplMain_txtSearchString').fill(c.permitNumber);
  await page.screenshot({ path: join(out, 'portal-search-form.png'), fullPage: false });
  await page.locator('#ctl00_cplMain_btnSearch').click();
  const hit = page.getByText(c.permitNumber, { exact: true });
  await hit.first().waitFor({ state: 'visible', timeout: 45_000 });
  await page.screenshot({ path: join(out, 'portal-search.png'), fullPage: true });
  await hit.first().click();
  await page.locator('[id$="lblPermitStatus"]').first().waitFor({ state: 'visible', timeout: 45_000 });
  const heading = collapse(await page.locator('body').innerText());
  if (!heading.includes(`Permit #${c.permitNumber}`)) throw new Error('Search result did not open the requested permit');
  await event('portal_permit_opened', { url: page.url() });

  const permit = {
    type: await label(page, 'lblPermitType'), subtype: await label(page, 'lblPermitSubtype'), description: await label(page, 'lblPermitDesc'),
    status: await label(page, 'lblPermitStatus'), siteAddress: await label(page, 'hlSiteAddress'),
    appliedDate: await label(page, 'lblPermitAppliedDate'), approvedDate: await label(page, 'lblPermitApprovedDate'), issuedDate: await label(page, 'lblPermitIssuedDate'),
    finaledDate: await label(page, 'lblPermitFinaledDate'), expirationDate: await label(page, 'lblPermitExpirationDate'),
  };
  if (!permit.status) throw new Error('Permit status label not found; portal layout may have changed');
  if (permit.siteAddress && !collapse(permit.siteAddress).toUpperCase().includes(c.expectedSiteAddress.toUpperCase())) throw new Error('Permit site address does not match the qualified case');
  await page.screenshot({ path: join(out, 'portal-permit-info.png'), fullPage: true });
  await event('portal_permit_info_captured', { status: permit.status });

  // Attachments are listed on the permit page with a portal label (which may say VOID) beside each link.
  const rawAttachments = await page.locator('a[href*="viewAttachment.aspx"]').evaluateAll(anchors => anchors.map(a => {
    const row = a.closest('tr'); const cells = row ? Array.from(row.querySelectorAll('td')) : [];
    const labelCell = cells.find(td => td.contains(a)) ? cells[cells.findIndex(td => td.contains(a)) - 1] : undefined;
    return { href: a.getAttribute('href') || '', name: a.textContent || '', label: labelCell?.textContent || '' };
  }));
  const attachments: Attachment[] = rawAttachments.map(a => {
    const url = new URL(a.href, page.url()).href;
    const key = new URL(url).searchParams.get('key') || '';
    const label = collapse(a.label);
    return { key, label, name: collapse(a.name), url, void: /^VOID\b/i.test(label), keyTimestampHint: parseAttachmentKey(key).hint, downloaded: null };
  }).filter(a => a.key && isPortalUrl(c.origin, a.url));
  if (new Set(attachments.map(a => a.key)).size !== attachments.length) throw new Error('Duplicate attachment keys on the permit page');
  await event('portal_attachments_listed', { count: attachments.length, void: attachments.filter(a => a.void).length });

  await page.locator('.rtsTxt', { hasText: /^Reviews\s*(\(\d+\))?$/ }).first().click();
  const grid = page.locator('table[id$="rgReviewInfo_ctl00"] tbody tr');
  await grid.first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.screenshot({ path: join(out, 'portal-reviews.png'), fullPage: true });
  const rows = await grid.evaluateAll(trs => trs.map(tr => {
    const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent || '');
    const link = tr.querySelector('a[onclick*="openMoreInfo"]');
    const m = /openMoreInfo\('REVIEW','([^']+)','([^']+)','([^']+)'/.exec(link?.getAttribute('onclick') || '');
    return { cells, group: m?.[1] || null, activity: m?.[2] || null, recordId: m?.[3] || null };
  }));
  const reviews: Review[] = [];
  // Each review's detail is a standalone public page that the More Info popup loads in an iframe. Opening it directly in the same context is equivalent and avoids fragile popup handling.
  const detail = await page.context().newPage();
  detail.setDefaultTimeout(30_000);
  let detailShot = false;
  try {
    for (const row of rows) {
      if (!row.recordId || !row.group || row.activity !== c.permitNumber || row.cells.length < 6) throw new Error('Review row did not expose a record ID for this permit');
      const detailUrl = `${c.origin}/eTRAKiT/moreinfo/reviewInfo.aspx?Group=${encodeURIComponent(row.group)}&ActivityNo=${encodeURIComponent(row.activity)}&RecordID=${encodeURIComponent(row.recordId)}&Respond=null`;
      const r = await detail.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!r?.ok() || !isPortalUrl(c.origin, detail.url())) throw new Error('Review detail page unavailable');
      const text = await detail.locator('body').innerText();
      const parsed = parseReviewDetail(text);
      if (!parsed.type) throw new Error('Review detail page did not contain review fields');
      if (parsed.notes && !detailShot) { detailShot = true; await detail.screenshot({ path: join(out, 'portal-review-detail.png'), fullPage: true }); }
      const [type, reviewer, status, submitted, completed, dueDate] = row.cells.map(collapse);
      reviews.push({ recordId: row.recordId, type: type!, reviewer: reviewer!, status: status!, submitted: submitted || null, completed: completed || null, dueDate: dueDate || null, group: parsed.group, remarks: parsed.remarks, notes: parsed.notes, detailUrl, sha256: digest(parsed.notes) });
    }
    if (!detailShot) await detail.screenshot({ path: join(out, 'portal-review-detail.png'), fullPage: true });
  } finally { await detail.close(); }
  if (!reviews.length) throw new Error('No review rows found');
  await event('portal_reviews_captured', { count: reviews.length, withNotes: reviews.filter(r => r.notes).length });

  // Download only the pinned documents, inside the browser session so the portal's own attachment handler serves them.
  const files = new Map<string, Buffer>();
  for (const pin of c.attachments) {
    const matches = attachments.filter(a => collapse(a.name).toUpperCase().includes(pin.match.toUpperCase()));
    if (matches.length !== 1) throw new Error(`Expected exactly one attachment matching ${pin.id}, found ${matches.length}`);
    const target = matches[0]!;
    const encoded = await page.evaluate(async (url: string) => {
      const r = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(60_000) });
      if (!r.ok || !(r.headers.get('content-type') || '').toLowerCase().includes('pdf')) throw new Error('Attachment unavailable');
      const reader = r.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 15_000_000) { await reader.cancel(); throw new Error('Attachment too large'); } chunks.push(value); }
      let binary = ''; for (const bytes of chunks) for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    }, target.url);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`Attachment ${pin.id} is not a PDF`);
    const sha256 = digest(bytes);
    target.downloaded = { id: pin.id, role: pin.role, sha256, bytes: bytes.length, matchesPinned: sha256 === pin.sha256 };
    files.set(pin.id, bytes);
    await writeFile(join(out, 'attachments', `${pin.id}.pdf`), bytes);
    await event('portal_attachment_downloaded', { id: pin.id, bytes: bytes.length, matchesPinned: target.downloaded.matchesPinned, void: target.void });
  }
  const snapshot = SnapshotSchema.parse({ version: 1, capturedAt: new Date().toISOString(), permitNumber: c.permitNumber, portalUrl: page.url(), sessionId, permit, reviews, attachments, replay: null });
  return { snapshot, files };
}
