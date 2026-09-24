import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Job } from '../../src/lib/types.js';
import {
  ARTICLE_MAX_TOKENS,
  CHECK_MODEL,
  TONE_MAX_TOKENS,
  buildToneRequest,
  PREVIEW_MAX_TOKENS,
  REWRITE_MODEL,
  SONNET_5_BATCH_PRICES,
  addUsage,
  batchCustomId,
  buildCheckRequest,
  buildRewriteRequest,
  checkModel,
  emptyTotals,
  estimateCostUsd,
  messageText,
  parseCheckOutput,
  parseRewriteOutput,
  rewriteModel,
} from './anthropic.js';
import {
  buildLookup,
  collectBatchResults,
  resultForResponse,
  runSequential,
  toBatchRequests,
} from '../rewrite-api.js';

const SYSTEM = 'SYSTEM PROMPT BODY';

const articleJob: Job = {
  id: 'a:/world/2026/sep/24/slug',
  kind: 'article',
  path: '/world/2026/sep/24/slug',
  input: {
    headline: 'Original headline',
    standfirst: 'Original standfirst',
    bodyHtml: '<p>One</p><figure><figcaption>Cap one</figcaption></figure><p>Two</p>',
    captions: ['Cap one'],
  },
};

const previewJob: Job = {
  id: 'p:/world/2026/sep/24/other',
  kind: 'preview',
  path: '/world/2026/sep/24/other',
  input: { headline: 'Card headline', trail: 'Card trail' },
};

/** Narrow the `system` param, which may be a string or a block array. */
function systemBlocks(params: ReturnType<typeof buildRewriteRequest>) {
  assert.ok(Array.isArray(params.system), 'system should be a block array so it can carry cache_control');
  return params.system;
}

function schemaOf(params: ReturnType<typeof buildRewriteRequest>): Record<string, unknown> {
  const schema = params.output_config?.format?.schema;
  assert.ok(schema, 'output_config.format.schema should be set');
  return schema as Record<string, unknown>;
}

