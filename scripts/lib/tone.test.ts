import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CheckResult, Job, ResultsFile } from '../../src/lib/types.js';
import { assemble, indexChecks } from '../assemble.js';
import { collectRevisions } from '../revise.js';
import { lintResults } from '../tone.js';
import { doomTerms, hasSetback, lintArticle, lintPreview, overlap, withoutQuotes } from './tone.js';

const preview = (path: string, headline: string, trail?: string): Extract<Job, { kind: 'preview' }> => ({
  id: `p:${path}`,
  kind: 'preview',
  path,
  input: { headline, ...(trail === undefined ? {} : { trail }) },
});

describe('doomTerms', () => {
  it('finds the writer\'s own verdict words, whole-word only', () => {
    assert.deepEqual(doomTerms('A bleak opportunity, ministers warn'), ['bleak', 'warn']);
    assert.deepEqual(doomTerms('Rowing club opens new boathouse'), []);
    assert.deepEqual(doomTerms('Cabinet row over spending'), ['row']);
  });

  it('exempts quotations and house-style compounds', () => {
    assert.deepEqual(doomTerms('Minister calls plan ‘a bleak day for Britain’'), []);
    assert.deepEqual(doomTerms("Minister calls plan 'a bleak day' and warns of more"), ['warns']);
    assert.deepEqual(doomTerms('Climate crisis report published'), []);
    assert.deepEqual(doomTerms('Housing crisis report published'), ['crisis']);
  });

  it('drops an unclosed quote to the end of the line', () => {
    assert.equal(withoutQuotes('He said ‘this is bleak').trim(), 'He said');
  });
});

describe('overlap', () => {
  it('is 1 for the same words and near 1 for a one-word swap', () => {
    assert.equal(overlap('a b c', 'c b a'), 1);
    const original = 'UK interest rates ‘increasingly likely to rise’ if energy prices remain high, Bank of England’s Lombardelli warns';
    const rewrite = 'UK interest rates ‘increasingly likely to rise’ if energy prices remain high, Bank of England’s Lombardelli says';
    assert.ok(overlap(original, rewrite) > 0.9);
  });

  it('is low for a genuine re-angle', () => {
    assert.ok(
      overlap('Thousands of jobs at risk as steelworks faces closure', 'Steelworks talks continue as unions and ministers seek rescue deal') < 0.5,
    );
  });
});

