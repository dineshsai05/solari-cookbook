"""Fixed document tools shared by local verification and the Solari sandbox.

Inputs are supplied files, never Python/shell code. No network or model calls.
"""
import hashlib
import io
import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, NumberObject
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import reportlab

FORM_SHA = "04671f40f528baaaae5fe42f5f6dcfe0b5aa94ec045f2c10429c417b06f4daf9"


def inspect(root):
    manifest = json.loads((root / "input.json").read_text())
    result = []
    total_pages = 0
    for item in manifest:
        path = root / item["file"]
        if path.parent != root or path.suffix != ".pdf":
            raise ValueError("Invalid staged PDF path")
        data = path.read_bytes()
        if len(data) > 10_000_000:
            raise ValueError("PDF exceeds 10 MB limit")
        doc = dict(id=item["id"], name=item["name"], role=item["role"],
                   sha256=hashlib.sha256(data).hexdigest(), encrypted=False, error=None, pages=[])
        try:
            reader = PdfReader(io.BytesIO(data))
            doc["encrypted"] = reader.is_encrypted
            if reader.is_encrypted:
                doc["error"] = "Encrypted PDF was not read"
            else:
                total_pages += len(reader.pages)
                if total_pages > 60:
                    raise ValueError("Document set exceeds 60 pages")
                for number, page in enumerate(reader.pages, 1):
                    text = page.extract_text() or ""
                    # Include editable PDF values that may not appear in text extraction.
                    for annot in page.get("/Annots", []):
                        obj = annot.get_object()
                        if obj.get("/FT") == "/Tx" and obj.get("/V"):
                            text += f"\n{obj.get('/T', 'Field')}: {obj.get('/V')}"
                    width, height = float(page.cropbox.width), float(page.cropbox.height)
                    if page.rotation % 180:
                        width, height = height, width
                    doc["pages"].append(dict(number=number, width=width, height=height,
                                             text=text[:6000], textTruncated=len(text) > 6000))
        except Exception as exc:
            doc["error"] = f"PDF extraction failed ({type(exc).__name__})"
            doc["pages"] = []
        result.append(doc)
    (root / "documents.json").write_text(json.dumps(result, indent=2))


