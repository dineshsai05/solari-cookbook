"""Fixed public-record extraction tool; called only in the Solari sandbox.

The host supplies the reviewed URL/hash manifest, never model-generated commands.
Large drawing originals are indexed, not downloaded or interpreted in this mode.
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
import pypdfium2 as pdfium

root = Path(sys.argv[1])
case = json.loads((root / 'case.json').read_text())
result = []
total_pages = 0
for item in case['files']:
    if not item['analyze']:
        continue
    url = item['url']
    if urlparse(url).scheme != 'https' or urlparse(url).hostname != 'www.woodburn-or.gov':
        raise ValueError('Unexpected source origin')
    request = urllib.request.Request(url, headers={'User-Agent': 'PermitPilot public research demo'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if urlparse(response.url).hostname != 'www.woodburn-or.gov':
            raise ValueError('Unexpected redirect')
        data = response.read(10_000_001)
    if len(data) > 10_000_000 or hashlib.sha256(data).hexdigest() != item['sha256']:
        raise ValueError('Public source changed or exceeds size budget: ' + item['id'])
    pages = []
    with pdfium.PdfDocument(data) as pdf:
        if len(pdf) != item['pages']:
            raise ValueError('Unexpected page count')
        total_pages += len(pdf)
        if total_pages > 60:
            raise ValueError('Case extraction exceeds 60 pages')
        for i in range(len(pdf)):
            page = pdf[i]
            textpage = page.get_textpage()
            text = textpage.get_text_range()
            pages.append(dict(number=i+1, text=text[:10000], textTruncated=len(text)>10000))
            textpage.close()
            page.close()
    result.append(dict(id=item['id'], name=item['id'], url=url, sha256=item['sha256'], pages=pages))
(root/'documents.json').write_text(json.dumps(result))
print(json.dumps({'documents': len(result), 'pages': total_pages}))