describe('buildRewriteRequest', () => {
  it('sends the system prompt verbatim with an ephemeral cache breakpoint', () => {
    const params = buildRewriteRequest(articleJob, SYSTEM);
    const blocks = systemBlocks(params);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, 'text');
    assert.equal(blocks[0]?.text, SYSTEM);
    assert.deepEqual(blocks[0]?.cache_control, { type: 'ephemeral' });
  });

  it('uses the rewrite model, article budget and adaptive thinking', () => {
    const params = buildRewriteRequest(articleJob, SYSTEM);
    assert.equal(params.model, REWRITE_MODEL);
    assert.equal(params.max_tokens, ARTICLE_MAX_TOKENS);
    assert.deepEqual(params.thinking, { type: 'adaptive' });
    assert.ok(
      !(params.thinking && 'budget_tokens' in params.thinking),
      'budget_tokens is rejected on Sonnet 5',
    );
  });

  it('uses the smaller budget and low effort for previews', () => {
    const params = buildRewriteRequest(previewJob, SYSTEM);
    assert.equal(params.max_tokens, PREVIEW_MAX_TOKENS);
    assert.notEqual(ARTICLE_MAX_TOKENS, PREVIEW_MAX_TOKENS);
    assert.deepEqual(params.thinking, { type: 'adaptive' });
    // Thinking is capped inside max_tokens; high effort would truncate 400 tokens.
    assert.equal(params.output_config?.effort, 'low');
    assert.equal(buildRewriteRequest(articleJob, SYSTEM).output_config?.effort, undefined);
  });

  it('sends a closed json_schema matching ArticleJobOutput', () => {
    const params = buildRewriteRequest(articleJob, SYSTEM);
    assert.equal(params.output_config?.format?.type, 'json_schema');
    const schema = schemaOf(params);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['headline', 'standfirst', 'bodyHtml', 'captions', 'progress']);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(properties.standfirst?.type, ['string', 'null']);
    assert.deepEqual(properties.captions, { type: 'array', items: { type: 'string' } });
  });

  it('sends a closed json_schema matching PreviewJobOutput', () => {
    const schema = schemaOf(buildRewriteRequest(previewJob, SYSTEM));
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['headline', 'trail', 'progress', 'upside']);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(properties.trail?.type, ['string', 'null']);
  });

  it('labels every section of the job input and never prefills the assistant turn', () => {
    const params = buildRewriteRequest(articleJob, SYSTEM);
    assert.equal(params.messages.length, 1);
    assert.equal(params.messages[0]?.role, 'user');
    const content = params.messages[0]?.content;
    assert.equal(typeof content, 'string');
    const text = String(content);
    assert.match(text, /KIND: article/);
    assert.match(text, /HEADLINE:\nOriginal headline/);
    assert.match(text, /STANDFIRST:\nOriginal standfirst/);
    assert.match(text, /CAPTIONS \(1\):\n1\. Cap one/);
    assert.match(text, /BODY HTML:\n<p>One<\/p>/);
  });

  it('marks absent optional fields rather than dropping the label', () => {
    const bare: Job = {
      id: 'p:/x',
      kind: 'preview',
      path: '/x',
      input: { headline: 'Just a headline' },
    };
    const text = String(buildRewriteRequest(bare, SYSTEM).messages[0]?.content);
    assert.match(text, /TRAIL:\n\(none\)/);
  });

  it('takes a model override', () => {
    assert.equal(buildRewriteRequest(articleJob, SYSTEM, 'claude-opus-5').model, 'claude-opus-5');
    assert.equal(rewriteModel({ OPTIMIST_REWRITE_MODEL: 'claude-opus-5' }), 'claude-opus-5');
    assert.equal(rewriteModel({}), REWRITE_MODEL);
    assert.equal(checkModel({ OPTIMIST_CHECK_MODEL: 'claude-haiku-9' }), 'claude-haiku-9');
    assert.equal(checkModel({}), CHECK_MODEL);
  });
});

describe('buildCheckRequest', () => {
  it('runs the check model with no thinking and a closed schema', () => {
    const params = buildCheckRequest('ORIGINAL TEXT', 'REWRITE TEXT', 'CHECK PROMPT');
    assert.equal(params.model, CHECK_MODEL);
    assert.equal(params.thinking, undefined, 'Haiku 4.5 does not take adaptive thinking');
    assert.equal(params.system, 'CHECK PROMPT');
    const schema = params.output_config?.format?.schema as Record<string, unknown>;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['ok', 'issues']);
    const text = String(params.messages[0]?.content);
    assert.match(text, /ORIGINAL:\nORIGINAL TEXT/);
    assert.match(text, /REWRITE:\nREWRITE TEXT/);
  });
});

