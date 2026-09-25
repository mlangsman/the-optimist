import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CheckResult, Job, ResultsFile } from '../../src/lib/types.js';
import { HIGHLIGHTS_ID, aboveFloor, assemble, indexChecks, rankByUpside, resolveContext, selectForFront } from '../assemble.js';
import { collectRevisions } from '../revise.js';
import { lintResults } from '../tone.js';
import { doomTerms, hasSetback, lintArticle, lintPreview, overlap, setbackTerms, withoutQuotes } from './tone.js';

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
    // '/s' is the strong card that lets the weaker '/p' run beneath it.
    front: [{ id: 'news', title: 'News', cards: [{ path: '/s' }, { path: '/p' }] }],
    articles: {},
    previews: {
      '/s': { path: '/s', url: 'https://www.theguardian.com/s', section: { id: 's', name: 'S' }, headline: 'Strong', tags: [] },
      '/p': { path: '/p', url: 'https://www.theguardian.com/p', section: { id: 's', name: 'S' }, headline: 'Original', trail: 'Original trail', tags: [] },
    },
  };
  const results: ResultsFile = {
    date: '2026-09-24',
    engine: 'api',
    results: [
      { id: 'p:/s', kind: 'preview', output: { headline: 'Strong rewrite', upside: 3 } },
      { id: 'p:/p', kind: 'preview', output: { headline: 'Rewritten', trail: 'New trail', upside: 2 } },
    ],
  };

  it('falls back to the original when a preview fails its fact check, but not its tone review', () => {
    const facts = assemble(raw, results, [{ path: '/p', kind: 'preview', ok: false, issues: ['invented'] }]);
    assert.equal(facts.front[0]?.cards[1]?.headline, 'Original');
    assert.equal(facts.front[0]?.cards[1]?.trail, 'Original trail');

    const tone = assemble(raw, results, [{ path: '/p', kind: 'preview', ok: true, issues: [], tone: { ok: false, issues: ['bleak'] } }]);
    assert.equal(tone.front[0]?.cards[1]?.headline, 'Rewritten');
  });

  it('leaves a dropped story out of the front and removes a container left empty', () => {
    const twoContainers = {
      ...raw,
      front: [
        { id: 'news', title: 'News', cards: [{ path: '/s' }, { path: '/p' }, { path: '/q' }] },
        { id: 'opinion', title: 'Opinion', cards: [{ path: '/p' }] },
      ],
    };
    const site = assemble(twoContainers, results, [], new Set(['/p']));
    assert.deepEqual(site.front.map((container) => container.id), ['news']);
    // '/q' has no rewrite and so no score; it counts as 1 and runs beneath the strong card.
    assert.deepEqual(site.front[0]?.cards.map((card) => card.path), ['/s', '/q']);
  });

  it('keeps an article-kind failure away from the preview of the same path', () => {
    const failures = indexChecks([{ path: '/p', ok: false, issues: ['x'] }]);
    assert.ok(failures.article.has('/p'));
    assert.ok(!failures.preview.has('/p'));
  });
});

describe('headline length', () => {
  it('warns on a long rewrite of a shorter headline, not on a short one', () => {
    const job = preview('/p', 'Tactical voting could push Reform into fourth place, poll finds');
    const long = lintPreview(job, {
      headline: 'Andy Burnham begins to win progressives back to Labour, and tactical voting could put a majority within touching distance, poll finds',
    });
    assert.ok(long.some((issue) => issue.severity === 'warning' && /words/.test(issue.issue)));
    const short = lintPreview(job, { headline: 'Progressives return to Labour under Andy Burnham, poll finds' });
    assert.ok(!short.some((issue) => /words/.test(issue.issue)));
  });
});

describe('rankByUpside', () => {
  const card = (path: string, upside?: number) => ({
    path,
    linked: false,
    headline: path,
    original: { headline: path, url: 'u' },
    ...(upside === undefined ? {} : { upside }),
  });

  it('puts the strongest upside first, counts an unscored card as 1 and keeps the original order on ties', () => {
    const ranked = rankByUpside([card('/a', 1), card('/b', 3), card('/c'), card('/d', 3), card('/e', 0)]);
    assert.deepEqual(ranked.map((c) => c.path), ['/b', '/d', '/a', '/c', '/e']);
  });
});