def build(root):
    project = json.loads((root / "project.json").read_text())
    template = (root / "form.pdf").read_bytes()
    if hashlib.sha256(template).hexdigest() != FORM_SHA:
        raise ValueError("Unreviewed application template")
    reader = PdfReader(io.BytesIO(template))
    values = {
        "Addition": "/Yes",
        "Residential: 1 and 2 Family Dwellings": "/Residential: 1 & 2 Family Dwellin",
        "Property Owner": "/Property owner  or",
        "Contractor": "/Contractor",
        "Job Address": project["address"],
        "Job City/State/ZIP": project["cityStateZip"],
        "Tax Map/Parcel Number": project["parcel"],
        "Project Name": project["name"],
        "Description of work": project["description"],
        "Deck Area": str(project["deckAreaSqFt"]),
        "Residential Valuation": str(project["valuation"]) if project["valuation"] else None,
        "Name of property owner or tenant": project["owner"]["name"],
        "Address of property owner or tenant": project["owner"]["address"],
        "City/State/ZIP of property owner or tenant": project["owner"]["cityStateZip"],
        "Phone of property owner or tenant": project["owner"]["phone"],
        "Email of property owner or tenant": project["owner"]["email"],
        "Name of Business": project["contractor"]["name"],
        "Address of Contractor": project["contractor"]["address"],
        "City/State/ZIP of Contractor": project["contractor"]["cityStateZip"],
        "Phone of Business": project["contractor"]["phone"],
        "Email of Contractor": project["contractor"]["email"],
        "CCB lic. no": project["contractor"]["license"],
        "Name of Contact Business": project["applicant"]["business"],
        "Contact name": project["applicant"]["name"],
        "Contact Address": project["applicant"]["address"],
        "Contact City/State/ZIP": project["applicant"]["cityStateZip"],
        "Contact Phone": project["applicant"]["phone"],
        "Contact Email": project["applicant"]["email"],
    }
    values = {key: value for key, value in values.items() if value is not None}
    fields = reader.get_fields() or {}
    if not set(values).issubset(fields):
        raise ValueError("Required form fields are unavailable")
    # Record an inspectable mapping; never fill signature, date or office-use fields.
    (root / "field-values.json").write_text(json.dumps(values, indent=2))
    writer = PdfWriter()
    writer.append(reader)
    appearance_values = {}
    for key, value in values.items():
        if fields[key].get('/FT') == '/Tx':
            # A fixed readable font size and explicit line breaks prevent the
            # original form's 12pt default from clipping long descriptions.
            text = str(value)
            if key == 'Description of work':
                text = '\n'.join(simpleSplit(text, 'Helvetica', 9, 335))
            appearance_values[key] = (text, '/Helv', 9)
        else:
            appearance_values[key] = value
    writer.update_page_form_field_values(writer.pages[0], appearance_values, auto_regenerate=False)
    overlay = io.BytesIO()
    stamp = canvas.Canvas(overlay, pagesize=(612, 792))
    # Embed a font: the city's AcroForm uses a custom Helvetica encoding whose
    # generated appearances render inconsistently across PDF viewers.
    pdfmetrics.registerFont(TTFont('PermitVera', str(Path(reportlab.__file__).parent / 'fonts' / 'Vera.ttf')))
    stamp.setFont('PermitVera', 10)
    stamp.drawString(30, 766, "SYNTHETIC DEMO - DO NOT SUBMIT" if project["synthetic"] else "DRAFT - REVIEW REQUIRED - UNSIGNED")
    for annot in writer.pages[0]['/Annots']:
        obj = annot.get_object()
        key = obj.get('/T')
        if key not in values:
            continue
        left, bottom, right, top = map(float, obj['/Rect'])
        if obj.get('/FT') == '/Tx':
            text = str(values[key])
            size = 9
            width = right - left - 4
            lines = simpleSplit(text, 'PermitVera', size, width) if key == 'Description of work' else [text]
            if key != 'Description of work':
                while pdfmetrics.stringWidth(text, 'PermitVera', size) > width and size > 7:
                    size -= 0.25
                if pdfmetrics.stringWidth(text, 'PermitVera', size) > width:
                    raise ValueError(f'Value too long for form field: {key}')
            if len(lines) * (size + 2) > top - bottom:
                raise ValueError(f'Value too tall for form field: {key}')
            stamp.setFont('PermitVera', size)
            for i, line in enumerate(lines):
                stamp.drawString(left + 2, top - size - 2 - i * (size + 2), line)
        elif obj.get('/FT') == '/Btn':
            stamp.setFillColorRGB(1, 1, 1)
            stamp.rect(left, bottom, right - left, top - bottom, fill=1, stroke=1)
            stamp.setFillColorRGB(0, 0, 0)
            stamp.setFont('PermitVera', 8)
            stamp.drawCentredString((left + right) / 2, bottom + 2, 'X')
        # Keep field values for audit/round-trip checks, hide their inconsistent
        # widget appearances. The overlay is the visible, immutable draft text.
        obj[NameObject('/F')] = NumberObject(2)
    stamp.save()
    writer.pages[0].merge_page(PdfReader(overlay).pages[0])
    writer.write(root / "draft-application.pdf")
    # Check stored field values after serialization.
    filled = PdfReader(root / "draft-application.pdf").get_fields()
    for key, value in values.items():
        if ' '.join(str(filled[key].get("/V", "")).split()) != ' '.join(str(value).split()):
            raise ValueError(f"Form round-trip verification failed: {key}")


if __name__ == "__main__":
    action, directory = sys.argv[1:]
    if action not in ("inspect", "build"):
        raise ValueError("Unsupported operation")
    {"inspect": inspect, "build": build}[action](Path(directory).resolve())
