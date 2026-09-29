import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PortalCase } from './portal-etrakit.js';

// A run is either a pinned case file (cases/<name>.json) or a dynamic request:
// a known portal or any https eTRAKiT origin, plus a permit number typed by a
// person. Dynamic runs pin nothing and select attachments automatically.

export const PERMIT_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._-]{1,24}$/;
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

export async function listPortals(casesDir: string): Promise<{ slug: string; authority: string; origin: string; permitNumber: string }[]> {
  const names = (await readdir(casesDir)).filter(n => n.endsWith('.json')).sort();
  const portals = [];
  for (const name of names) {
    const c = JSON.parse(await readFile(join(casesDir, name), 'utf8'));
    if (c.origin && c.searchPath && c.permitNumber) portals.push({ slug: name.replace(/\.json$/, ''), authority: c.authority, origin: c.origin, permitNumber: c.permitNumber });
  }
  return portals;
}

/** Resolves `--portal` (a case slug or an https origin) and `--permit` into a case plus the slug used for artifact folders and comparisons. */
export async function resolveCase(casesDir: string, portal: string, permit: string | undefined): Promise<{ c: PortalCase; slug: string }> {
  if (/^https:\/\//i.test(portal)) {
    if (!permit) throw new Error('A permit number is required with a portal URL');
    if (!PERMIT_NUMBER.test(permit)) throw new Error('Permit number has unexpected characters');
    const url = new URL(portal);
    if (url.username || url.password) throw new Error('Portal URL must not carry credentials');
    const host = url.hostname;
    const c: PortalCase = { name: `${host} ${permit}`, authority: host, origin: url.origin, searchPath: '/eTRAKiT/Search/permit.aspx', permitNumber: permit, expectedSiteAddress: '', qualifiedAt: '', attachments: [], autoAttachments: true, notes: 'Unqualified portal: the adapter was verified on Pinecrest and Atherton; this deployment has not been checked by hand.' };
    return { c, slug: `${slugify(host)}-${slugify(permit)}` };
  }
  if (!/^[a-z0-9-]+$/.test(portal)) throw new Error('Portal must be a case name under cases/ or an https URL');
  const base: PortalCase = JSON.parse(await readFile(join(casesDir, `${portal}.json`), 'utf8'));
  if (!permit || permit === base.permitNumber) return { c: base, slug: portal };
  if (!PERMIT_NUMBER.test(permit)) throw new Error('Permit number has unexpected characters');
  const c: PortalCase = { ...base, name: `${base.authority} ${permit}`, permitNumber: permit, expectedSiteAddress: '', attachments: [], autoAttachments: true, notes: undefined };
  return { c, slug: `${portal}-${slugify(permit)}` };
}