describe('parseRewriteOutput', () => {
  const valid = {
    headline: 'New headline',
    standfirst: 'New standfirst',
    bodyHtml: '<p>One</p>',
    captions: ['New cap'],
  };

  it('accepts a valid article payload', () => {
    const result = parseRewriteOutput(articleJob, JSON.stringify(valid));
    assert.ok(!('error' in result), 'should not be an error result');
    assert.equal(result.id, articleJob.id);
    assert.equal(result.kind, 'article');
    assert.deepEqual(result.output, valid);
  });

  it('maps a null standfirst to undefined rather than null', () => {
    const result = parseRewriteOutput(articleJob, JSON.stringify({ ...valid, standfirst: null }));
    assert.ok(!('error' in result));
    assert.ok(!('standfirst' in result.output), 'the key should be absent, not null');
  });

  it('maps a null trail to undefined', () => {
    const result = parseRewriteOutput(previewJob, JSON.stringify({ headline: 'Card', trail: null }));
    assert.ok(!('error' in result));
    assert.deepEqual(result.output, { headline: 'Card' });
  });

  it('keeps a preview\'s progress line and upside score, and rejects an out-of-range score', () => {
    const result = parseRewriteOutput(
      previewJob,
      JSON.stringify({ headline: 'Card', trail: null, progress: ' Councils act. ', upside: 2 }),
    );
    assert.ok(!('error' in result));
    assert.deepEqual(result.output, { headline: 'Card', progress: 'Councils act.', upside: 2 });
    const bad = parseRewriteOutput(previewJob, JSON.stringify({ headline: 'Card', trail: null, upside: 5 }));
    assert.ok('error' in bad);
  });

  it('rejects a missing key', () => {
    const { standfirst, ...missing } = valid;
    const result = parseRewriteOutput(articleJob, JSON.stringify(missing));
    assert.ok('error' in result);
    assert.match(result.error, /standfirst/);
    assert.equal(result.kind, 'article');
    assert.equal(result.id, articleJob.id);
  });

  it('rejects captions of the wrong length', () => {
    const tooMany = parseRewriteOutput(articleJob, JSON.stringify({ ...valid, captions: ['a', 'b'] }));
    assert.ok('error' in tooMany);
    assert.match(tooMany.error, /expected 1 caption, got 2/);

    const tooFew = parseRewriteOutput(articleJob, JSON.stringify({ ...valid, captions: [] }));
    assert.ok('error' in tooFew);
    assert.match(tooFew.error, /expected 1 caption, got 0/);
  });

  it('rejects text that is not JSON', () => {
    const result = parseRewriteOutput(articleJob, 'Here is your rewrite!');
    assert.ok('error' in result);
    assert.match(result.error, /did not return JSON/);
  });

  it('rejects a wrongly typed field', () => {
    const result = parseRewriteOutput(articleJob, JSON.stringify({ ...valid, captions: 'one caption' }));
    assert.ok('error' in result);
    assert.match(result.error, /captions/);
  });
});

describe('parseCheckOutput', () => {
  it('accepts a valid payload', () => {
    assert.deepEqual(parseCheckOutput('/p', '{"ok":true,"issues":[]}'), {
      path: '/p',
      ok: true,
      issues: [],
    });
  });

  it('fails closed on unreadable output', () => {
    const result = parseCheckOutput('/p', 'not json');
    assert.equal(result.ok, false);
    assert.equal(result.issues.length, 1);
  });
});

describe('batchCustomId', () => {
  it('turns a job id into something the Batches API accepts', () => {
    const id = batchCustomId(articleJob, 0);
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.match(id, /world/);
  });

  it('stays unique for long ids that share a prefix', () => {
    const long = (suffix: string): Job => ({
      ...articleJob,
      id: `a:/business/2026/sep/24/a-very-long-guardian-slug-that-runs-past-the-limit-${suffix}`,
    });
    const ids = [long('one'), long('two')].map((job, index) => batchCustomId(job, index));
    assert.notEqual(ids[0], ids[1]);
    for (const id of ids) assert.ok(id.length <= 64);
  });

  it('passes an already-safe id through unchanged', () => {
    assert.equal(batchCustomId({ ...articleJob, id: 'job_1' }, 3), 'job_1');
  });
});

describe('usage and cost', () => {
  it('adds up usage across responses, tolerating nulls', () => {
    const totals = emptyTotals();
    addUsage(totals, {
      input_tokens: 100,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: null,
      output_tokens: 50,
    });
    addUsage(totals, { input_tokens: 10, output_tokens: 5 });
    addUsage(totals, null);
    assert.deepEqual(totals, { input: 110, cacheRead: 2000, cacheWrite: 0, output: 55 });
  });

  it('costs a million of each token at the batch price table', () => {
    const cost = estimateCostUsd(
      { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 },
      SONNET_5_BATCH_PRICES,
    );
    // $1 in + $0.10 cache read + $1.25 cache write + $5 out
    assert.equal(cost, 7.35);
  });
});

