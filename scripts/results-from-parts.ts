/**
 * Build results.json for the `claude-code` engine from hand-written parts.
 *
 *   npx tsx scripts/results-from-parts.ts [--date=YYYY-MM-DD]
 *
 * Reads data/<date>/engine/previews.json  — { "<content path>": {headline, trail?, progress?, upside?} }
 *   and data/<date>/engine/article-*.json — { id, output: ArticleJobOutput }
 * Parts are keyed by content path / job id, never by position, so re-running
 * fetch or jobs cannot attach a rewrite to the wrong story.
 * A preview without an entry passes through unchanged (original headline/trail),
 * which is the Guardian's framing verbatim — so the run fails and lists them
 * unless --allow-missing is given. An article without a part, or with an
 * invalid one, becomes an error result (published headline-only by
 * assemble.ts). Every part is validated with the same parser the API engine uses.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JobResult, JobsFile, PreviewJobOutput, ResultsFile } from '../src/lib/types.js';
import { parseRewriteOutput } from './lib/anthropic.js';
import { dayFile, errorMessage, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { stripTags } from './lib/html.js';

const HELP = `scripts/results-from-parts.ts — assemble results.json from engine/ parts

Options:
  --date=YYYY-MM-DD
  --allow-missing     Exit 0 even when previews have no part (they pass through unchanged).
  --help
`;

type PreviewParts = Record<string, Partial<PreviewJobOutput>>;
interface ArticlePart {
  id: string;
  output: unknown;
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);
  const date = resolveDate(args);
  const jobs = readJson<JobsFile>(dayFile(date, 'jobs.json'), 'jobs.json');
  const engineDir = dayFile(date, 'engine');

  let previewParts: PreviewParts = {};
  try {
    previewParts = readJson<PreviewParts>(join(engineDir, 'previews.json'), 'engine/previews.json');
  } catch (error) {
    if (!errorMessage(error).startsWith('Missing')) throw error;
    process.stderr.write('No engine/previews.json — all previews pass through unchanged.\n');
  }

  const articleParts = new Map<string, unknown>();
  for (const name of readdirSync(engineDir)) {
    if (!/^article-.*\.json$/.test(name)) continue;
    const part = readJson<ArticlePart>(join(engineDir, name), name);
    if (typeof part.id !== 'string') throw new Error(`${name}: missing "id"`);
    articleParts.set(part.id, part.output);
  }

  const results: JobResult[] = [];
  let changed = 0;
  const missing: string[] = [];
  for (const job of jobs.jobs) {
    if (job.kind === 'preview') {
      const part = previewParts[job.path];
      const output: PreviewJobOutput = { headline: part?.headline ?? job.input.headline };
      const trail = part?.trail ?? stripTags(job.input.trail);
      if (trail) output.trail = trail;
      const progress = part?.progress?.trim();
      if (progress) output.progress = progress;
      if (typeof part?.upside === 'number' && Number.isInteger(part.upside) && part.upside >= 0 && part.upside <= 3) {
        output.upside = part.upside;
      } else if (part && part.upside !== undefined) {
        process.stderr.write(`Warning: ${job.path} has upside ${JSON.stringify(part.upside)}; expected 0–3 — ignored\n`);
      }
      if (part) changed++;
      else missing.push(job.path);
      results.push({ id: job.id, kind: 'preview', output });
    } else {
      const output = articleParts.get(job.id);
      results.push(
        output === undefined
          ? { id: job.id, kind: 'article', error: 'no engine part written' }
          : parseRewriteOutput(job, JSON.stringify(output)),
      );
    }
  }

  const unknownPaths = Object.keys(previewParts).filter((path) => !jobs.jobs.some((job) => job.kind === 'preview' && job.path === path));
  for (const path of unknownPaths) process.stderr.write(`Warning: previews.json entry for unknown path ${path} — ignored\n`);

  const file: ResultsFile = { date, engine: 'claude-code', results };
  const out = dayFile(date, 'results.json');
  writeJson(out, file);
  const errors = results.filter((r) => 'error' in r);
  process.stdout.write(`${out}: ${results.length} results, ${changed} previews rewritten, ${articleParts.size} article parts, ${errors.length} errors\n`);
  if (missing.length > 0) {
    process.stdout.write(`${missing.length} previews have no part in engine/previews.json and would ship the Guardian headline as is:\n`);
    for (const path of missing) process.stdout.write(`  ${path}\n`);
    if (!args.flags.has('allow-missing')) {
      process.stdout.write('Write them and rerun, or pass --allow-missing.\n');
      process.exitCode = 1;
    }
  }
  for (const failure of errors) if ('error' in failure) process.stdout.write(`  ${failure.id}: ${failure.error}\n`);
}

runMain(import.meta.url, main);
