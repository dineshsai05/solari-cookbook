import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Solari } from '@solarisdk/browser';
import type { Source } from './schema.js';

export const FORM_URL = 'https://www.portland.gov/ppd/documents/building-permit-application-building-site-development-demolition-and-zoning-permits/download';
export const FORM_SHA = '04671f40f528baaaae5fe42f5f6dcfe0b5aa94ec045f2c10429c417b06f4daf9';
export const sourceDefinitions = [
  { id: 'drawings', path: '/ppd/residential-permitting/decks/prepare/create-detailed-plans', anchor: 'Structural plans' },
  { id: 'files', path: '/ppd/residential-permitting/decks/prepare/prepare-your-files', anchor: 'File naming' },
  { id: 'application', path: '/ppd/residential-permitting/decks/prepare/fill-out-your-forms', anchor: 'Type of work' },
  { id: 'changes', path: '/permitimprovement/code-alignment-project', anchor: 'Code Alignment Project' },
];
export const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const isOfficial = (url: string) => {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'www.portland.gov' && !u.username && !u.password; }
  catch { return false; }
};

export async function collectLive(apiKey: string, out: string, event: (name: string, detail: unknown) => Promise<void>) {
  const client = new Solari({ apiKey });
  let browser: Awaited<ReturnType<Solari['launch']>> | undefined;
  const sources: Source[] = [];
  try {
    browser = await client.launch({ recording: true });
    await event('browser_created', { id: browser.id });
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    for (const def of sourceDefinitions) {
      const response = await page.goto('https://www.portland.gov' + def.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!response?.ok() || !isOfficial(page.url())) throw new Error(`Official source unavailable: ${def.id}`);
      const text = await page.locator('body').innerText();
      if (!text.includes(def.anchor) || text.length < 300 || text.length > 100_000) throw new Error(`Unexpected source content: ${def.id}`);
      const screenshot = `sources/${def.id}.png`;
      await page.screenshot({ path: join(out, screenshot), fullPage: true });
      await writeFile(join(out, 'sources', `${def.id}.txt`), text);
      sources.push({ id: def.id, url: page.url(), title: await page.title(), text, capturedAt: new Date().toISOString(), sha256: digest(text), mode: 'live', screenshot });
      await event('source_captured', { id: def.id });
    }
    // This fetch executes INSIDE the remote browser on the same official origin.
    // Credentials are omitted, redirects rejected, response size bounded.
    const encoded = await page.evaluate(async (url: string) => {
      const r = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!r.ok || !r.headers.get('content-type')?.includes('pdf')) throw new Error('Official PDF unavailable');
      const reader = r.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 3_000_000) { await reader.cancel(); throw new Error('PDF too large'); } chunks.push(value); }
      let binary = ''; for (const bytes of chunks) for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    }, FORM_URL);
    const form = Buffer.from(encoded, 'base64');
    if (digest(form) !== FORM_SHA) throw new Error('Official form changed. Inspect its fields and update the reviewed form hash before generating drafts.');
    await writeFile(join(out, 'sources', 'building-application.pdf'), form);
    await event('official_form_verified', { sha256: digest(form) });
    return { sources, form };
  } finally {
    try { if (browser) await browser.close(); }
    finally { await client.close(); }
  }
}

export async function collectReference(root: string, out: string) {
  const references = JSON.parse(await readFile(join(root, 'fixtures/reference/sources.json'), 'utf8')) as { id: string; text: string }[];
  const sources: Source[] = references.map(s => ({ ...s, title: `Reference excerpt: ${s.id}`, url: 'https://www.portland.gov' + sourceDefinitions.find(d => d.id === s.id)!.path, capturedAt: '2026-09-29', sha256: digest(s.text), mode: 'reference-excerpt' }));
  const form = await readFile(join(root, 'fixtures/reference/building-application.pdf'));
  if (digest(form) !== FORM_SHA) throw new Error('Reference form integrity check failed');
  await writeFile(join(out, 'sources/building-application.pdf'), form);
  return { sources, form };
}
