// Evidence passages: the host slices extracted text into numbered pieces, the
// model may only cite passage IDs, and the host reinserts the immutable original
// text. The model never writes a quotation, so it cannot fabricate one.
export interface PassageDocument { id: string; url: string; pagesTotal?: number; pagesTruncated?: number; pages: { number: number; text: string; textTruncated: boolean }[] }
export interface Passage { passageId: string; documentId: string; page: number; quote: string }
export interface Evidence { documentId: string; page: number; quote: string }

export function passagesFor(documents: PassageDocument[]): Passage[] {
  return documents.flatMap(d => d.pages.flatMap(p => {
    const pieces: string[] = []; let current = '';
    for (const line of p.text.split(/\r?\n/)) {
      for (let offset = 0; offset < line.length; offset += 400) {
        const piece = line.slice(offset, offset + 400);
        if (line.length > 400) { if (current) { pieces.push(current); current = ''; } pieces.push(piece); continue; }
        if (current.length + piece.length + 1 > 500) { pieces.push(current); current = ''; }
        current += (current ? '\n' : '') + piece;
      }
    }
    if (current.trim()) pieces.push(current);
    return pieces.map((quote, i) => ({ passageId: `${d.id}:p${p.number}:s${i + 1}`, documentId: d.id, page: p.number, quote }));
  }));
}

/** Replaces every `{passageId}` in `items[].evidence` with the original passage. Unknown IDs stop the run. */
export function resolveEvidence<T extends { evidence: { passageId: string }[] }>(items: T[], documents: PassageDocument[]): (Omit<T, 'evidence'> & { evidence: Evidence[] })[] {
  const catalog = new Map(passagesFor(documents).map(p => [p.passageId, p]));
  return items.map(item => ({ ...item, evidence: item.evidence.map(e => {
    const passage = catalog.get(e.passageId); if (!passage) throw new Error('Unknown source passage ID');
    return { documentId: passage.documentId, page: passage.page, quote: passage.quote };
  }) }));
}
