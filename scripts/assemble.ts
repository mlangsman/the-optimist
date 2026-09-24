/**
 * Step 4 of the pipeline: fold the rewrite results back into the raw front page
 * and write the single file the Astro site reads.
 *
 *   npx tsx scripts/assemble.ts [--date=YYYY-MM-DD]
 *
 * Writes data/<date>/site.json and copies it to data/latest.json.
 */
import { join } from 'node:path';
import type {
  Article,
  ArticleJobOutput,
  Card,
  CheckResult,
  FrontContainer,
  Image,
  Original,
  PreviewJobOutput,
  RawArticle,
  RawCard,
  RawData,
  ResultsFile,
  SiteData,
} from '../src/lib/types.js';
import {
  DATA_DIR,
  dayFile,
  errorMessage,
  maybeHelp,
  parseArgs,
  readJson,
  resolveDate,
  runMain,
  writeJson,
} from './lib/cli.js';
import { pseudonymiseByline } from './lib/bylines.js';
import { webUrlFor } from './lib/guardian-api.js';
import { applyCaptions, stripTags, standfirstText } from './lib/html.js';
import { sanitiseHtml } from './lib/sanitise.js';

const HELP = `
scripts/assemble.ts — build site.json from raw.json + results.json

Usage:
  npx tsx scripts/assemble.ts [options]

Options:
  --date=YYYY-MM-DD   Read/write data/<date>/ instead of today (Europe/London).
  --help              Show this message.

Input:
  data/<date>/raw.json       from scripts/fetch.ts        (required)
  data/<date>/results.json   from the rewrite engine      (required)
  data/<date>/check.json     from scripts/check.ts        (optional)
  data/<date>/drop.json      { "<path>": "reason" }       (optional)

Output:
  data/<date>/site.json      SiteData
  data/latest.json           a copy, which the Astro site reads

Anything without a usable rewrite — a missing result, an engine error, or a
failed fact check — is published headline-only with an empty body. A preview
that failed its fact check falls back to the original headline and trail.
A path listed in drop.json is left out entirely: its front cards, its article
page and any related-rail card pointing at it. A container left with no cards
is removed.
`;

/** Lookup of rewrite outputs by job id, ignoring results that carried an error. */
interface Rewrites {
  article: Map<string, ArticleJobOutput>;
  preview: Map<string, PreviewJobOutput>;
  errors: number;
}

/** Paths whose fact check failed, per job kind. Tone verdicts never gate. */
interface CheckFailures {
  article: ReadonlySet<string>;
  preview: ReadonlySet<string>;
}

export function indexChecks(checks: readonly CheckResult[]): CheckFailures {
  const article = new Set<string>();
  const preview = new Set<string>();
  for (const check of checks) {
    if (check.ok) continue;
    ((check.kind ?? 'article') === 'article' ? article : preview).add(check.path);
  }
  return { article, preview };
}

/**
 * Index the usable rewrites. A rewrite whose fact check failed is left out
 * here, so every reader below falls back to the original the same way it
 * would for a missing or errored result.
 */
function indexResults(results: ResultsFile, failed: CheckFailures): Rewrites {
  const article = new Map<string, ArticleJobOutput>();
  const preview = new Map<string, PreviewJobOutput>();
  let errors = 0;

  for (const result of results.results) {
    if ('error' in result) {
      errors++;
      continue;
    }
    const path = result.id.slice(result.id.indexOf(':') + 1);
    if (result.kind === 'article') {
      if (!failed.article.has(path)) article.set(path, result.output);
    } else if (!failed.preview.has(path)) {
      preview.set(path, result.output);
    }
  }
  return { article, preview, errors };
}

/** Everything we know about one path from the raw fetch, article or preview. */
interface RawSource {
  url?: string;
  sectionName?: string;
  headline?: string;
  trail?: string;
  standfirst?: string;
  byline?: string;
  mainImage?: Image;
}

