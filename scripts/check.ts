/**
 * Step 3b of the pipeline: fact-check every rewritten article against its
 * original and write check.json.
 *
 *   npx tsx scripts/check.ts [--date=YYYY-MM-DD] [--limit=N]
 *
 * Each article goes to a cheap model with the original and the rewrite as plain
 * text, and comes back as {ok, issues}. assemble.ts publishes anything with
 * ok:false headline-only, so a check that cannot be run fails closed.
 *
 * Engine `api` only; an in-session (claude-code) run writes the same file by hand.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult, Job, JobsFile, ResultsFile } from '../src/lib/types.js';
import {
  addUsage,
  buildCheckRequest,
  checkModel,
  createClient,
  describeApiError,
  emptyTotals,
  messageText,
  parseCheckOutput,
} from './lib/anthropic.js';
import { CHECK_SYSTEM_PROMPT } from './lib/check-prompt.js';
import { dayFile, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { loadEnv } from './lib/env.js';
import { stripTags } from './lib/html.js';

const HELP = `
scripts/check.ts — fact-check the rewritten articles against their originals

Usage:
  npx tsx scripts/check.ts [options]

Options:
  --date=YYYY-MM-DD   Read/write data/<date>/ instead of today (Europe/London).
  --limit=N           Only check the first N articles.
  --help              Show this message.

Input:   data/<date>/jobs.json      the original copy
         data/<date>/results.json   the rewrites
Output:  data/<date>/check.json     CheckResult[]

Only article jobs with a successful rewrite are checked; previews are not.
Exits 0 even when checks fail — assemble.ts demotes a failed path to
headline-only. A check that could not be run is recorded as a failure.

Needs ANTHROPIC_API_KEY in .env or the environment. The key is never logged.
Models: OPTIMIST_CHECK_MODEL overrides the default fact-check model.
`;

/** Checks in flight at once. The batch API is not worth the latency here. */
const CONCURRENCY = 4;

export interface CheckPair {
  path: string;
  original: string;
  rewrite: string;
}

export interface CheckClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

function plain(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => stripTags(part))
    .filter((part): part is string => part !== undefined)
    .join('\n\n');
}

/**
 * Pair each successfully rewritten article with its original, as plain text.
 * Pure — the tags are stripped here so the checker never sees markup.
 */
export function buildPairs(jobs: readonly Job[], results: ResultsFile): CheckPair[] {
  const outputs = new Map(
    results.results
      .filter((result) => result.kind === 'article' && !('error' in result))
      .map((result) => [result.id, result]),
  );

  const pairs: CheckPair[] = [];
  for (const job of jobs) {
    if (job.kind !== 'article') continue;
    const result = outputs.get(job.id);
    if (!result || 'error' in result || result.kind !== 'article') continue;
    pairs.push({
      path: job.path,
      original: plain(job.input.headline, job.input.standfirst, job.input.bodyHtml),
      rewrite: plain(result.output.headline, result.output.standfirst, result.output.bodyHtml),
    });
  }
  return pairs;
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function checkOne(
  client: CheckClient,
  pair: CheckPair,
  model: string,
  onUsage: (usage: Anthropic.Usage) => void = () => {},
): Promise<CheckResult> {
  try {
    const message = await client.messages.create(
      buildCheckRequest(pair.original, pair.rewrite, CHECK_SYSTEM_PROMPT, model),
    );
    onUsage(message.usage);
    if (message.stop_reason === 'max_tokens') {
      return { path: pair.path, ok: false, issues: ['fact check hit max_tokens before finishing'] };
    }
    return parseCheckOutput(pair.path, messageText(message));
  } catch (error) {
    // Fail closed: an unverified rewrite is demoted, not published.
    return { path: pair.path, ok: false, issues: [`fact check failed to run — ${describeApiError(error)}`] };
  }
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);

  loadEnv();
  const date = resolveDate(args);

  // Fail on a missing key before reading anything or spending anything.
  const client = createClient();
  const model = checkModel();

  const jobsFile = readJson<JobsFile>(dayFile(date, 'jobs.json'), 'jobs.json (run scripts/jobs.ts first)');
  const results = readJson<ResultsFile>(
    dayFile(date, 'results.json'),
    'results.json (run the rewrite engine first)',
  );

  const allPairs = buildPairs(jobsFile.jobs, results);
  const limit = args.options.has('limit')
    ? positiveInt(args.options.get('limit'), '--limit', allPairs.length)
    : allPairs.length;
  const pairs = allPairs.slice(0, limit);

  const out = dayFile(date, 'check.json');
  if (pairs.length === 0) {
    writeJson(out, [] as CheckResult[]);
    process.stdout.write(`${out}: nothing to check (no successful article rewrites)\n`);
    return;
  }

  process.stdout.write(`Checking ${pairs.length} articles with ${model}, ${CONCURRENCY} at a time…\n`);
  const totals = emptyTotals();
  const checks = await mapWithConcurrency(pairs, CONCURRENCY, (pair) =>
    checkOne(client, pair, model, (usage) => addUsage(totals, usage)),
  );

  writeJson(out, checks);

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(
    `${out}: ${checks.length} checked, ${checks.length - failed.length} ok, ${failed.length} failed\n`,
  );
  for (const check of failed) {
    process.stdout.write(`  ${check.path}\n`);
    for (const issue of check.issues) process.stdout.write(`    - ${issue}\n`);
  }
  process.stdout.write(
    `tokens: ${totals.input.toLocaleString('en-GB')} input, ${totals.output.toLocaleString('en-GB')} output\n`,
  );
  // Exit 0 even with failures: assemble.ts handles the demotion.
}

runMain(import.meta.url, main);
