"""Fixed text-extraction tool for downloaded portal attachments; runs only in the Solari sandbox.

The host supplies PDF bytes it already fetched through the browser session.
This script never touches the network and never receives model output.
"""
import json
import sys
from pathlib import Path
import pypdfium2 as pdfium

root = Path(sys.argv[1])
manifest = json.loads((root / 'attachments.json').read_text())
result = []
total = 0
for item in manifest:
    path = root / item['file']
    if path.parent != root or path.suffix != '.pdf':
        raise ValueError('Invalid staged attachment path')
    data = path.read_bytes()
    if len(data) > 15_000_000:
        raise ValueError('Attachment exceeds size budget')
    pages = []
    n_pages = 0
    with pdfium.PdfDocument(data) as pdf:
        n_pages = len(pdf)
        # Bounded: at most 12 pages per file and 40 in total; the rest are counted, not read.
        allowed = max(0, min(len(pdf), 12, 40 - total))
        total += allowed
        for i in range(allowed):
            page = pdf[i]
            textpage = page.get_textpage()
            text = textpage.get_text_range()
            pages.append(dict(number=i + 1, text=text[:10000], textTruncated=len(text) > 10000))
            textpage.close()
            page.close()
    result.append(dict(id=item['id'], url=item['url'], pages=pages, pagesTotal=n_pages, pagesTruncated=n_pages - allowed))
(root / 'documents.json').write_text(json.dumps(result))
print(json.dumps({'documents': len(result), 'pages': total}))