describe('assemble with going-right picks', () => {
  const candidate = {
    path: '/g',
    url: 'https://www.theguardian.com/g',
    section: { id: 'science', name: 'Science' },
    headline: 'Original good news',
    trail: 'Original trail',
    tags: [],
  };
  const raw = {
    date: '2026-09-24',
    fetchedAt: 'now',
    front: [
      { id: 'news', title: 'News', cards: [{ path: '/p' }, { path: '/q' }] },
      { id: 'opinion', title: 'Opinion', cards: [{ path: '/q' }] },
    ],
    articles: {},
    previews: {
      '/p': { path: '/p', url: 'https://www.theguardian.com/p', section: { id: 's', name: 'S' }, headline: 'P', tags: [] },
      '/q': { path: '/q', url: 'https://www.theguardian.com/q', section: { id: 's', name: 'S' }, headline: 'Q', tags: [] },
    },
    candidates: { '/g': candidate },
  };
  const results: ResultsFile = {
    date: '2026-09-24',
    engine: 'claude-code',
    results: [
      { id: 'p:/p', kind: 'preview', output: { headline: 'P2', upside: 1 } },
      { id: 'p:/q', kind: 'preview', output: { headline: 'Q2', upside: 3, progress: 'Councils are rebuilding.' } },
      { id: 'p:/g', kind: 'preview', output: { headline: 'G2', trail: 'T2', upside: 3 } },
    ],
  };

  it('ranks each container, carries the progress line and inserts the picks second', () => {
    const site = assemble(raw, results, [], new Set(), ['/g', '/unknown']);
    assert.deepEqual(site.front.map((c) => c.id), ['news', 'going-right', 'opinion']);
    assert.deepEqual(site.front[0]?.cards.map((c) => c.path), ['/q', '/p']);
    assert.equal(site.front[0]?.cards[0]?.progress, 'Councils are rebuilding.');
    const pick = site.front[1]?.cards[0];
    assert.equal(pick?.headline, 'G2');
    assert.equal(pick?.kicker, 'Science');
    assert.equal(pick?.original.headline, 'Original good news');
  });

  it('adds no container without picks, and leaves out a dropped pick', () => {
    assert.ok(!assemble(raw, results, []).front.some((c) => c.id === 'going-right'));
    assert.ok(!assemble(raw, results, [], new Set(['/g']), ['/g']).front.some((c) => c.id === 'going-right'));
  });
});

describe('setback terms and score consistency', () => {
  it('warns on a headline whose object is the setback, whole-word and outside quotes', () => {
    assert.deepEqual(setbackTerms('BBC cuts local specialist correspondent roles'), ['cuts']);
    assert.deepEqual(setbackTerms("UK's flagship AI supercomputer project may slip to the mid-2030s"), ['slip']);
    assert.deepEqual(setbackTerms('Family speaks out about years-long wait for diagnosis'), ['wait']);
    assert.deepEqual(setbackTerms("Leaked figures reveal scale of England's ADHD diagnosis surge"), ['surge']);
    assert.deepEqual(setbackTerms('Minister says ‘cuts are off the table’'), []);
    assert.deepEqual(setbackTerms('Scientists cutlass through the data'), []);
  });

  it('is a warning, not an error, so a cut in a harm can still pass', () => {
    const job = preview('/x', 'Council slashes budget as deficit grows', 'Critics react');
    const issues = lintPreview(job, { headline: 'City cuts air pollution by a third in a year', trail: 'Deficit remains', upside: 3 });
    const setback = issues.filter((issue) => /setback as its subject/.test(issue.issue));
    assert.equal(setback.length, 1);
    assert.equal(setback[0]?.severity, 'warning');
    assert.ok(!issues.some((issue) => issue.severity === 'error'));
  });

  it('warns when a 0 carries a progress line, and when a 3 is built on doom', () => {
    const job = preview('/x', 'Council warns of cuts', 'Trail');
    const zero = lintPreview(job, { headline: 'Council sets out its spending plan', upside: 0, progress: 'The council is consulting residents.' });
    assert.ok(zero.some((issue) => /upside is 0 but the progress line/.test(issue.issue) && issue.severity === 'warning'));
    const three = lintPreview(job, { headline: 'Council warns residents of cuts', upside: 3 });
    assert.ok(three.some((issue) => /upside is 3 but the headline/.test(issue.issue)));
    const fine = lintPreview(job, { headline: 'Council sets out its spending plan', upside: 1, progress: 'The council is consulting residents.' });
    assert.ok(!fine.some((issue) => /upside is/.test(issue.issue)));
  });
});

describe('selectForFront', () => {
  const card = (path: string, upside?: number) => ({
    path,
    linked: false,
    headline: path,
    original: { headline: path, url: `https://www.theguardian.com${path}` },
    ...(upside === undefined ? {} : { upside }),
  });

  it('drops every 0, and keeps a 1 only beneath something stronger', () => {
    const report = { belowFloor: 0, weak: 0 };
    const kept = selectForFront('news', [card('/zero', 0), card('/one', 1), card('/two', 2), card('/unscored')], report);
    assert.deepEqual(kept.map((c) => c.path), ['/two', '/one', '/unscored']);
    assert.deepEqual(report, { belowFloor: 1, weak: 0 });
  });

  it('empties a container that has nothing stronger than a 1, and counts what it left out', () => {
    const report = { belowFloor: 0, weak: 0 };
    assert.deepEqual(selectForFront('uk-news', [card('/one', 1), card('/zero', 0), card('/x')], report), []);
    assert.deepEqual(report, { belowFloor: 1, weak: 2 });
  });

  it('never runs a 1 in the highlights strip, even beneath a 3', () => {
    const kept = selectForFront(HIGHLIGHTS_ID, [card('/one', 1), card('/three', 3)]);
    assert.deepEqual(kept.map((c) => c.path), ['/three']);
  });

  it('aboveFloor keeps everything but a 0', () => {
    assert.deepEqual(aboveFloor([card('/a', 0), card('/b', 1), card('/c')]).map((c) => c.path), ['/b', '/c']);
  });
});

