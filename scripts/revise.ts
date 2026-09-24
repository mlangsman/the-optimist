/**
 * Step 3c of the pipeline, engine `api`: send every rewrite that failed a
 * review back to the rewriter with the reviewers' notes, and write the new
 * attempts into results.json.
 *
 *   npx tsx scripts/revise.ts [--date=YYYY-MM-DD] [--limit=N]
 *
 * Reads check.json (from scripts/check.ts) and tone.json (from scripts/tone.ts,
 * if present). Each failing job is re-run one at a time — the set is small —
 * with the previous attempt and the notes appended to the prompt, then
 * results.json is rewritten in place. Rerun `check.ts --only=failed` and
 * `tone.ts` afterwards; loop until clean or until --rounds is exhausted in the
 * daily routine.
 */
import type { CheckResult, Job, JobResult, JobsFile, ResultsFile } from '../src/lib/types.js';
import {
  type Revision,
  SONNET_5_STANDARD_PRICES,
  addUsage,
  buildRewriteRequest,
  createClient,
  describeApiError,
  emptyTotals,
  formatUsage,
  messageText,
  parseRewriteOutput,
  readSystemPrompt,
  rewriteModel,
} from './lib/anthropic.js';
import { failedEither } from './check.js';
import { dayFile, errorMessage, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { loadEnv } from './lib/env.js';
import type { ToneIssue } from './lib/tone.js';
import { type MessageClient, stopReasonError } from './rewrite-api.js';

const HELP = `
scripts/revise.ts — re-run the rewrites that failed a review, with the notes

Usage:
  npx tsx scripts/revise.ts [options]

Options:
  --date=YYYY-MM-DD   Read/write data/<date>/ instead of today (Europe/London).
  --limit=N           Only revise the first N failing jobs.
  --help              Show this message.

Input:   data/<date>/jobs.json, data/<date>/results.json
         data/<date>/check.json   fact and tone verdicts (required)
         data/<date>/tone.json    lint findings (optional)
Output:  data/<date>/results.json  updated in place

Needs ANTHROPIC_API_KEY in .env or the environment. The key is never logged.
`;

/** Which jobs to send back, and what to tell the writer. Pure. */
export function collectRevisions(
  jobs: readonly Job[],
  results: ResultsFile,
  checks: readonly CheckResult[],
  lint: readonly ToneIssue[] = [],
): Array<{ job: Job; revision: Revision }> {
  const notes = new Map<string, string[]>();
  const add = (kind: Job['kind'], path: string, note: string): void => {
    const key = `${kind}:${path}`;
    notes.set(key, [...(notes.get(key) ?? []), note]);
  };
  for (const check of checks) {
    if (!failedEither(check)) continue;
    const kind = check.kind ?? 'article';
    if (!check.ok) for (const issue of check.issues) add(kind, check.path, `Fact check: ${issue}`);
    for (const issue of check.tone?.issues ?? []) add(kind, check.path, `Editor: ${issue}`);
  }
  for (const issue of lint) {
    if (issue.severity !== 'error') continue;
    add(issue.kind, issue.path, `Lint (${issue.field}): ${issue.issue}`);
  }

  const outputs = new Map(results.results.map((result) => [result.id, result]));
  const revisions: Array<{ job: Job; revision: Revision }> = [];
  for (const job of jobs) {
    const jobNotes = notes.get(`${job.kind}:${job.path}`);
    if (!jobNotes) continue;
    const result = outputs.get(job.id);
    if (!result || 'error' in result) continue;
    revisions.push({ job, revision: { previous: result.output, notes: jobNotes } });
  }
  return revisions;
}

/** Re-run each revision sequentially; a failure keeps the previous attempt. */
export async function runRevisions(
  client: MessageClient,
  revisions: ReadonlyArray<{ job: Job; revision: Revision }>,
  systemPrompt: string,
  model: string,
  totals = emptyTotals(),
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<Map<string, JobResult>> {
  const replaced = new Map<string, JobResult>();
  for (const [index, { job, revision }] of revisions.entries()) {
    log(`  [${index + 1}/${revisions.length}] ${job.id} (${revision.notes.length} notes)`);
    try {
      const message = await client.messages.create(buildRewriteRequest(job, systemPrompt, model, revision));
      addUsage(totals, message.usage);
      const stopped = stopReasonError(message);
      if (stopped) {
        log(`    kept previous attempt: ${stopped}`);
        continue;
      }
      const result = parseRewriteOutput(job, messageText(message));
      if ('error' in result) {
        log(`    kept previous attempt: ${result.error}`);
        continue;
      }
      replaced.set(job.id, result);
    } catch (error) {
      const described = describeApiError(error);
      if (described.startsWith('authentication failed')) throw new Error(described);
      log(`    kept previous attempt: ${described}`);
    }
  }
  return replaced;
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return parsed;
}

function readOptional<T>(file: string, what: string): T[] {
  try {
    return readJson<T[]>(file, what);
  } catch (error) {
    if (errorMessage(error).startsWith(`Missing ${what}`)) return [];
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);
  loadEnv();
  const date = resolveDate(args);
  const client = createClient();
  const model = rewriteModel();

  const jobsFile = readJson<JobsFile>(dayFile(date, 'jobs.json'), 'jobs.json');
  const results = readJson<ResultsFile>(dayFile(date, 'results.json'), 'results.json');
  const checks = readJson<CheckResult[]>(dayFile(date, 'check.json'), 'check.json (run scripts/check.ts first)');
  const lint = readOptional<ToneIssue>(dayFile(date, 'tone.json'), 'tone.json');

  const all = collectRevisions(jobsFile.jobs, results, checks, lint);
  const limit = args.options.has('limit') ? positiveInt(args.options.get('limit'), '--limit', all.length) : all.length;
  const revisions = all.slice(0, limit);
  if (revisions.length === 0) {
    process.stdout.write('Nothing to revise.\n');
    return;
  }

  process.stdout.write(`Revising ${revisions.length} jobs with ${model}…\n`);
  const systemPrompt = readSystemPrompt(jobsFile.systemPromptPath);
  const totals = emptyTotals();
  const replaced = await runRevisions(client, revisions, systemPrompt, model, totals);

  const updated: ResultsFile = {
    ...results,
    results: results.results.map((result) => replaced.get(result.id) ?? result),
  };
  const out = dayFile(date, 'results.json');
  writeJson(out, updated);
  process.stdout.write(`${out}: ${replaced.size} of ${revisions.length} rewrites replaced\n`);
  process.stdout.write(`${formatUsage(totals, SONNET_5_STANDARD_PRICES, 'standard prices')}\n`);
  process.stdout.write(`Next: npx tsx scripts/check.ts --date=${date} --only=failed && npx tsx scripts/tone.ts --date=${date}\n`);
}

runMain(import.meta.url, main);
