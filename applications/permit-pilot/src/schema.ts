import { z } from 'zod';

const value = z.string().max(160).nullable();
const contact = z.object({ name: value, address: value, cityStateZip: value, phone: value, email: value });
export const ProjectSchema = z.object({
  name: z.string().min(1).max(80),
  synthetic: z.boolean(),
  jurisdiction: z.literal('portland-or'),
  permitType: z.literal('attached-uncovered-residential-deck'),
  address: z.string().min(1).max(120),
  cityStateZip: z.string().min(1).max(100),
  parcel: value,
  description: z.string().min(1).max(280),
  deckAreaSqFt: z.number().positive().max(10000),
  valuation: z.number().positive().nullable(),
  owner: contact,
  contractor: contact.extend({ license: value }),
  applicant: contact.extend({ business: value }),
  scopeConfirmed: z.boolean(),
  documents: z.array(z.object({ path: z.string().min(1), role: z.enum(['plans', 'supporting']) })).min(1).max(10),
}).strict();
export type Project = z.infer<typeof ProjectSchema>;
export interface Source { id: string; url: string; title: string; text: string; capturedAt: string; sha256: string; mode: 'live' | 'reference-excerpt'; screenshot?: string }
export interface Page { number: number; width: number; height: number; text: string; textTruncated: boolean }
export interface Document { id: string; name: string; role: 'plans' | 'supporting'; sha256: string; encrypted: boolean; error: string | null; pages: Page[] }
export const Kind = z.enum(['site', 'structural', 'elevation', 'unknown']);
export const AnalysisSchema = z.object({ pages: z.array(z.object({
  documentId: z.string(), page: z.number().int(),
  kinds: z.array(z.object({ kind: Kind, quote: z.string().max(250) })).max(4),
  addresses: z.array(z.object({ value: z.string().max(160), quote: z.string().max(250) })).max(4),
})) });
export type Analysis = z.infer<typeof AnalysisSchema>;
export interface Finding {
  id: string; title: string; status: 'evidence_found' | 'missing' | 'conflict' | 'needs_review';
  explanation: string; sourceId: string | null;
  evidence: { documentId: string; page: number; quote: string }[];
}
export const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
