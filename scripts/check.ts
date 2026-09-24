/**
 * Step 3b of the pipeline: review every rewrite against its original and
 * write check.json.
 *
 *   npx tsx scripts/check.ts [--date=YYYY-MM-DD] [--limit=N] [--no-tone] [--only=failed]
 *
 * Two reviewers look at every rewritten job, articles and previews alike:
 *
 *   - the fact check (a cheap model, thinking off) returns {ok, issues};
 *     assemble.ts publishes anything with ok:false headline-only, or falls
 *     back to the original headline and trail for a preview. A check that
 *     cannot be run fails closed.
 *   - the tone review (the rewrite model at low effort, judging against
 *     prompts/rewrite.md) returns a second {ok, issues} as `tone`. It never
 *     blocks publication by itself; scripts/revise.ts sends failures back to
 *     the rewriter with the notes.
 *
 * Engine `api` only; an in-session (claude-code) run writes the same file by hand.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult, Job, JobsFile, ResultsFile, Verdict } from '../src/lib/types.js';
import {
  addUsage,
  buildCheckRequest,
  buildToneRequest,
  checkModel,
  createClient,
  describeApiError,
  emptyTotals,
  messageText,
  parseCheckOutput,
  readSystemPrompt,
  toneModel,
} from './lib/anthropic.js';
import { CHECK_SYSTEM_PROMPT, TONE_SYSTEM_PROMPT } from './lib/check-prompt.js';
import { dayFile, errorMessage, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { loadEnv } from './lib/env.js';
import { stripTags } from './lib/html.js';

const HELP = `
scripts/check.ts — fact-check and tone-review the rewrites against their originals

Usage:
  npx tsx scripts/check.ts [options]

Options:
  --date=YYYY-MM-DD   Read/write data/<date>/ instead of today (Europe/London).
  --limit=N           Only check the first N jobs.
  --no-tone           Fact check only.
  --only=failed       Re-check only the jobs that failed either review last
                      time (after scripts/revise.ts); keep the other verdicts.
  --help              Show this message.

Input:   data/<date>/jobs.json      the original copy
         data/<date>/results.json   the rewrites
Output:  data/<date>/check.json     CheckResult[]

Every job with a successful rewrite is checked: articles as headline +
standfirst + body, previews as headline + trail. Exits 0 even when checks
fail — assemble.ts demotes a failed fact check, and scripts/revise.ts
handles failed tone reviews. A check that could not be run is recorded as
a failure.

Needs ANTHROPIC_API_KEY in .env or the environment. The key is never logged.
Models: OPTIMIST_CHECK_MODEL and OPTIMIST_TONE_MODEL override the defaults.
`;

/** Checks in flight at once. The batch API is not worth the latency here. */
const CONCURRENCY = 4;

