/**
 * Step 3a of the pipeline: lint every rewrite for tone, without a model.
 *
 *   npx tsx scripts/tone.ts [--date=YYYY-MM-DD] [--strict] [--warn-only]
 *
 * Reads jobs.json and results.json, writes data/<date>/tone.json (ToneIssue[])
 * and prints the findings. Exits 1 when any preview job has no rewrite or any
 * rewrite carries an error-level issue, so a run cannot ship a Guardian
 * headline by mistake. Works for either engine; no API key needed.
 *
 * What it catches is mechanical — unchanged or cosmetically edited headlines,
 * and copy centred on words of loss, harm, threat or fear. The judgement call
 * (is this actually optimistic, is it still the Guardian's voice) is the model
 * review in scripts/check.ts, or the engine's own pass in the daily routine.
 */
import type { Job, JobsFile, ResultsFile } from '../src/lib/types.js';
import { dayFile, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { type ToneIssue, formatIssues, hasSetback, lintArticle, lintPreview } from './lib/tone.js';

const HELP = `
scripts/tone.ts — lint rewrites for unchanged headlines and setback-centred copy

Usage:
  npx tsx scripts/tone.ts [options]

Options:
  --date=YYYY-MM-DD   Read/write data/<date>/ instead of today (Europe/London).
  --strict            Treat warnings as errors.
  --warn-only         Print everything but always exit 0.
  --help              Show this message.

Input:   data/<date>/jobs.json, data/<date>/results.json
Output:  data/<date>/tone.json   ToneIssue[]

Exit 1 when a preview has no rewrite or any issue is an error (or, with
--strict, a warning). Fix the copy and rerun until it is clean.
`;

/** Pure core: every issue for every job, plus a missing-rewrite issue per preview without one. */
export function lintResults(jobs: readonly Job[], results: ResultsFile): ToneIssue[] {
  const byId = new Map(results.results.map((result) => [result.id, result]));
  const issues: ToneIssue[] = [];
  for (const job of jobs) {
    const result = byId.get(job.id);
    if (job.kind === 'preview') {
      if (!result || 'error' in result || result.kind !== 'preview') {
        // A missing rewrite of a setback headline ships the Guardian's framing
        // verbatim; a missing rewrite of a recipe card is only untidy.
        const severity = hasSetback(job.input.headline, job.input.trail) ? 'error' : 'warning';
        issues.push({
          path: job.path,
          kind: 'preview',
          field: 'headline',
          severity,
          issue: `no rewrite — the Guardian headline would be published as is: "${job.input.headline}"`,
        });
        continue;
      }
      issues.push(...lintPreview(job, result.output));
    } else if (result && !('error' in result) && result.kind === 'article') {
      issues.push(...lintArticle(job, result.output));
    }
  }
  return issues;
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);
  const date = resolveDate(args);

  const jobsFile = readJson<JobsFile>(dayFile(date, 'jobs.json'), 'jobs.json (run scripts/jobs.ts first)');
  const results = readJson<ResultsFile>(dayFile(date, 'results.json'), 'results.json (run the rewrite engine first)');

  const issues = lintResults(jobsFile.jobs, results);
  const out = dayFile(date, 'tone.json');
  writeJson(out, issues);

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  if (issues.length > 0) process.stdout.write(`${formatIssues(issues)}\n`);
  process.stdout.write(`${out}: ${errors} errors, ${warnings} warnings across ${jobsFile.jobs.length} jobs\n`);

  const failing = args.flags.has('strict') ? issues.length : errors;
  if (failing > 0 && !args.flags.has('warn-only')) process.exitCode = 1;
}

runMain(import.meta.url, main);
