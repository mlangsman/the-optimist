/**
 * Step 2 of the pipeline: turn raw.json into the engine-agnostic job list.
 *
 *   npx tsx scripts/jobs.ts [--date=YYYY-MM-DD]
 *
 * Writes data/<date>/jobs.json.
 */
import type { ContextFile, Job, JobsFile, RawData } from '../src/lib/types.js';
import { dayFile, errorMessage, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { readGoingRight, validPicks } from './lib/going-right.js';
import { extractCaptions, stripTags } from './lib/html.js';

const HELP = `
scripts/jobs.ts — build the rewrite job list from raw.json

Usage:
  npx tsx scripts/jobs.ts [options]

Options:
  --date=YYYY-MM-DD   Read/write data/<date>/ instead of today (Europe/London).
  --help              Show this message.

Input:   data/<date>/raw.json
         data/<date>/going-right.json   (optional) picks from raw.candidates
         data/<date>/context.json       (optional) earlier coverage from scripts/context.ts
Output:  data/<date>/jobs.json

Article jobs rewrite headline + standfirst + body + captions. Preview jobs
rewrite headline + trail for front-page cards and related rails. Formats we
never rewrite in full (liveblogs, obituaries, video, galleries, crosswords)
get a preview job only and are published headline-only.
`;

export const SYSTEM_PROMPT_PATH = 'prompts/rewrite.md';

/** Tags that mean "do not rewrite the body" — these are published headline-only. */
export const UNREWRITABLE_TAGS: ReadonlySet<string> = new Set([
  'tone/minutebyminute',
  'tone/obituaries',
  'type/liveblog',
  'type/video',
  'type/gallery',
  'type/crossword',
]);

export function isRewritable(tags: readonly string[]): boolean {
  return !tags.some((tag) => UNREWRITABLE_TAGS.has(tag));
}

/** Build the job list for a parsed raw.json. Pure — exported for testing. */
export function buildJobs(
  raw: RawData,
  goingRight: readonly string[] = [],
  context: ContextFile['context'] = {},
): Job[] {
  const jobs: Job[] = [];

  // Full rewrites: News block articles we are allowed to rewrite.
  for (const article of Object.values(raw.articles)) {
    if (!isRewritable(article.tags)) continue;
    const items = context[article.path] ?? [];
    jobs.push({
      id: `a:${article.path}`,
      kind: 'article',
      path: article.path,
      input: {
        headline: article.headline,
        ...(article.standfirst === undefined ? {} : { standfirst: article.standfirst }),
        bodyHtml: article.bodyHtml,
        captions: extractCaptions(article.bodyHtml),
        ...(items.length === 0 ? {} : { context: items }),
      },
    });
  }

  // Preview rewrites: every card on the front and in a related rail needs a
  // rewritten headline + trail, including the News articles' own cards.
  const previewSeen = new Set<string>();
  const addPreview = (path: string, headline: string, trail: string | undefined): void => {
    if (previewSeen.has(path)) return;
    previewSeen.add(path);
    const clean = stripTags(trail);
    jobs.push({
      id: `p:${path}`,
      kind: 'preview',
      path,
      input: { headline, ...(clean === undefined ? {} : { trail: clean }) },
    });
  };

  for (const article of Object.values(raw.articles)) {
    addPreview(article.path, article.headline, article.trail);
  }
  for (const preview of Object.values(raw.previews)) {
    addPreview(preview.path, preview.headline, preview.trail);
  }
  for (const path of validPicks(raw, goingRight)) {
    const candidate = raw.candidates?.[path];
    if (candidate) addPreview(candidate.path, candidate.headline, candidate.trail);
  }

  return jobs;
}

/** The context step's output, or {} when it did not run. Throws on a malformed file. */
export function readContext(file: string): ContextFile['context'] {
  try {
    const parsed = readJson<ContextFile>(file, 'context.json');
    if (typeof parsed?.context !== 'object' || parsed.context === null || Array.isArray(parsed.context)) {
      throw new Error('context.json must hold { date, context: { "<path>": ContextItem[] } }');
    }
    return parsed.context;
  } catch (error) {
    if (errorMessage(error).startsWith('Missing context.json')) return {};
    throw error;
  }
}

/** Very rough token estimate: characters / 4. */
export function estimateTokens(jobs: readonly Job[]): number {
  let chars = 0;
  for (const job of jobs) chars += JSON.stringify(job.input).length;
  return Math.round(chars / 4);
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);

  const date = resolveDate(args);
  const raw = readJson<RawData>(dayFile(date, 'raw.json'), 'raw.json (run scripts/fetch.ts first)');

  const goingRight = readGoingRight(dayFile(date, 'going-right.json'));
  const unknown = goingRight.filter((path) => !validPicks(raw, [path]).length);
  for (const path of unknown) process.stderr.write(`Warning: going-right.json pick ${path} is not in raw.candidates — ignored\n`);
  const context = readContext(dayFile(date, 'context.json'));
  const jobs = buildJobs(raw, goingRight, context);
  const jobsFile: JobsFile = { date, systemPromptPath: SYSTEM_PROMPT_PATH, jobs };
  const out = dayFile(date, 'jobs.json');
  writeJson(out, jobsFile);

  const articleJobs = jobs.filter((job) => job.kind === 'article').length;
  const previewJobs = jobs.length - articleJobs;
  const skipped = Object.values(raw.articles).filter((a) => !isRewritable(a.tags)).length;

  process.stdout.write(
    `${out}: ${jobs.length} jobs (${articleJobs} article, ${previewJobs} preview), ` +
      `${skipped} articles headline-only, ~${estimateTokens(jobs).toLocaleString('en-GB')} input tokens\n`,
  );
}

runMain(import.meta.url, main);
