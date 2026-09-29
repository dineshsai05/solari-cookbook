import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLive } from '../src/model.js';
import type { Document } from '../src/schema.js';

const docs: Document[] = [{ id: 'document-1', name: 'test.pdf', role: 'plans', sha256: 'test', encrypted: false, error: null, pages: [{ number: 1, width: 612, height: 792, text: 'Drawing type: site', textTruncated: false }] }];
const payload = { pages: [{ documentId: 'document-1', page: 1, kinds: [{ kind: 'site', quote: 'Drawing type: site' }], addresses: [] }] };
function transport(content: string, finish = 'stop', refusal: string | null = null): typeof fetch {
  return async (input, init) => {
    assert.equal(String(input), 'https://api.aimlapi.com/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'test/model');
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.max_tokens, 8000);
    assert.equal(body.messages.length, 2);
    return new Response(JSON.stringify({ id: 'test-completion', model: 'test/model', choices: [{ finish_reason: finish, message: { role: 'assistant', content, refusal } }], usage: { total_tokens: 10 } }), { headers: { 'content-type': 'application/json' } });
  };
}
test('AIML requests use its endpoint and validate returned evidence', async () => {
  const result = await analyzeLive(docs, 'fake-test-key', 'test/model', transport(JSON.stringify(payload)));
  assert.equal(result.provider, 'aiml');
  assert.deepEqual(result.analysis, payload);
});
test('AIML truncated, refused, malformed and unsupported outputs fail closed', async () => {
  await assert.rejects(analyzeLive(docs, 'fake-test-key', 'test/model', transport(JSON.stringify(payload), 'length')), /incomplete/);
  await assert.rejects(analyzeLive(docs, 'fake-test-key', 'test/model', transport('{}', 'stop', 'refused')), /refused/);
  await assert.rejects(analyzeLive(docs, 'fake-test-key', 'test/model', transport('not json')), /invalid JSON/);
  await assert.rejects(analyzeLive(docs, 'fake-test-key', 'test/model', transport('{}')), /schema validation/);
  await assert.rejects(analyzeLive(docs, 'fake-test-key', 'test/model', transport(JSON.stringify({ pages: [] }))), /every extracted page/);
});
