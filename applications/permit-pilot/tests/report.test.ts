import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportHTML } from '../src/report.js';

test('untrusted document text is escaped in HTML reports', () => {
  const html = reportHTML('<script>alert(1)</script>', 'local', [{ id: 'x', title: '<img src=x>', status: 'needs_review', explanation: '<svg onload=alert(1)>', sourceId: null, evidence: [{ documentId: 'document-1', page: 2, quote: '</blockquote><script>bad()</script>' }] }], []);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<svg'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('LOCAL VERIFICATION'));
  assert.ok(html.includes('inputs/document-1.pdf#page=2'));
});