describe('assemble with the floor', () => {
  const article = {
    path: '/a',
    url: 'https://www.theguardian.com/a',
    section: { id: 'society', name: 'Society' },
    publishedAt: '2026-09-24T06:00:00Z',
    headline: 'NHS bodies impose two-year wait',
    trail: 'Patient groups decry delays',
    bodyHtml: '<p>Body</p>',
    tags: [],
    related: [
      { path: '/r0', url: 'https://www.theguardian.com/r0', section: { id: 's', name: 'S' }, headline: 'Grim related' },
      { path: '/r2', url: 'https://www.theguardian.com/r2', section: { id: 's', name: 'S' }, headline: 'Better related' },
    ],
  };
  const raw = {
    date: '2026-09-24',
    fetchedAt: 'now',
    front: [
      { id: 'highlights', title: 'Highlights', cards: [{ path: '/a' }] },
      { id: 'news', title: 'News', cards: [{ path: '/a' }, { path: '/b' }] },
    ],
    articles: { '/a': article },
    previews: {
      '/b': { path: '/b', url: 'https://www.theguardian.com/b', section: { id: 's', name: 'S' }, headline: 'B', tags: [] },
    },
    candidates: {
      '/g': { path: '/g', url: 'https://www.theguardian.com/g', section: { id: 'science', name: 'Science' }, headline: 'G', tags: [] },
    },
  };
  const context = {
    '/a': [
      {
        path: '/c',
        url: 'https://www.theguardian.com/c',
        headline: 'Ministers fund 200 more assessors',
        publishedAt: '2026-08-01T00:00:00Z',
        excerpt: 'Ministers have funded 200 more assessors.',
      },
    ],
  };
  const results: ResultsFile = {
    date: '2026-09-24',
    engine: 'claude-code',
    results: [
      // The preview scored the story 0 from its trail; the article, from the body, scored it 2.
      { id: 'p:/a', kind: 'preview', output: { headline: 'A card', upside: 0 } },
      {
        id: 'a:/a',
        kind: 'article',
        output: {
          headline: 'A article',
          bodyHtml: '<p>Rewritten</p>',
          captions: [],
          upside: 2,
          context: { text: 'Ministers have funded 200 more assessors.', sourceUrl: 'https://www.theguardian.com/c' },
        },
      },
      { id: 'p:/b', kind: 'preview', output: { headline: 'B card', upside: 1 } },
      { id: 'p:/r0', kind: 'preview', output: { headline: 'R0', upside: 0 } },
      { id: 'p:/r2', kind: 'preview', output: { headline: 'R2', upside: 2 } },
      { id: 'p:/g', kind: 'preview', output: { headline: 'G card', upside: 0 } },
    ],
  };

  it('lets the article\'s own score win, holds the rails and the picks to the floor, and reports it', () => {
    const report = { belowFloor: 0, weak: 0 };
    const site = assemble(raw, results, [], new Set(), ['/g'], context, report);
    assert.deepEqual(site.front.map((c) => c.id), ['highlights', 'news']);
    assert.equal(site.front[0]?.cards[0]?.upside, 2);
    assert.deepEqual(site.front[1]?.cards.map((c) => c.path), ['/a', '/b']);
    assert.deepEqual(site.articles['/a']?.related.map((c) => c.path), ['/r2']);
    assert.ok(!site.front.some((c) => c.id === 'going-right'), 'a pick scoring 0 is not good news');
    assert.deepEqual(report, { belowFloor: 2, weak: 0 });
  });

  it('carries a cited context line onto the article, with the source headline, and drops an uncited one', () => {
    const site = assemble(raw, results, [], new Set(), [], context);
    assert.deepEqual(site.articles['/a']?.context, {
      text: 'Ministers have funded 200 more assessors.',
      sourceUrl: 'https://www.theguardian.com/c',
      sourceHeadline: 'Ministers fund 200 more assessors',
    });
    assert.equal(assemble(raw, results, [], new Set(), []).articles['/a']?.context, undefined);
    assert.equal(resolveContext({ text: '  ', sourceUrl: 'https://www.theguardian.com/c' }, context['/a']), undefined);
  });
});
