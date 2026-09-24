/**
 * Step 3 of the pipeline, engine `api`: run every job in jobs.json through the
 * Anthropic API and write results.json.
 *
 *   npx tsx scripts/rewrite-api.ts [--date=YYYY-MM-DD] [--limit=N]
 *                                  [--poll-seconds=30] [--no-batch] [--resume=<batch id>]
 *
 * By default all jobs go up as one Message Batch (half price, one round trip).
 * The batch id is written to data/<date>/batch.json the moment it exists, so a
 * crashed or interrupted run resumes with --resume=<batch id> instead of paying
 * for the same work twice.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Job, JobResult, JobsFile, ResultsFile } from '../src/lib/types.js';
import {
  type Prices,
  type TokenTotals,
  SONNET_5_BATCH_PRICES,
  SONNET_5_STANDARD_PRICES,
  addUsage,
  batchCustomId,
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
import { dayFile, maybeHelp, parseArgs, readJson, resolveDate, runMain, writeJson } from './lib/cli.js';
import { loadEnv } from './lib/env.js';

const HELP = `
scripts/rewrite-api.ts — rewrite every job through the Anthropic API (engine "api")

Usage:
  npx tsx scripts/rewrite-api.ts [options]

Options:
  --date=YYYY-MM-DD   Read/write data/<date>/ instead of today (Europe/London).
  --limit=N           Only run the first N jobs. Use --limit=1 for a smoke test.
  --poll-seconds=N    Seconds between batch status polls (default 30).
  --no-batch          Send the same requests one at a time instead of as a batch.
                      Twice the price; useful with --limit=1.
  --resume=<id>       Skip submission and attach to an existing batch id (see
                      data/<date>/batch.json after a crashed run).
  --help              Show this message.

Input:   data/<date>/jobs.json   from scripts/jobs.ts
Output:  data/<date>/results.json  (ResultsFile, engine "api")
         data/<date>/batch.json    the batch id, for --resume

Needs ANTHROPIC_API_KEY in .env or the environment. The key is never logged.
Models: OPTIMIST_REWRITE_MODEL overrides the default rewrite model.
`;

const DEFAULT_POLL_SECONDS = 30;

/* ---------- The slice of the SDK this script uses ---------- */

type BatchesResource = Anthropic['messages']['batches'];
type MessageBatch = Awaited<ReturnType<BatchesResource['retrieve']>>;
type BatchResultStream = Awaited<ReturnType<BatchesResource['results']>>;
type IndividualResponse = BatchResultStream extends AsyncIterable<infer T> ? T : never;

export interface BatchRequest {
  custom_id: string;
  params: Anthropic.MessageCreateParamsNonStreaming;
}

/**
 * Structural stand-in for the real client, so the batch plumbing can be tested
 * against a plain object. `new Anthropic()` satisfies it.
 */
export interface BatchClient {
  messages: {
    batches: {
      create(params: { requests: BatchRequest[] }): Promise<MessageBatch>;
      retrieve(id: string): Promise<MessageBatch>;
      results(id: string): Promise<AsyncIterable<IndividualResponse>>;
    };
  };
}

export interface MessageClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** What we persist so --resume can key results without re-deriving anything. */
export interface BatchRecord {
  id: string;
  date: string;
  model: string;
  createdAt: string;
  jobCount: number;
  /** custom_id -> job id. */
  customIds: Record<string, string>;
}

/* ---------- Pure helpers ---------- */

/** One batch request per job, keyed by a custom_id the Batches API accepts. */
export function toBatchRequests(jobs: readonly Job[], systemPrompt: string, model?: string): BatchRequest[] {
  return jobs.map((job, index) => ({
    custom_id: batchCustomId(job, index),
    params: buildRewriteRequest(job, systemPrompt, model),
  }));
}

/**
 * custom_id -> Job. Built from the jobs we are running; a --resume run also
 * falls back to the custom_id map recorded in batch.json, so a batch submitted
 * with a different --limit still resolves.
 */