export interface CheckPair {
  path: string;
  kind: Job['kind'];
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
 * Pair each successfully rewritten job with its original, as plain text.
 * Pure — the tags are stripped here so the reviewers never see markup.
 */
export function buildPairs(jobs: readonly Job[], results: ResultsFile): CheckPair[] {
  const outputs = new Map(results.results.filter((result) => !('error' in result)).map((result) => [result.id, result]));

  const pairs: CheckPair[] = [];
  for (const job of jobs) {
    const result = outputs.get(job.id);
    if (!result || 'error' in result) continue;
    if (job.kind === 'article' && result.kind === 'article') {
      pairs.push({
        path: job.path,
        kind: 'article',
        original: plain(job.input.headline, job.input.standfirst, job.input.bodyHtml),
        rewrite: plain(result.output.headline, result.output.standfirst, result.output.progress, result.output.bodyHtml),
      });
    } else if (job.kind === 'preview' && result.kind === 'preview') {
      pairs.push({
        path: job.path,
        kind: 'preview',
        original: plain(job.input.headline, job.input.trail),
        rewrite: plain(result.output.headline, result.output.trail, result.output.progress),
      });
    }
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

/** One reviewer's verdict on one pair, failing closed on any error. */
async function review(
  client: CheckClient,
  pair: CheckPair,
  request: Anthropic.MessageCreateParamsNonStreaming,
  what: string,
  onUsage: (usage: Anthropic.Usage) => void,
): Promise<Verdict> {
  try {
    const message = await client.messages.create(request);
    onUsage(message.usage);
    if (message.stop_reason === 'max_tokens') {
      return { ok: false, issues: [`${what} hit max_tokens before finishing`] };
    }
    const parsed = parseCheckOutput(pair.path, messageText(message));
    return { ok: parsed.ok, issues: parsed.issues };
  } catch (error) {
    // Fail closed: an unverified rewrite is demoted, not published.
    return { ok: false, issues: [`${what} failed to run — ${describeApiError(error)}`] };
  }
}

export interface Reviewers {
  checkModel: string;
  /** Absent means fact check only. */
  tone?: { model: string; systemPrompt: string };
}

export async function checkOne(
  client: CheckClient,
  pair: CheckPair,
  reviewers: Reviewers,
  onUsage: (usage: Anthropic.Usage) => void = () => {},
): Promise<CheckResult> {
  const [facts, tone] = await Promise.all([
    review(client, pair, buildCheckRequest(pair.original, pair.rewrite, CHECK_SYSTEM_PROMPT, reviewers.checkModel), 'fact check', onUsage),
    reviewers.tone
      ? review(client, pair, buildToneRequest(pair.original, pair.rewrite, reviewers.tone.systemPrompt, reviewers.tone.model), 'tone review', onUsage)
      : Promise.resolve(undefined),
  ]);
  const result: CheckResult = { path: pair.path, kind: pair.kind, ok: facts.ok, issues: facts.issues };
  if (tone) result.tone = tone;
  return result;
}

/** The tone reviewer's system prompt: the rubric, then the brief the writer had. */
export function toneSystemPrompt(rewriteBrief: string): string {
  return `${TONE_SYSTEM_PROMPT}\n\nTHE BRIEF THE SUB-EDITOR WAS GIVEN:\n\n${rewriteBrief}`;
}

export function failedEither(check: CheckResult): boolean {
  return !check.ok || check.tone?.ok === false;
}

function keyOf(check: Pick<CheckResult, 'path' | 'kind'>): string {
  return `${check.kind ?? 'article'}:${check.path}`;
}

/** Replace the verdicts that were re-run, keep the rest, in job order. */
export function mergeChecks(previous: readonly CheckResult[], fresh: readonly CheckResult[]): CheckResult[] {
  const byKey = new Map(previous.map((check) => [keyOf(check), check]));
  for (const check of fresh) byKey.set(keyOf(check), check);
  return [...byKey.values()];
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return parsed;
}

function readPreviousChecks(file: string): CheckResult[] {
  try {
    return readJson<CheckResult[]>(file, 'check.json');
  } catch (error) {
    if (errorMessage(error).startsWith('Missing check.json')) return [];
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);

  loadEnv();
  const date = resolveDate(args);

  // Fail on a missing key before reading anything or spending anything.
  const client = createClient();

  const jobsFile = readJson<JobsFile>(dayFile(date, 'jobs.json'), 'jobs.json (run scripts/jobs.ts first)');
  const results = readJson<ResultsFile>(dayFile(date, 'results.json'), 'results.json (run the rewrite engine first)');

  const reviewers: Reviewers = { checkModel: checkModel() };
  if (!args.flags.has('no-tone')) {
    reviewers.tone = { model: toneModel(), systemPrompt: toneSystemPrompt(readSystemPrompt(jobsFile.systemPromptPath)) };
  }

  const out = dayFile(date, 'check.json');
  let allPairs = buildPairs(jobsFile.jobs, results);
  let previous: CheckResult[] = [];
  if (args.options.get('only') === 'failed') {
    previous = readPreviousChecks(out);
    const failed = new Set(previous.filter(failedEither).map(keyOf));
    allPairs = allPairs.filter((pair) => failed.has(keyOf(pair)));
  } else if (args.options.has('only')) {
    throw new Error(`--only accepts "failed", got "${args.options.get('only')}"`);
  }
  const limit = args.options.has('limit') ? positiveInt(args.options.get('limit'), '--limit', allPairs.length) : allPairs.length;
  const pairs = allPairs.slice(0, limit);

  if (pairs.length === 0) {
    writeJson(out, previous);
    process.stdout.write(`${out}: nothing to check\n`);
    return;
  }

  process.stdout.write(
    `Checking ${pairs.length} jobs (facts: ${reviewers.checkModel}` +
      `${reviewers.tone ? `, tone: ${reviewers.tone.model}` : ''}), ${CONCURRENCY} at a time…\n`,
  );
  const totals = emptyTotals();
  const fresh = await mapWithConcurrency(pairs, CONCURRENCY, (pair) =>
    checkOne(client, pair, reviewers, (usage) => addUsage(totals, usage)),
  );
  const checks = mergeChecks(previous, fresh);
  writeJson(out, checks);

  const factFailed = checks.filter((check) => !check.ok);
  const toneFailed = checks.filter((check) => check.tone?.ok === false);
  process.stdout.write(
    `${out}: ${checks.length} checked, ${factFailed.length} failed facts, ${toneFailed.length} failed tone\n`,
  );
  for (const check of checks) {
    if (!failedEither(check)) continue;
    process.stdout.write(`  ${check.kind} ${check.path}\n`);
    for (const issue of check.issues) process.stdout.write(`    facts: ${issue}\n`);
    for (const issue of check.tone?.issues ?? []) process.stdout.write(`    tone:  ${issue}\n`);
  }
  process.stdout.write(
    `tokens: ${totals.input.toLocaleString('en-GB')} input, ${totals.cacheRead.toLocaleString('en-GB')} cache read, ` +
      `${totals.output.toLocaleString('en-GB')} output\n`,
  );
  if (toneFailed.length > 0 || factFailed.length > 0) {
    process.stdout.write(`Next: npx tsx scripts/revise.ts --date=${date}, then rerun with --only=failed\n`);
  }
  // Exit 0 even with failures: assemble.ts and revise.ts handle them.
}

runMain(import.meta.url, main);
