import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const base = fileURLToPath(new URL('../fixtures/generated/', import.meta.url));
const address = '123 Example Lane (fictional)';
for (const variant of ['incomplete', 'corrected', 'unreadable']) {
  const dir = join(base, variant); await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const kinds = variant === 'incomplete' ? ['structural', 'elevation'] : ['site', 'structural', 'elevation'];
  for (const [i, kind] of kinds.entries()) {
    const page = pdf.addPage(variant === 'incomplete' && i === 1 ? [792, 612] : [612, 792]);
    if (variant === 'unreadable' && kind === 'site') {
      // Image-only page: simulates a scan with no extractable text. It must be reviewed.
      const pixel = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
      page.drawImage(pixel, { x: 50, y: 50, width: 500, height: 600 });
      continue;
    }
    const lines = [
      'SYNTHETIC TEST FIXTURE - NOT A CONSTRUCTION DRAWING',
      `Drawing type: ${kind}`,
      `Project address: ${variant === 'incomplete' && i === 1 ? '321 Example Lane (fictional)' : address}`,
      'Project: Demonstration attached uncovered wood deck',
      'Illustrative deck footprint: 12 feet by 16 feet; area 192 square feet.',
      'Illustrative walking surface: 48 inches above adjacent grade.',
      'These labels test text extraction and evidence linkage only.',
      'No structural dimensions, calculations or construction approval are provided.',
    ];
    lines.forEach((text, n) => page.drawText(text, { x: 30, y: page.getHeight() - 45 - n * 22, size: 10, font, color: rgb(0, 0, 0) }));
    page.drawRectangle({ x: 60, y: 160, width: 240, height: 160, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    page.drawText('Illustration only - not to scale', { x: 65, y: 170, size: 10, font });
  }
  await writeFile(join(dir, 'plans.pdf'), await pdf.save());
  const contact = (name: string) => ({ name, address: '456 Demonstration Way (fictional)', cityStateZip: 'Portland, OR (demo)', phone: '503-555-0100', email: 'demo@example.com' });
  await writeFile(join(dir, 'project.json'), JSON.stringify({
    name: `Deck demo - ${variant}`, synthetic: true,
    jurisdiction: 'portland-or', permitType: 'attached-uncovered-residential-deck',
    address, cityStateZip: 'Portland, OR (fictional parcel)', parcel: null,
    description: 'DEMO ONLY: New attached uncovered wood deck, 12 x 16 feet, 48 inches above grade. Fictional project; not for submission.',
    deckAreaSqFt: 192, valuation: 12000,
    owner: contact('Example Owner'), contractor: { ...contact('Example Builders'), license: null },
    applicant: { ...contact('Example Coordinator'), business: 'Example Builders' },
    scopeConfirmed: false, documents: [{ path: 'plans.pdf', role: 'plans' }],
  }, null, 2));
}
console.log(`Generated incomplete, corrected and unreadable PDF fixtures in ${base}`);
