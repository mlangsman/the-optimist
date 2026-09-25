/**
 * Step 2b of the pipeline: earlier Guardian coverage of each News story.
 *
 *   npx tsx scripts/context.ts [--date=YYYY-MM-DD] [--days=90] [--limit=5]
 *
 * For every article the rewrite engine will handle in full, one Content API
 * search on the article's keyword tags for recent pieces on the same story.
 * The engine may draw one "Also in the Guardian" line from one of them — a
 * response or improvement the day's copy does not mention — citing it by URL.
 * Nothing here judges tone: the pieces are whatever the Guardian ran.
 *
 * Why the Guardian only: every fact The Optimist prints must be checkable
 * against Guardian copy under the same terms as the rest of the paper, and the
 * fact check verifies the line against the excerpt stored here. An open-web
 * search would have neither property.
 *
 * Writes data/<date>/context.json. Run after fetch and before jobs, which
 * attaches the items to each article job.
 */
import type { ContextFile, ContextItem, RawData } from '../src/lib/types.js';
import { dayFile, errorMessage, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { requireGuardianKey } from './lib/env.js';
import { contextTagQuery, fetchContext, getRequestCount } from './lib/guardian-api.js';
import { isRewritable } from './jobs.js';

const HELP = `
scripts/context.ts — find earlier Guardian coverage for each News article

Usage:
  npx tsx scripts/context.ts [options]

Options:
  --date=YYYY-MM-DD   Read/write data/<date>/ instead of today (Europe/London).
  --days=N            How far back to search (default ${90}).
  --limit=N           Items to keep per article (default ${5}).
  --help              Show this message.

Input:   data/<date>/raw.json            (needs GUARDIAN_API_KEY)
Output:  data/<date>/context.json        { date, context: { "<path>": ContextItem[] } }

One search per rewritable News article, on its keyword tags. The article
itself, anything already on the front, opinion, live blogs and obituaries are
left out. Each item keeps the opening of its body as an excerpt: the only text
the engine may build a context line from, and the text the fact check reads.
`;

export const DEFAULT_DAYS = 90;
export const DEFAULT_LIMIT = 5;

function daysBefore(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
}

function positiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got "${value}"`);
  return n;
}

/** Every path on the front, so a context item is never a story the paper already runs. */
export function pathsOnFront(raw: RawData): Set<string> {
  const paths = new Set<string>([...Object.keys(raw.articles), ...Object.keys(raw.previews)]);
  for (const container of raw.front) for (const card of container.cards) paths.add(card.path);
  return paths;
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);
  const date = resolveDate(args);
  const days = positiveInt(args.options.get('days'), '--days', DEFAULT_DAYS);
  const limit = positiveInt(args.options.get('limit'), '--limit', DEFAULT_LIMIT);

  const apiKey = requireGuardianKey();
  const raw = readJson<RawData>(dayFile(date, 'raw.json'), 'raw.json (run scripts/fetch.ts first)');
  const onFront = pathsOnFront(raw);
  const fromDate = daysBefore(date, days);

  const context: Record<string, ContextItem[]> = {};
  let searched = 0;
  let untagged = 0;
  let failures = 0;
  for (const article of Object.values(raw.articles)) {
    if (!isRewritable(article.tags)) continue;
    const tagQuery = contextTagQuery(article.tags);
    if (tagQuery === undefined) {
      untagged++;
      context[article.path] = [];
      continue;
    }
    try {
      searched++;
      context[article.path] = await fetchContext(apiKey, tagQuery, { fromDate, exclude: onFront, limit });
    } catch (error) {
      failures++;
      context[article.path] = [];
      process.stderr.write(`  skip context for ${article.path}: ${errorMessage(error)}\n`);
    }
  }

  const file: ContextFile = { date, context };
  const out = dayFile(date, 'context.json');
  writeJson(out, file);
  const items = Object.values(context).reduce((total, list) => total + list.length, 0);
  process.stdout.write(
    `${out}: ${items} context items for ${Object.keys(context).length} articles ` +
      `(${searched} searches, ${untagged} without keyword tags, ${failures} failures, ${getRequestCount()} requests)\n`,
  );
}

runMain(import.meta.url, main);
