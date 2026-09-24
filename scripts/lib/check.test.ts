import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Job, ResultsFile } from '../../src/lib/types.js';
import { buildPairs, checkOne, mapWithConcurrency, mergeChecks } from '../check.js';

const articleJob: Job = {
  id: 'a:/world/2026/sep/24/one',
  kind: 'article',
  path: '/world/2026/sep/24/one',
  input: {
    headline: 'Forty die in flood',
    standfirst: 'Rescue teams reach the valley',
    bodyHtml: '<p>Forty people <strong>died</strong>.</p><figure><figcaption>A boat</figcaption></figure>',
    captions: ['A boat'],
  },
};

const failedJob: Job = {
  id: 'a:/world/2026/sep/24/two',
  kind: 'article',
  path: '/world/2026/sep/24/two',
  input: { headline: 'Second story', bodyHtml: '<p>Body</p>', captions: [] },
};

const previewJob: Job = {
  id: 'p:/world/2026/sep/24/one',
  kind: 'preview',
  path: '/world/2026/sep/24/one',
  input: { headline: 'Card', trail: 'Trail' },
};

const results: ResultsFile = {
  date: '2026-09-24',
  engine: 'api',
  results: [
    {
      id: articleJob.id,
      kind: 'article',
      output: {
        headline: 'Rescue teams reach valley where 40 died',
        standfirst: 'Crews arrive after flood',
        bodyHtml: '<p>Forty people died.</p>',
        captions: ['A rescue boat'],
      },
    },
    { id: failedJob.id, kind: 'article', error: 'model did not return JSON' },
    { id: previewJob.id, kind: 'preview', output: { headline: 'Card rewrite' } },
  ],
};

describe('buildPairs', () => {
  const pairs = buildPairs([articleJob, failedJob, previewJob], results);

  it('pairs every job that has a successful rewrite, articles and previews', () => {
    assert.deepEqual(
      pairs.map((pair) => [pair.kind, pair.path]),
      [
        ['article', articleJob.path],
        ['preview', previewJob.path],
      ],
    );
  });

  it('pairs a preview as headline + trail', () => {
    const pair = pairs[1];
    assert.ok(pair);
    assert.equal(pair.original, 'Card\n\nTrail');
    assert.equal(pair.rewrite, 'Card rewrite');
  });

  it('strips tags from both sides', () => {
    const pair = pairs[0];
    assert.ok(pair);
    assert.ok(!pair.original.includes('<'), 'original should be plain text');
    assert.ok(!pair.rewrite.includes('<'), 'rewrite should be plain text');
    assert.match(pair.original, /Forty people died\./);
    assert.match(pair.original, /Rescue teams reach the valley/);
    assert.match(pair.rewrite, /Rescue teams reach valley where 40 died/);
  });
});

describe('mapWithConcurrency', () => {
  it('keeps result order and never exceeds the limit', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    let inFlight = 0;
    let peak = 0;
    const doubled = await mapWithConcurrency(items, 4, async (value) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return value * 2;
    });
    assert.deepEqual(doubled, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
    assert.ok(peak > 1, 'should actually run in parallel');
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  });
});

describe('checkOne', () => {
  const pair = { path: '/p', kind: 'article' as const, original: 'ORIGINAL', rewrite: 'REWRITE' };
  const factsOnly = { checkModel: 'claude-haiku-4-5' };
  const both = { checkModel: 'claude-haiku-4-5', tone: { model: 'claude-sonnet-5', systemPrompt: 'TONE' } };

  it('reads a structured verdict back', async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '{"ok":false,"issues":["40 became 14"]}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      },
    } as never;
    const result = await checkOne(client, pair, factsOnly);
    assert.deepEqual(result, { path: '/p', kind: 'article', ok: false, issues: ['40 became 14'] });
  });

  it('runs the tone review on the same pair and keeps the two verdicts apart', async () => {
    const client = {
      messages: {
        create: async (params: { model: string; system: unknown }) => ({
          content: [
            {
              type: 'text',
              text:
                params.model === 'claude-sonnet-5'
                  ? '{"ok":false,"issues":["headline is centred on bleak"]}'
                  : '{"ok":true,"issues":[]}',
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      },
    } as never;
    const result = await checkOne(client, pair, both);
    assert.equal(result.ok, true);
    assert.deepEqual(result.tone, { ok: false, issues: ['headline is centred on bleak'] });
  });

  it('fails closed when the call throws', async () => {
    const client = {
      messages: {
        create: async () => {
          throw new Error('socket hang up');
        },
      },
    } as never;
    const result = await checkOne(client, pair, both);
    assert.equal(result.ok, false);
    assert.match(String(result.issues[0]), /socket hang up/);
    assert.equal(result.tone?.ok, false);
  });
});

describe('mergeChecks', () => {
  it('replaces re-run verdicts by kind and path, keeps the rest', () => {
    const previous = [
      { path: '/a', kind: 'article' as const, ok: true, issues: [] },
      { path: '/a', kind: 'preview' as const, ok: false, issues: ['x'] },
      { path: '/b', ok: true, issues: [] },
    ];
    const fresh = [{ path: '/a', kind: 'preview' as const, ok: true, issues: [] }];
    const merged = mergeChecks(previous, fresh);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged[1], fresh[0]);
    assert.deepEqual(merged[2], previous[2]);
  });
});