function rawSourceFor(raw: RawData, path: string): RawSource {
  const article = raw.articles[path];
  if (article) {
    return {
      url: article.url,
      sectionName: article.section.name,
      headline: article.headline,
      ...(article.trail === undefined ? {} : { trail: article.trail }),
      ...(article.standfirst === undefined ? {} : { standfirst: article.standfirst }),
      ...(article.byline === undefined ? {} : { byline: article.byline }),
      ...(article.mainImage === undefined ? {} : { mainImage: article.mainImage }),
    };
  }
  const preview = raw.previews[path];
  if (preview) {
    return {
      url: preview.url,
      sectionName: preview.section.name,
      headline: preview.headline,
      ...(preview.trail === undefined ? {} : { trail: preview.trail }),
      ...(preview.byline === undefined ? {} : { byline: preview.byline }),
      ...(preview.mainImage === undefined ? {} : { mainImage: preview.mainImage }),
    };
  }
  return {};
}

function buildOriginal(path: string, source: RawSource, fallbackHeadline: string): Original {
  const original: Original = {
    headline: source.headline ?? fallbackHeadline,
    url: source.url ?? webUrlFor(path),
  };
  const trail = stripTags(source.trail);
  if (trail) original.trail = trail;
  if (source.standfirst) original.standfirst = source.standfirst;
  if (source.byline) original.byline = source.byline;
  return original;
}

/**
 * Build one card. `linked` is true only when a full rewritten Article exists,
 * which is what makes the News block's cards clickable and everything else not.
 */
function buildCard(
  raw: RawData,
  rewrites: Rewrites,
  articles: Record<string, Article>,
  seed: { path: string; headline?: string; image?: Image },
): Card {
  const { path } = seed;
  const source = rawSourceFor(raw, path);
  const fallbackHeadline = source.headline ?? seed.headline ?? path;
  const rewritten = rewrites.preview.get(path);
  const article = articles[path];
  const linked = article?.status === 'rewritten';

  // A linked card shows the full rewrite's headline, so the front page and the
  // article it opens never disagree about what the story is.
  const card: Card = {
    path,
    linked,
    headline: (linked ? article.headline : undefined) ?? rewritten?.headline ?? fallbackHeadline,
    original: buildOriginal(path, source, fallbackHeadline),
  };

  if (source.sectionName) card.kicker = source.sectionName;

  const trail = stripTags(rewritten?.trail) ?? stripTags(source.trail);
  if (trail) card.trail = trail;

  const image = seed.image ?? source.mainImage;
  if (image) card.image = image;

  const byline = pseudonymiseByline(source.byline);
  if (byline) card.byline = byline;

  return card;
}

function buildArticle(raw: RawData, rewrites: Rewrites, rawArticle: RawArticle): Article {
  const { path } = rawArticle;
  const output = rewrites.article.get(path);
  const usable = output !== undefined;

  const source = rawSourceFor(raw, path);
  const original = buildOriginal(path, source, rawArticle.headline);

  const article: Article = {
    path,
    url: rawArticle.url,
    section: rawArticle.section,
    publishedAt: rawArticle.publishedAt,
    headline: '',
    bodyHtml: '',
    related: [],
    status: usable ? 'rewritten' : 'headline-only',
    original,
  };

  if (usable && output) {
    article.headline = output.headline;
    const standfirst = standfirstText(output.standfirst ?? rawArticle.standfirst);
    if (standfirst) article.standfirst = standfirst;
    article.bodyHtml = sanitiseHtml(applyCaptions(output.bodyHtml, output.captions));
  } else {
    article.headline = rewrites.preview.get(path)?.headline ?? rawArticle.headline;
    const standfirst = standfirstText(rawArticle.standfirst);
    if (standfirst) article.standfirst = standfirst;
    article.bodyHtml = '';
  }

  const byline = pseudonymiseByline(rawArticle.byline);
  if (byline) article.byline = byline;
  if (rawArticle.mainImage) article.mainImage = rawArticle.mainImage;

  return article;
}

/** Related rail cards are never linked — we only ever rewrite their headline and trail. */
function buildRelatedCards(raw: RawData, rewrites: Rewrites, rawArticle: RawArticle): Card[] {
  return rawArticle.related.map((related) => {
    const rewritten = rewrites.preview.get(related.path);
    const original: Original = {
      headline: related.headline,
      url: related.url || webUrlFor(related.path),
    };
    const originalTrail = stripTags(related.trail);
    if (originalTrail) original.trail = originalTrail;
    if (related.byline) original.byline = related.byline;

    const card: Card = {
      path: related.path,
      linked: false,
      headline: rewritten?.headline ?? related.headline,
      original,
    };
    if (related.section.name) card.kicker = related.section.name;
    const trail = stripTags(rewritten?.trail) ?? originalTrail;
    if (trail) card.trail = trail;
    if (related.mainImage) card.image = related.mainImage;
    const byline = pseudonymiseByline(related.byline);
    if (byline) card.byline = byline;
    return card;
  });
}

