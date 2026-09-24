/**
 * Step 1 of the pipeline: download the Guardian UK front page, parse it, and
 * pull the content it points at from the Content API.
 *
 *   npx tsx scripts/fetch.ts [--date=YYYY-MM-DD] [--front-only]
 *
 * Writes data/<date>/raw.html (debug, gitignored) and data/<date>/raw.json.
 */
import type { RawArticle, RawCard, RawContainer, RawData } from '../src/lib/types.js';
import { dayFile, errorMessage, maybeHelp, parseArgs, resolveDate, runMain, writeJson, writeText } from './lib/cli.js';
import { requireGuardianKey } from './lib/env.js';
import { parseFront, titleFromId } from './lib/front.js';
import {
  fetchItem,
  fetchPreview,
  getRequestCount,
  MAX_REQUESTS_PER_RUN,
  type RawPreview,
} from './lib/guardian-api.js';

const HELP = `
scripts/fetch.ts — download and parse the Guardian UK front page

Usage:
  npx tsx scripts/fetch.ts [options]

Options:
  --date=YYYY-MM-DD   Write into data/<date>/ instead of today (Europe/London).
  --front-only        Parse the front page only; no Content API calls, no key needed.
  --max-preview=N     Cards kept per non-News container (default 8).
  --previews=MODE     dom (default): non-News cards use the headline already on the
                      front page, zero extra API calls. api: fetch headline + trail
                      for every card from the Content API (~150 calls).
  --help              Show this message.

Output:
  data/<date>/raw.html   The downloaded front page (gitignored, for debugging).
  data/<date>/raw.json   RawData: front containers, News articles, previews.

Environment:
  GUARDIAN_API_KEY    Guardian Open Platform key, read from .env or the environment.
`;

const FRONT_URL = 'https://www.theguardian.com/uk';
const NEWS_CONTAINER_ID = 'news';
const DEFAULT_MAX_PREVIEW_CARDS = 8;
const GUARDIAN_ORIGIN = 'https://www.theguardian.com';
type PreviewMode = 'dom' | 'api';