export function buildLookup(
  jobs: readonly Job[],
  allJobs: readonly Job[] = jobs,
  record?: BatchRecord,
): (customId: string) => Job | undefined {
  const byCustomId = new Map<string, Job>();
  jobs.forEach((job, index) => byCustomId.set(batchCustomId(job, index), job));

  const byJobId = new Map(allJobs.map((job) => [job.id, job]));
  if (record) {
    for (const [customId, jobId] of Object.entries(record.customIds)) {
      const job = byJobId.get(jobId);
      if (job && !byCustomId.has(customId)) byCustomId.set(customId, job);
    }
  }
  return (customId: string): Job | undefined => byCustomId.get(customId);
}

/** Why a response cannot be used, or undefined when it can. */
export function stopReasonError(message: Anthropic.Message): string | undefined {
  if (message.stop_reason === 'max_tokens') return 'response hit max_tokens before finishing';
  if (message.stop_reason === 'refusal') {
    return `model refused${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : ''}`;
  }
  return undefined;
}

/** One batch line -> one JobResult, or undefined when the custom_id is unknown. */
export function resultForResponse(job: Job, response: IndividualResponse): JobResult {
  const outcome = response.result;
  switch (outcome.type) {
    case 'succeeded': {
      const stopped = stopReasonError(outcome.message);
      if (stopped) return { id: job.id, kind: job.kind, error: stopped };
      return parseRewriteOutput(job, messageText(outcome.message));
    }
    case 'errored':
      return {
        id: job.id,
        kind: job.kind,
        error: `batch request errored — ${outcome.error.error.type}: ${outcome.error.error.message}`,
      };
    case 'expired':
      return { id: job.id, kind: job.kind, error: 'batch request expired before it was processed' };
    case 'canceled':
      return { id: job.id, kind: job.kind, error: 'batch request was canceled' };
    default:
      return { id: job.id, kind: job.kind, error: 'batch returned an unrecognised result type' };
  }
}

/* ---------- Batch flow ---------- */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function api<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new Error(`${what}: ${describeApiError(error)}`);
  }
}

export async function submitBatch(client: BatchClient, requests: BatchRequest[]): Promise<MessageBatch> {
  return api('could not create the message batch', () =>
    client.messages.batches.create({ requests }),
  );
}

/** Poll until processing_status is "ended", printing counts each time. */
export async function pollBatch(
  client: BatchClient,
  batchId: string,
  pollSeconds: number,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  wait: (ms: number) => Promise<void> = sleep,
): Promise<MessageBatch> {
  for (;;) {
    const batch = await api(`could not retrieve batch ${batchId}`, () =>
      client.messages.batches.retrieve(batchId),
    );
    const counts = batch.request_counts;
    log(
      `  ${batch.processing_status}: ${counts.processing} processing, ${counts.succeeded} succeeded, ` +
        `${counts.errored} errored, ${counts.canceled} canceled, ${counts.expired} expired`,
    );
    if (batch.processing_status === 'ended') return batch;
    await wait(pollSeconds * 1000);
  }
}

/**
 * Stream the batch results and key them by custom_id — the API does not
 * guarantee they come back in request order.
 */
export async function collectBatchResults(
  client: BatchClient,
  batchId: string,
  jobFor: (customId: string) => Job | undefined,
  totals: TokenTotals = emptyTotals(),
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<JobResult[]> {
  const stream = await api(`could not read the results of batch ${batchId}`, () =>
    client.messages.batches.results(batchId),
  );

  const results: JobResult[] = [];
  for await (const response of stream) {
    const job = jobFor(response.custom_id);
    if (!job) {
      warn(`Warning: batch result for unknown custom_id "${response.custom_id}" — ignored`);
      continue;
    }
    if (response.result.type === 'succeeded') addUsage(totals, response.result.message.usage);
    results.push(resultForResponse(job, response));
  }
  return results;
}

/* ---------- Sequential flow (--no-batch) ---------- */

export async function runSequential(
  client: MessageClient,
  jobs: readonly Job[],
  systemPrompt: string,
  model: string,
  totals: TokenTotals = emptyTotals(),
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const [index, job] of jobs.entries()) {
    log(`  [${index + 1}/${jobs.length}] ${job.id}`);
    try {
      const message = await client.messages.create(buildRewriteRequest(job, systemPrompt, model));
      addUsage(totals, message.usage);
      const stopped = stopReasonError(message);
      results.push(
        stopped
          ? { id: job.id, kind: job.kind, error: stopped }
          : parseRewriteOutput(job, messageText(message)),
      );
    } catch (error) {
      const described = describeApiError(error);
      // An auth failure will not fix itself on the next job — stop now.
      if (described.startsWith('authentication failed')) throw new Error(described);
      results.push({ id: job.id, kind: job.kind, error: described });
    }
  }
  return results;
}