describe('lintPreview', () => {
  it('rejects a cosmetic edit of a setback headline', () => {
    const job = preview('/a', 'Bank of England’s Lombardelli warns rates likely to rise if energy prices stay high');
    const issues = lintPreview(job, { headline: 'Bank of England’s Lombardelli says rates likely to rise if energy prices stay high' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.severity, 'error');
    assert.match(issues[0]?.issue ?? '', /cosmetic edit/);
  });

  it('rejects a headline still centred on a doom word', () => {
    const job = preview('/b', 'OpenAI’s Medicare hack is a bleak opportunity for Australia');
    const issues = lintPreview(job, { headline: 'OpenAI’s Medicare hack gives Australia a bleak chance to fix its security' });
    assert.ok(issues.some((issue) => issue.severity === 'error' && /"bleak"/.test(issue.issue)));
  });

  it('only warns about a barely touched recipe', () => {
    const job = preview('/c', 'Rachel Roddy’s tomatoes stuffed with breadcrumbs, chickpeas and herbs – recipe');
    const issues = lintPreview(job, { headline: 'Rachel Roddy’s comforting tomatoes stuffed with breadcrumbs, chickpeas and herbs – recipe' });
    assert.deepEqual(issues.map((issue) => issue.severity), ['warning']);
  });

  it('passes a real re-angle, and warns when the trail leans on fear', () => {
    const job = preview('/d', 'Thousands of jobs at risk as steelworks faces closure', 'Unions fear the worst');
    const clean = lintPreview(job, { headline: 'Steelworks talks continue as unions and ministers seek rescue deal', trail: 'Ministers meet unions' });
    assert.deepEqual(clean, []);
    const leaning = lintPreview(job, { headline: 'Steelworks talks continue as unions and ministers seek rescue deal', trail: 'Unions fear the worst' });
    assert.deepEqual(leaning.map((issue) => [issue.field, issue.severity]), [['trail', 'warning']]);
  });
});

describe('lintArticle', () => {
  it('reads the standfirst and the opening paragraph', () => {
    const job: Extract<Job, { kind: 'article' }> = {
      id: 'a:/e',
      kind: 'article',
      path: '/e',
      input: { headline: 'Floods devastate valley', standfirst: '<p>Forty die</p>', bodyHtml: '<p>Chaos.</p>', captions: [] },
    };
    const issues = lintArticle(job, {
      headline: 'Rescue teams reach valley where 40 died',
      standfirst: 'A grim night',
      bodyHtml: '<p>Chaos reigned as crews arrived.</p>',
      captions: [],
    });
    assert.deepEqual(issues.map((issue) => [issue.field, issue.severity]), [
      ['standfirst', 'warning'],
      ['opening', 'warning'],
    ]);
  });
});

describe('hasSetback and lintResults', () => {
  it('treats a missing rewrite as an error only when the original carried a setback', () => {
    const jobs = [preview('/x', 'Asic warns of deepfake scams'), preview('/y', 'Sign up for the Feast newsletter')];
    const results: ResultsFile = { date: '2026-09-24', engine: 'api', results: [] };
    const issues = lintResults(jobs, results);
    assert.deepEqual(issues.map((issue) => [issue.path, issue.severity]), [
      ['/x', 'error'],
      ['/y', 'warning'],
    ]);
    assert.equal(hasSetback('Sign up'), false);
  });
});

describe('collectRevisions', () => {
  const jobs = [
    preview('/x', 'Deepfake Anthony Albanese used in celebrity scams duping Australians out of $7.4m, Asic warns', 'Trail'),
    preview('/y', 'Fine headline'),
  ];
  const results: ResultsFile = {
    date: '2026-09-24',
    engine: 'api',
    results: [
      { id: 'p:/x', kind: 'preview', output: { headline: 'Deepfake Anthony Albanese used in celebrity scams duping Australians out of $7.4m, Asic says' } },
      { id: 'p:/y', kind: 'preview', output: { headline: 'Fine rewrite' } },
    ],
  };

  it('gathers notes from the fact check, the tone review and lint errors, per job', () => {
    const checks: CheckResult[] = [
      { path: '/x', kind: 'preview', ok: false, issues: ['$7.4m became $7m'], tone: { ok: false, issues: ['cosmetic edit'] } },
      { path: '/y', kind: 'preview', ok: true, issues: [], tone: { ok: true, issues: [] } },
    ];
    const lint = lintResults(jobs, results);
    const revisions = collectRevisions(jobs, results, checks, lint);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.job.id, 'p:/x');
    assert.match(revisions[0]?.revision.previous.headline ?? '', /Asic says$/);
    assert.match(lint[0]?.issue ?? '', /cosmetic edit/);
    assert.deepEqual(revisions[0]?.revision.notes, [
      'Fact check: $7.4m became $7m',
      'Editor: cosmetic edit',
      `Lint (headline): ${lint[0]?.issue}`,
    ]);
  });

  it('never revises a job that passed everything', () => {
    const checks: CheckResult[] = [{ path: '/y', kind: 'preview', ok: true, issues: [], tone: { ok: true, issues: [] } }];
    assert.deepEqual(collectRevisions(jobs, results, checks), []);
  });
});

describe('assemble with preview checks', () => {
  const raw = {
    date: '2026-09-24',
    fetchedAt: 'now',
    front: [{ id: 'news', title: 'News', cards: [{ path: '/p' }] }],
    articles: {},
    previews: {
      '/p': { path: '/p', url: 'https://www.theguardian.com/p', section: { id: 's', name: 'S' }, headline: 'Original', trail: 'Original trail', tags: [] },
    },
  };
  const results: ResultsFile = {
    date: '2026-09-24',
    engine: 'api',
    results: [{ id: 'p:/p', kind: 'preview', output: { headline: 'Rewritten', trail: 'New trail' } }],
  };

  it('falls back to the original when a preview fails its fact check, but not its tone review', () => {
    const facts = assemble(raw, results, [{ path: '/p', kind: 'preview', ok: false, issues: ['invented'] }]);
    assert.equal(facts.front[0]?.cards[0]?.headline, 'Original');
    assert.equal(facts.front[0]?.cards[0]?.trail, 'Original trail');

    const tone = assemble(raw, results, [{ path: '/p', kind: 'preview', ok: true, issues: [], tone: { ok: false, issues: ['bleak'] } }]);
    assert.equal(tone.front[0]?.cards[0]?.headline, 'Rewritten');
  });

  it('leaves a dropped story out of the front and removes a container left empty', () => {
    const twoContainers = {
      ...raw,
      front: [
        { id: 'news', title: 'News', cards: [{ path: '/p' }, { path: '/q' }] },
        { id: 'opinion', title: 'Opinion', cards: [{ path: '/p' }] },
      ],
    };
    const site = assemble(twoContainers, results, [], new Set(['/p']));
    assert.deepEqual(site.front.map((container) => container.id), ['news']);
    assert.deepEqual(site.front[0]?.cards.map((card) => card.path), ['/q']);
  });

  it('keeps an article-kind failure away from the preview of the same path', () => {
    const failures = indexChecks([{ path: '/p', ok: false, issues: ['x'] }]);
    assert.ok(failures.article.has('/p'));
    assert.ok(!failures.preview.has('/p'));
  });
});
