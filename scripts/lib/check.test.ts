import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Job, ResultsFile } from '../../src/lib/types.js';
import { buildPairs, checkOne, mapWithConcurrency } from '../check.js';

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

  it('pairs only article jobs that have a successful rewrite', () => {
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]?.path, articleJob.path);
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
  const pair = { path: '/p', original: 'ORIGINAL', rewrite: 'REWRITE' };

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
    const result = await checkOne(client, pair, 'claude-haiku-4-5');
    assert.deepEqual(result, { path: '/p', ok: false, issues: ['40 became 14'] });
  });

  it('fails closed when the call throws', async () => {
    const client = {
      messages: {
        create: async () => {
          throw new Error('socket hang up');
        },
      },
    } as never;
    const result = await checkOne(client, pair, 'claude-haiku-4-5');
    assert.equal(result.ok, false);
    assert.match(String(result.issues[0]), /socket hang up/);
  });
});