/** Build a preview from what the front page card already tells us (no API call). */
function previewFromCard(card: RawCard): RawPreview | undefined {
  if (!card.headline) return undefined;
  const sectionId = card.path.split('/')[1] ?? '';
  const preview: RawPreview = {
    path: card.path,
    url: `${GUARDIAN_ORIGIN}${card.path}`,
    section: { id: sectionId, name: titleFromId(sectionId) },
    headline: card.headline,
    tags: [],
  };
  if (card.image) preview.mainImage = card.image;
  return preview;
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function downloadFront(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(FRONT_URL, { headers: BROWSER_HEADERS, redirect: 'follow' });
  } catch (error) {
    throw new Error(`Could not reach ${FRONT_URL}: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`${FRONT_URL} returned HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/** Trim non-News containers so one run stays well inside the request budget. */
function capPreviewCards(containers: RawContainer[], max: number): void {
  for (const container of containers) {
    if (container.id === NEWS_CONTAINER_ID) continue;
    if (container.cards.length > max) container.cards.length = max;
  }
}

/** Drop a card from every container it appears in (its fetch failed). */
function dropCard(containers: RawContainer[], path: string): void {
  for (const container of containers) {
    const index = container.cards.findIndex((card) => card.path === path);
    if (index !== -1) container.cards.splice(index, 1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);

  const date = resolveDate(args);
  const frontOnly = args.flags.has('front-only');
  const maxPreviewCards = Number.parseInt(
    args.options.get('max-preview') ?? String(DEFAULT_MAX_PREVIEW_CARDS),
    10,
  );
  if (!Number.isFinite(maxPreviewCards) || maxPreviewCards < 1) {
    throw new Error(`--max-preview must be a positive integer, got "${args.options.get('max-preview')}"`);
  }

  const previewMode = (args.options.get('previews') ?? 'dom') as PreviewMode;
  if (previewMode !== 'dom' && previewMode !== 'api') {
    throw new Error(`--previews must be "dom" or "api", got "${args.options.get('previews')}"`);
  }

  const apiKey = frontOnly ? '' : requireGuardianKey();

  const html = await downloadFront();
  writeText(dayFile(date, 'raw.html'), html);

  const front = parseFront(html);
  if (front.length === 0) {
    throw new Error('Parsed 0 containers from the front page — the markup has probably changed.');
  }
  capPreviewCards(front, maxPreviewCards);

  const articles: Record<string, RawArticle> = {};
  const previews: Record<string, RawPreview> = {};
  let failures = 0;

  if (!frontOnly) {
    // 1. Full articles for the News block.
    const newsCards = front.find((c) => c.id === NEWS_CONTAINER_ID)?.cards ?? [];
    if (newsCards.length === 0) {
      process.stderr.write('Warning: no "news" container found on the front page.\n');
    }
    for (const card of [...newsCards]) {
      try {
        articles[card.path] = await fetchItem(card.path, apiKey);
      } catch (error) {
        failures++;
        process.stderr.write(`  skip article ${card.path}: ${errorMessage(error)}\n`);
        dropCard(front, card.path);
      }
    }

    // 2. Previews for every other card, plus every related item of a News article.
    const seen = new Set<string>(Object.keys(articles));
    if (previewMode === 'dom') {
      // Related items already arrive with headline + trail from show-related=true.
      for (const article of Object.values(articles)) {
        for (const related of article.related) {
          if (seen.has(related.path)) continue;
          seen.add(related.path);
          previews[related.path] = { ...related, tags: [] };
        }
      }
      for (const container of front) {
        if (container.id === NEWS_CONTAINER_ID) continue;
        for (const card of [...container.cards]) {
          if (seen.has(card.path)) continue;
          const preview = previewFromCard(card);
          if (!preview) {
            dropCard(front, card.path);
            continue;
          }
          seen.add(card.path);
          previews[card.path] = preview;
        }
      }
    } else {
      const previewPaths: string[] = [];
      const want = (path: string): void => {
        if (seen.has(path)) return;
        seen.add(path);
        previewPaths.push(path);
      };
      for (const container of front) {
        if (container.id === NEWS_CONTAINER_ID) continue;
        for (const card of container.cards) want(card.path);
      }
      for (const article of Object.values(articles)) {
        for (const related of article.related) want(related.path);
      }

      for (const [index, path] of previewPaths.entries()) {
        // Stop cleanly at the budget rather than logging one failure per remaining card.
        if (getRequestCount() >= MAX_REQUESTS_PER_RUN) {
          const dropped = previewPaths.slice(index);
          process.stderr.write(
            `Request cap of ${MAX_REQUESTS_PER_RUN} reached; dropping ${dropped.length} remaining cards.\n`,
          );
          for (const remaining of dropped) dropCard(front, remaining);
          break;
        }
        try {
          previews[path] = await fetchPreview(path, apiKey);
        } catch (error) {
          failures++;
          process.stderr.write(`  skip preview ${path}: ${errorMessage(error)}\n`);
          dropCard(front, path);
        }
      }
    }
  }

  // A container whose every card failed is no longer a container.
  const keptFront = front.filter((container) => container.cards.length > 0);

  const raw: RawData = {
    date,
    fetchedAt: new Date().toISOString(),
    front: keptFront,
    articles,
    previews,
  };
  const out = dayFile(date, 'raw.json');
  writeJson(out, raw);

  const cardCount = keptFront.reduce((total, container) => total + container.cards.length, 0);
  process.stdout.write(
    `${out}: ${keptFront.length} containers, ${cardCount} cards, ` +
      `${Object.keys(articles).length} articles, ${Object.keys(previews).length} previews, ` +
      `${getRequestCount()} requests, ${failures} failures${frontOnly ? ' (front-only)' : ''}\n`,
  );
  for (const container of keptFront) {
    process.stdout.write(
      `  ${container.id.padEnd(30)} ${String(container.cards.length).padStart(3)}\n`,
    );
  }
}

runMain(import.meta.url, main);