describe('messageText', () => {
  it('concatenates text blocks and ignores thinking', () => {
    const text = messageText({
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: '{"a":', citations: null },
        { type: 'text', text: '1}', citations: null },
      ],
    } as never);
    assert.equal(text, '{"a":1}');
  });
});

/* ---------- Batch plumbing, against a fake client ---------- */

function succeeded(customId: string, body: unknown) {
  return {
    custom_id: customId,
    result: {
      type: 'succeeded' as const,
      message: {
        content: [{ type: 'text', text: JSON.stringify(body) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      },
    },
  };
}

function errored(customId: string) {
  return {
    custom_id: customId,
    result: {
      type: 'errored' as const,
      error: { type: 'error', request_id: null, error: { type: 'invalid_request_error', message: 'too long' } },
    },
  };
}

function fakeBatchClient(lines: unknown[]) {
  return {
    messages: {
      batches: {
        create: async () => ({ id: 'batch_1', processing_status: 'in_progress', request_counts: {} }),
        retrieve: async () => ({ id: 'batch_1', processing_status: 'ended', request_counts: {} }),
        results: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const line of lines) yield line;
          },
        }),
      },
    },
  } as never;
}

describe('collectBatchResults', () => {
  const jobs = [articleJob, previewJob];
  const ids = jobs.map((job, index) => batchCustomId(job, index));

  it('keys results by custom_id whatever order they arrive in', async () => {
    const client = fakeBatchClient([
      succeeded(String(ids[1]), { headline: 'Card rewrite', trail: 'Trail rewrite' }),
      succeeded(String(ids[0]), {
        headline: 'Article rewrite',
        standfirst: null,
        bodyHtml: '<p>One</p>',
        captions: ['Cap'],
      }),
    ]);

    const totals = emptyTotals();
    const results = await collectBatchResults(client, 'batch_1', buildLookup(jobs), totals);

    assert.equal(results.length, 2);
    // Results came back reversed; each one still carries its own job's id.
    assert.equal(results[0]?.id, previewJob.id);
    assert.equal(results[1]?.id, articleJob.id);
    const article = results[1];
    assert.ok(article && !('error' in article));
    assert.equal(article.kind, 'article');
    assert.deepEqual(article.output, {
      headline: 'Article rewrite',
      bodyHtml: '<p>One</p>',
      captions: ['Cap'],
    });
    assert.deepEqual(totals, { input: 20, cacheRead: 10, cacheWrite: 0, output: 40 });
  });

  it('turns an errored line into an error result and ignores unknown ids', async () => {
    const warnings: string[] = [];
    const client = fakeBatchClient([
      errored(String(ids[0])),
      succeeded('not-one-of-ours', { headline: 'x', trail: null }),
    ]);

    const results = await collectBatchResults(client, 'batch_1', buildLookup(jobs), emptyTotals(), (line) =>
      warnings.push(line),
    );

    assert.equal(results.length, 1);
    const only = results[0];
    assert.ok(only && 'error' in only);
    assert.equal(only.id, articleJob.id);
    assert.equal(only.kind, 'article');
    assert.match(only.error, /invalid_request_error: too long/);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /not-one-of-ours/);
  });

  it('treats expiry, cancellation and truncation as errors', () => {
    const expired = resultForResponse(articleJob, {
      custom_id: 'x',
      result: { type: 'expired' },
    } as never);
    assert.ok('error' in expired && /expired/.test(expired.error));

    const canceled = resultForResponse(articleJob, {
      custom_id: 'x',
      result: { type: 'canceled' },
    } as never);
    assert.ok('error' in canceled && /canceled/.test(canceled.error));

    const truncated = resultForResponse(articleJob, {
      custom_id: 'x',
      result: {
        type: 'succeeded',
        message: { content: [{ type: 'text', text: '{' }], stop_reason: 'max_tokens', usage: {} },
      },
    } as never);
    assert.ok('error' in truncated && /max_tokens/.test(truncated.error));
  });
});

