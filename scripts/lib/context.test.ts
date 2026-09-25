import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Job, ResultsFile } from '../../src/lib/types.js';
import { buildPairs } from '../check.js';
import { buildJobs } from '../jobs.js';
import { contextTagQuery, excerptOf } from './guardian-api.js';

const item = {
  path: '/c',
  url: 'https://www.theguardian.com/c',
  headline: 'Ministers fund assessors',
  publishedAt: '2026-08-01T09:00:00Z',
  excerpt: 'Ministers have funded 200 more assessors.',
};

describe('contextTagQuery', () => {
  it('ANDs the first two keyword tags, dropping tone, type, contributor, series and umbrella tags', () => {
    assert.equal(
      contextTagQuery(['society/society', 'society/nhs', 'tone/news', 'type/article', 'profile/anna-bawden', 'society/adhd', 'series/the-long-read', 'society/autism']),
      'society/nhs,society/adhd',
    );
    assert.equal(contextTagQuery(['tone/news', 'type/article', 'uk/uk']), undefined);
    assert.equal(contextTagQuery(['world/iran', 'tone/news']), 'world/iran');
  });
});

describe('excerptOf', () => {
  it('collapses whitespace and cuts at a sentence end inside the cap', () => {
    assert.equal(excerptOf('One.  Two\n\nthree.'), 'One. Two three.');
    const long = `${'Word '.repeat(30)}end. ${'More '.repeat(30)}tail.`;
    const cut = excerptOf(long, 200);
    assert.ok(cut.endsWith('end.'), cut);
    assert.ok(cut.length <= 200);
  });

  it('falls back to a hard cut with an ellipsis when no sentence ends late enough', () => {
    const cut = excerptOf('a'.repeat(400), 100);
    assert.equal(cut.length, 101);
    assert.ok(cut.endsWith('…'));
  });
});

describe('buildJobs with context', () => {
  const raw = {
    date: '2026-09-24',
    fetchedAt: 'now',
    front: [{ id: 'news', title: 'News', cards: [{ path: '/a' }] }],
    articles: {
      '/a': {
        path: '/a',
        url: 'https://www.theguardian.com/a',
        section: { id: 's', name: 'S' },
        publishedAt: 'now',
        headline: 'H',
        bodyHtml: '<p>B</p>',
        tags: [],
        related: [],
      },
    },
    previews: {},
  };

  it('attaches the items to the article job and leaves the key out when there are none', () => {
    const [withItems] = buildJobs(raw, [], { '/a': [item] });
    assert.equal(withItems?.kind, 'article');
    assert.deepEqual(withItems?.kind === 'article' ? withItems.input.context : undefined, [item]);
    const [without] = buildJobs(raw, [], { '/a': [] });
    assert.ok(without?.kind === 'article' && !('context' in without.input));
  });
});

describe('buildPairs with a context line', () => {
  const job: Job = {
    id: 'a:/a',
    kind: 'article',
    path: '/a',
    input: { headline: 'H', bodyHtml: '<p>B</p>', captions: [], context: [item] },
  };
  const output = { headline: 'H2', bodyHtml: '<p>B2</p>', captions: [] as string[] };

  it('puts the cited excerpt in ORIGINAL and the line in REWRITE', () => {
    const results: ResultsFile = {
      date: '2026-09-24',
      engine: 'api',
      results: [{ id: 'a:/a', kind: 'article', output: { ...output, context: { text: 'Ministers funded 200 assessors.', sourceUrl: item.url } } }],
    };
    const [pair] = buildPairs([job], results);
    assert.match(pair?.original ?? '', /CONTEXT SOURCE \(https:\/\/www\.theguardian\.com\/c\): Ministers fund assessors\. Ministers have funded 200 more assessors\./);
    assert.match(pair?.rewrite ?? '', /CONTEXT: Ministers funded 200 assessors\./);
  });

  it('gives an uncited line no source text, so the fact check sees it as unsupported', () => {
    const results: ResultsFile = {
      date: '2026-09-24',
      engine: 'api',
      results: [{ id: 'a:/a', kind: 'article', output: { ...output, context: { text: 'Invented.', sourceUrl: 'https://www.theguardian.com/x' } } }],
    };
    const [pair] = buildPairs([job], results);
    assert.doesNotMatch(pair?.original ?? '', /CONTEXT SOURCE/);
    assert.match(pair?.rewrite ?? '', /CONTEXT: Invented\./);
  });
});