/** Pure core: raw + results (+ checks) in, SiteData out. */
export function assemble(
  raw: RawData,
  results: ResultsFile,
  checks: readonly CheckResult[],
  dropped: ReadonlySet<string> = new Set(),
): SiteData {
  const rewrites = indexResults(results, indexChecks(checks));
  const kept = Object.values(raw.articles).filter((rawArticle) => !dropped.has(rawArticle.path));

  const articles: Record<string, Article> = {};
  for (const rawArticle of kept) {
    articles[rawArticle.path] = buildArticle(raw, rewrites, rawArticle);
  }
  // Related rails need the article map to exist first so `linked` is accurate.
  for (const rawArticle of kept) {
    const article = articles[rawArticle.path];
    if (article) {
      article.related = buildRelatedCards(raw, rewrites, rawArticle).filter((card) => !dropped.has(card.path));
    }
  }

  const front: FrontContainer[] = raw.front
    .map((container) => ({
      id: container.id,
      title: container.title,
      cards: container.cards
        .filter((card: RawCard) => !dropped.has(card.path))
        .map((card: RawCard) =>
          buildCard(raw, rewrites, articles, {
            path: card.path,
            ...(card.headline === undefined ? {} : { headline: card.headline }),
            ...(card.image === undefined ? {} : { image: card.image }),
          }),
        ),
    }))
    .filter((container) => container.cards.length > 0);

  return {
    date: raw.date,
    generatedAt: new Date().toISOString(),
    engine: results.engine,
    front,
    articles,
  };
}

function readChecks(file: string): CheckResult[] {
  try {
    const checks = readJson<CheckResult[]>(file, 'check.json');
    if (!Array.isArray(checks)) throw new Error('check.json must be an array of CheckResult');
    return checks;
  } catch (error) {
    if (errorMessage(error).startsWith('Missing check.json')) return [];
    throw error;
  }
}

function readDropped(file: string): Set<string> {
  try {
    const dropped = readJson<Record<string, string>>(file, 'drop.json');
    if (typeof dropped !== 'object' || dropped === null || Array.isArray(dropped)) {
      throw new Error('drop.json must be an object mapping content path to reason');
    }
    return new Set(Object.keys(dropped));
  } catch (error) {
    if (errorMessage(error).startsWith('Missing drop.json')) return new Set();
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);

  const date = resolveDate(args);
  const raw = readJson<RawData>(dayFile(date, 'raw.json'), 'raw.json (run scripts/fetch.ts first)');
  const results = readJson<ResultsFile>(
    dayFile(date, 'results.json'),
    'results.json (run the rewrite engine first)',
  );
  const checks = readChecks(dayFile(date, 'check.json'));

  const dropped = readDropped(dayFile(date, 'drop.json'));

  const site = assemble(raw, results, checks, dropped);

  const out = dayFile(date, 'site.json');
  writeJson(out, site);
  const latest = join(DATA_DIR, 'latest.json');
  writeJson(latest, site);

  const all = Object.values(site.articles);
  const rewritten = all.filter((article) => article.status === 'rewritten').length;
  const cards = site.front.reduce((total, container) => total + container.cards.length, 0);
  const failedChecks = checks.filter((check) => !check.ok).length;
  const failedTone = checks.filter((check) => check.tone?.ok === false).length;

  process.stdout.write(
    `${out} (+ ${latest}): ${site.front.length} containers, ${cards} cards, ` +
      `${all.length} articles (${rewritten} rewritten, ${all.length - rewritten} headline-only), ` +
      `engine ${site.engine}, ${failedChecks} failed fact checks, ${failedTone} failed tone reviews, ` +
      `${dropped.size} stories dropped\n`,
  );
}

runMain(import.meta.url, main);