describe('toBatchRequests', () => {
  it('builds one request per job with a unique custom_id', () => {
    const requests = toBatchRequests([articleJob, previewJob], SYSTEM);
    assert.equal(requests.length, 2);
    assert.equal(new Set(requests.map((request) => request.custom_id)).size, 2);
    assert.equal(requests[0]?.params.max_tokens, ARTICLE_MAX_TOKENS);
    assert.equal(requests[1]?.params.max_tokens, PREVIEW_MAX_TOKENS);
  });
});

describe('runSequential (--no-batch)', () => {
  it('sends one request per job and records a per-job failure without stopping', async () => {
    const sent: string[] = [];
    const client = {
      messages: {
        create: async (params: { max_tokens: number }) => {
          sent.push(String(params.max_tokens));
          if (sent.length === 1) throw new Error('overloaded');
          return {
            content: [{ type: 'text', text: JSON.stringify({ headline: 'Card', trail: null }) }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 7, output_tokens: 3 },
          };
        },
      },
    } as never;

    const totals = emptyTotals();
    const results = await runSequential(
      client,
      [articleJob, previewJob],
      SYSTEM,
      REWRITE_MODEL,
      totals,
      () => {},
    );

    assert.deepEqual(sent, [String(ARTICLE_MAX_TOKENS), String(PREVIEW_MAX_TOKENS)]);
    assert.equal(results.length, 2);
    const first = results[0];
    assert.ok(first && 'error' in first);
    assert.match(first.error, /overloaded/);
    const second = results[1];
    assert.ok(second && !('error' in second));
    assert.deepEqual(second.output, { headline: 'Card' });
    assert.equal(totals.input, 7);
  });
});

describe('buildLookup', () => {
  it('resolves a resumed batch through the recorded custom_id map', () => {
    const record = {
      id: 'batch_1',
      date: '2026-09-24',
      model: REWRITE_MODEL,
      createdAt: '2026-09-24T00:00:00.000Z',
      jobCount: 2,
      customIds: { 'legacy-custom-id': previewJob.id },
    };
    const lookup = buildLookup([articleJob], [articleJob, previewJob], record);
    assert.equal(lookup('legacy-custom-id')?.id, previewJob.id);
    assert.equal(lookup(batchCustomId(articleJob, 0))?.id, articleJob.id);
    assert.equal(lookup('nope'), undefined);
  });
});

describe('buildRewriteRequest with a revision', () => {
  const params = buildRewriteRequest(previewJob, SYSTEM, 'claude-sonnet-5', {
    previous: { headline: 'Bleak headline', trail: 'Trail' },
    notes: ['Editor: "bleak" is the centre of gravity'],
  });
  const content = params.messages[0]?.content;

  it('keeps the original copy and appends the previous attempt and the notes', () => {
    assert.equal(typeof content, 'string');
    assert.match(String(content), /HEADLINE:\nCard headline/);
    assert.match(String(content), /YOUR PREVIOUS ATTEMPT/);
    assert.match(String(content), /"Bleak headline"/);
    assert.match(String(content), /- Editor: "bleak" is the centre of gravity/);
  });

  it('leaves the cached system prompt untouched', () => {
    assert.deepEqual(params.system, buildRewriteRequest(previewJob, SYSTEM, 'claude-sonnet-5').system);
  });
});

describe('buildToneRequest', () => {
  const params = buildToneRequest('ORIG', 'NEW', 'RUBRIC', 'claude-sonnet-5');

  it('caches the rubric, thinks at low effort and returns the verdict schema', () => {
    assert.ok(Array.isArray(params.system));
    assert.deepEqual(params.system[0]?.cache_control, { type: 'ephemeral' });
    assert.equal(params.max_tokens, TONE_MAX_TOKENS);
    assert.deepEqual(params.thinking, { type: 'adaptive' });
    assert.equal(params.output_config?.effort, 'low');
    assert.equal(params.messages[0]?.content, 'ORIGINAL:\nORIG\n\nREWRITE:\nNEW');
  });
});
