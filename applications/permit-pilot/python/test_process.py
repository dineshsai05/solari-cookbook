"""Run after npm run fixtures: python -m unittest discover -s python -p 'test_*.py'."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from process import inspect, build

ROOT = Path(__file__).resolve().parents[1]


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def stage(self, variant):
        source = ROOT / 'fixtures' / 'generated' / variant
        shutil.copy(source / 'plans.pdf', self.path / 'doc-0.pdf')
        shutil.copy(source / 'project.json', self.path / 'project.json')
        (self.path / 'input.json').write_text(json.dumps([dict(id='d1', name='plans.pdf', role='plans', file='doc-0.pdf')]))

    def test_real_pdf_extraction_and_dimensions(self):
        self.stage('incomplete')
        inspect(self.path)
        doc = json.loads((self.path / 'documents.json').read_text())[0]
        self.assertIn('321 Example Lane', doc['pages'][1]['text'])
        self.assertNotEqual(doc['pages'][0]['width'], doc['pages'][1]['width'])

    def test_image_only_page_stays_empty(self):
        self.stage('unreadable')
        inspect(self.path)
        doc = json.loads((self.path / 'documents.json').read_text())[0]
        self.assertEqual(doc['pages'][0]['text'], '')

    def test_encrypted_pdf_is_not_silently_decrypted(self):
        self.stage('corrected')
        writer = PdfWriter()
        writer.append(self.path / 'doc-0.pdf')
        writer.encrypt('test-password')
        writer.write(self.path / 'encrypted.pdf')
        (self.path / 'doc-0.pdf').write_bytes((self.path / 'encrypted.pdf').read_bytes())
        inspect(self.path)
        doc = json.loads((self.path / 'documents.json').read_text())[0]
        self.assertTrue(doc['encrypted'])
        self.assertEqual(doc['pages'], [])

    def test_draft_keeps_signatures_and_office_fields_blank(self):
        self.stage('corrected')
        shutil.copy(ROOT / 'fixtures/reference/building-application.pdf', self.path / 'form.pdf')
        build(self.path)
        reader = PdfReader(self.path / 'draft-application.pdf')
        fields = reader.get_fields()
        self.assertEqual(fields['Job Address']['/V'], '123 Example Lane (fictional)')
        for key in ['Owner signature', 'Contractor Authorized Signature', 'Contact Signature', 'Office Use Only']:
            self.assertFalse(fields[key].get('/V'))
        self.assertIn('SYNTHETIC DEMO', reader.pages[0].extract_text())
        self.assertIn('Fictional project; not for submission.', reader.pages[0].extract_text())

    def test_changed_form_is_rejected(self):
        self.stage('corrected')
        (self.path / 'form.pdf').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Unreviewed'):
            build(self.path)

    def test_oversized_text_is_rejected_instead_of_clipped(self):
        self.stage('corrected')
        shutil.copy(ROOT / 'fixtures/reference/building-application.pdf', self.path / 'form.pdf')
        project = json.loads((self.path / 'project.json').read_text())
        project['owner']['phone'] = 'x' * 100
        (self.path / 'project.json').write_text(json.dumps(project))
        with self.assertRaisesRegex(ValueError, 'too long'):
            build(self.path)


if __name__ == '__main__':
    unittest.main()