/* ---------- Entry point ---------- */

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return parsed;
}

function readBatchRecord(file: string): BatchRecord | undefined {
  try {
    return readJson<BatchRecord>(file, 'batch.json');
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  maybeHelp(args, HELP);

  loadEnv();
  const date = resolveDate(args);
  const pollSeconds = positiveInt(args.options.get('poll-seconds'), '--poll-seconds', DEFAULT_POLL_SECONDS);
  const resumeId = args.options.get('resume');
  const noBatch = args.flags.has('no-batch');

  // Fail on a missing key before reading anything or spending anything.
  const client = createClient();
  const model = rewriteModel();

  const jobsFile = readJson<JobsFile>(dayFile(date, 'jobs.json'), 'jobs.json (run scripts/jobs.ts first)');
  const allJobs = jobsFile.jobs;
  const limit = args.options.has('limit')
    ? positiveInt(args.options.get('limit'), '--limit', allJobs.length)
    : allJobs.length;
  const jobs = allJobs.slice(0, limit);
  if (jobs.length === 0) throw new Error(`No jobs to run in ${dayFile(date, 'jobs.json')}`);

  const systemPrompt = readSystemPrompt(jobsFile.systemPromptPath);
  const totals = emptyTotals();
  let results: JobResult[];
  let prices: Prices;
  let priceLabel: string;

  if (noBatch) {
    prices = SONNET_5_STANDARD_PRICES;
    priceLabel = 'standard prices';
    process.stdout.write(`${jobs.length} jobs, one at a time, model ${model}\n`);
    results = await runSequential(client, jobs, systemPrompt, model, totals);
  } else {
    prices = SONNET_5_BATCH_PRICES;
    priceLabel = 'batch prices';
    const record = readBatchRecord(dayFile(date, 'batch.json'));
    let batchId = resumeId;

    if (batchId === undefined) {
      const requests = toBatchRequests(jobs, systemPrompt, model);
      process.stdout.write(`Submitting ${requests.length} jobs as one batch, model ${model}…\n`);
      const batch = await submitBatch(client, requests);
      batchId = batch.id;
      const saved: BatchRecord = {
        id: batch.id,
        date,
        model,
        createdAt: new Date().toISOString(),
        jobCount: requests.length,
        customIds: Object.fromEntries(
          requests.map((request, index) => [request.custom_id, jobs[index]?.id ?? '']),
        ),
      };
      writeJson(dayFile(date, 'batch.json'), saved);
      process.stdout.write(
        `Batch ${batch.id} (${batch.processing_status}) — saved to ${dayFile(date, 'batch.json')}\n` +
          `Resume after a crash with: npx tsx scripts/rewrite-api.ts --date=${date} --resume=${batch.id}\n`,
      );
    } else {
      process.stdout.write(`Resuming batch ${batchId}\n`);
    }

    process.stdout.write(`Polling every ${pollSeconds}s…\n`);
    await pollBatch(client, batchId, pollSeconds);
    results = await collectBatchResults(
      client,
      batchId,
      buildLookup(jobs, allJobs, resumeId === undefined ? undefined : record),
      totals,
    );
  }

  const resultsFile: ResultsFile = { date, engine: 'api', results };
  const out = dayFile(date, 'results.json');
  writeJson(out, resultsFile);

  const errors = results.filter((result) => 'error' in result);
  process.stdout.write(
    `${out}: ${results.length} results (${results.length - errors.length} ok, ${errors.length} failed)\n`,
  );
  for (const failure of errors) {
    if ('error' in failure) process.stdout.write(`  ${failure.id}: ${failure.error}\n`);
  }
  process.stdout.write(`${formatUsage(totals, prices, priceLabel)}\n`);
}

runMain(import.meta.url, main);
