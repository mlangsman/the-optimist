/**
 * Build results.json for the `claude-code` engine from hand-written parts.
 *
 *   npx tsx scripts/results-from-parts.ts [--date=YYYY-MM-DD]
 *
 * Reads data/<date>/engine/previews.json  — { "<preview index in jobs.json>": {headline, trail?} }
 *   and data/<date>/engine/article-*.json — { id, output: ArticleJobOutput }
 * Any preview without an entry is passed through unchanged (original headline/trail).
 * Any article without a part becomes an error result (→ headline-only after assemble).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ArticleJobOutput, JobResult, JobsFile, PreviewJobOutput, ResultsFile } from '../src/lib/types.js';
import { dayFile, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { stripTags } from './lib/html.js';

const HELP = `scripts/results-from-parts.ts — assemble results.json from engine/ parts\n\nOptions:\n  --date=YYYY-MM-DD\n  --help\n`;

type PreviewParts = Record<string, Partial<PreviewJobOutput>>;
interface ArticlePart { id: string; output: ArticleJobOutput }

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);
  const date = resolveDate(args);
  const jobs = readJson<JobsFile>(dayFile(date, 'jobs.json'), 'jobs.json');
  const engineDir = dayFile(date, 'engine');

  let previewParts: PreviewParts = {};
  try {
    previewParts = readJson<PreviewParts>(join(engineDir, 'previews.json'), 'engine/previews.json');
  } catch {
    process.stderr.write('No engine/previews.json — all previews pass through unchanged.\n');
  }
  const articleParts = new Map<string, ArticleJobOutput>();
  for (const name of readdirSync(engineDir)) {
    if (!/^article-.*\.json$/.test(name)) continue;
    const part = readJson<ArticlePart>(join(engineDir, name), name);
    articleParts.set(part.id, part.output);
  }

  const results: JobResult[] = [];
  let previewIndex = 0;
  let changed = 0;
  for (const job of jobs.jobs) {
    if (job.kind === 'preview') {
      const part = previewParts[String(previewIndex)];
      previewIndex++;
      const output: PreviewJobOutput = { headline: part?.headline ?? job.input.headline };
      const trail = part?.trail ?? stripTags(job.input.trail);
      if (trail) output.trail = trail;
      if (part) changed++;
      results.push({ id: job.id, kind: 'preview', output });
    } else {
      const output = articleParts.get(job.id);
      if (output) {
        if (output.captions.length !== job.input.captions.length) {
          results.push({ id: job.id, kind: 'article', error: 'caption count mismatch' });
        } else {
          results.push({ id: job.id, kind: 'article', output });
        }
      } else {
        results.push({ id: job.id, kind: 'article', error: 'no engine part written' });
      }
    }
  }

  const file: ResultsFile = { date, engine: 'claude-code', results };
  const out = dayFile(date, 'results.json');
  writeJson(out, file);
  const errors = results.filter((r) => 'error' in r).length;
  process.stdout.write(`${out}: ${results.length} results, ${changed} previews rewritten, ${articleParts.size} articles, ${errors} errors\n`);
}

runMain(import.meta.url, main);
