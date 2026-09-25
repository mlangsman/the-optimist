/**
 * One Anthropic client, one place for model ids, and the pure request/response
 * plumbing shared by scripts/rewrite-api.ts and scripts/check.ts.
 *
 * Everything except createClient() is pure and runs without a network, which is
 * what scripts/lib/anthropic.test.ts exercises.
 *
 * SDK shapes used here (@anthropic-ai/sdk 0.128):
 *   - structured output:  output_config.format = { type: 'json_schema', schema }
 *   - prefix caching:     system as a block array with cache_control on the last block
 *   - thinking:           { type: 'adaptive' } — never budget_tokens on Sonnet 5
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { z } from 'zod';
import type {
  ArticleJobOutput,
  CheckResult,
  ContextItem,
  Job,
  JobResult,
  PreviewJobOutput,
} from '../../src/lib/types.js';
import { errorMessage } from './cli.js';
import { requireAnthropicKey } from './env.js';

/* ---------- Models ---------- */

/** Rewrite model. The batch price table below is this model's. */
export const REWRITE_MODEL = 'claude-sonnet-5';
/** Fact-check model: cheap, and deliberately run with thinking off. */
export const CHECK_MODEL = 'claude-haiku-4-5';
/** Tone-review model: a judgement call, so the rewrite model at low effort. */
export const TONE_MODEL = 'claude-sonnet-5';

/** REWRITE_MODEL unless OPTIMIST_REWRITE_MODEL overrides it. */
export function rewriteModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTIMIST_REWRITE_MODEL?.trim() || REWRITE_MODEL;
}

/** CHECK_MODEL unless OPTIMIST_CHECK_MODEL overrides it. */
export function checkModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTIMIST_CHECK_MODEL?.trim() || CHECK_MODEL;
}

/** TONE_MODEL unless OPTIMIST_TONE_MODEL overrides it. */
export function toneModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTIMIST_TONE_MODEL?.trim() || TONE_MODEL;
}

/**
 * A full rewritten body plus headline, standfirst and captions. Adaptive
 * thinking is billed inside this cap, so leave room for a 3,000-word feature.
 */
export const ARTICLE_MAX_TOKENS = 16000;
/** A headline and a 20–35 word trail. */
export const PREVIEW_MAX_TOKENS = 400;
/** A boolean and a short list of issues. */
export const CHECK_MAX_TOKENS = 2000;
/** The same verdict shape, with room for a low-effort think first. */
export const TONE_MAX_TOKENS = 4000;

/* ---------- Client ---------- */

/**
 * The shared client. Reads ANTHROPIC_API_KEY through the .env loader and throws
 * a one-line error when it is absent — the key itself is never logged.
 */
export function createClient(): Anthropic {
  return new Anthropic({ apiKey: requireAnthropicKey() });
}

/** Read the shared system prompt named by jobs.json (prompts/rewrite.md), verbatim. */
export function readSystemPrompt(promptPath: string): string {
  try {
    return readFileSync(resolve(process.cwd(), promptPath), 'utf8');
  } catch (error) {
    throw new Error(`Could not read the system prompt (${promptPath}): ${errorMessage(error)}`);
  }
}

/**
 * One line for an expected API failure, most specific class first. Anything
 * unrecognised falls through to its message — never a stack trace.
 */
export function describeApiError(error: unknown): string {
  if (error instanceof AuthenticationError) {
    return 'authentication failed (401) — check ANTHROPIC_API_KEY';
  }
  if (error instanceof RateLimitError) {
    return 'rate limited (429) — wait and retry, or use the default batch mode';
  }
  if (error instanceof APIConnectionError) {
    return 'could not reach the Anthropic API — check the network and retry';
  }
  if (error instanceof APIError) {
    return `API error ${error.status ?? '(no status)'}: ${error.message}`;
  }
  return errorMessage(error);
}

/* ---------- Structured output schemas ---------- */

type JsonSchema = Record<string, unknown>;

/** Matches ArticleJobOutput. Optional standfirst is sent as an explicit null. */
export const ARTICLE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    standfirst: { type: ['string', 'null'] },
    bodyHtml: { type: 'string' },
    captions: { type: 'array', items: { type: 'string' } },
    progress: { type: ['string', 'null'] },
    upside: { type: 'integer', enum: [0, 1, 2, 3] },
    context: {
      type: ['object', 'null'],
      properties: { text: { type: 'string' }, sourceUrl: { type: 'string' } },
      required: ['text', 'sourceUrl'],
      additionalProperties: false,
    },
  },
  required: ['headline', 'standfirst', 'bodyHtml', 'captions', 'progress', 'upside', 'context'],
  additionalProperties: false,
};

/** Matches PreviewJobOutput. */
export const PREVIEW_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    trail: { type: ['string', 'null'] },
    progress: { type: ['string', 'null'] },
    upside: { type: 'integer', enum: [0, 1, 2, 3] },
  },
  required: ['headline', 'trail', 'progress', 'upside'],
  additionalProperties: false,
};

/** Matches CheckResult minus `path`, which we already know. */
export const CHECK_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'issues'],
  additionalProperties: false,
};

export function outputSchemaFor(kind: Job['kind']): JsonSchema {
  return kind === 'article' ? ARTICLE_OUTPUT_SCHEMA : PREVIEW_OUTPUT_SCHEMA;
}

export function maxTokensFor(kind: Job['kind']): number {
  return kind === 'article' ? ARTICLE_MAX_TOKENS : PREVIEW_MAX_TOKENS;
}

/* ---------- Requests ---------- */

/**
 * A previous attempt and the editor's notes on it, for a revision. The notes
 * come from the fact check and the tone review (scripts/check.ts).
 */
export interface Revision {
  previous: ArticleJobOutput | PreviewJobOutput;
  notes: string[];
}

function renderRevision(revision: Revision): string {
  return [
    '',
    'YOUR PREVIOUS ATTEMPT was sent back by the editor. Its JSON was:',
    JSON.stringify(revision.previous),
    '',
    "EDITOR'S NOTES:",
    ...revision.notes.map((note) => `- ${note}`),
    '',
    'Address every note. Start again from the ORIGINAL copy above, not from your previous attempt:' +
      ' find the constructive element the notes point to and build the headline around it.' +
      ' Every fact must still come from the original.',
  ].join('\n');
}

/** The job input as labelled sections. Kept free of dates, ids and anything else volatile. */
export function renderJobInput(job: Job, revision?: Revision): string {
  const suffix = revision === undefined ? '' : `\n${renderRevision(revision)}`;
  if (job.kind === 'preview') {
    return (
      [
        'KIND: preview',
        '',
        'HEADLINE:',
        job.input.headline,
        '',
        'TRAIL:',
        job.input.trail ?? '(none)',
        '',
        'Rewrite the headline and the trail, write the progress line and score the upside. Return' +
          ' {"headline": string, "trail": string | null, "progress": string | null, "upside": 0 | 1 | 2 | 3};' +
          ' use null for the trail only when there is none to rewrite, and for progress when the copy reports none.',
      ].join('\n') + suffix
    );
  }

  const { captions } = job.input;
  const numbered =
    captions.length === 0
      ? '(none)'
      : captions.map((caption, index) => `${index + 1}. ${caption}`).join('\n');

  return [
    'KIND: article',
    '',
    'HEADLINE:',
    job.input.headline,
    '',
    'STANDFIRST:',
    job.input.standfirst ?? '(none)',
    '',
    `CAPTIONS (${captions.length}):`,
    numbered,
    '',
    'BODY HTML:',
    job.input.bodyHtml,
    '',
    ...renderContext(job.input.context ?? []),
    `Return exactly ${captions.length} caption${captions.length === 1 ? '' : 's'}, ` +
      'in the same order as the input. Use null for the standfirst only when there is none to rewrite,' +
      ' and for progress when the copy reports no response or progress. Score the upside from the whole body.' +
      ' Return {"text", "sourceUrl"} for context only when one CONTEXT item reports a concrete response or' +
      ' improvement, built from that item alone; otherwise null.',
  ].join('\n') + suffix;
}

/**
 * Earlier Guardian coverage, one block per item. Each carries the URL the
 * rewriter must cite and the excerpt that is the only text it may draw on.
 */
function renderContext(items: readonly ContextItem[]): string[] {
  if (items.length === 0) return ['CONTEXT: (none)', ''];
  const lines = [`CONTEXT (${items.length} earlier Guardian piece${items.length === 1 ? '' : 's'} on this story; excerpts only):`];
  items.forEach((item, index) => {
    lines.push(
      '',
      `[${index + 1}] ${item.url}`,
      `Published: ${item.publishedAt.slice(0, 10)}`,
      `Headline: ${item.headline}`,
      ...(item.trail ? [`Trail: ${item.trail}`] : []),
      `Excerpt: ${item.excerpt}`,
    );
  });
  lines.push('');
  return lines;
}

/**
 * Params for one rewrite job, usable as-is for client.messages.create or as the
 * `params` of a Message Batches request.
 *
 * The system prompt is the only large shared prefix, so it carries the single
 * cache_control breakpoint: the varying job input sits after it in `messages`
 * and is never part of a cached prefix (shared/prompt-caching.md, "Shared
 * prefix, varying suffix").
 */
export function buildRewriteRequest(
  job: Job,
  systemPrompt: string,
  model: string = rewriteModel(),
  revision?: Revision,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: maxTokensFor(job.kind),
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    // Sonnet 5: adaptive thinking only. budget_tokens is rejected.
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: outputSchemaFor(job.kind) },
      // Thinking is billed and capped inside max_tokens, and `effort` defaults to
      // `high`. A preview is a headline and one sentence inside 400 tokens, so a
      // high-effort think would truncate it; an article has room to think.
      ...(job.kind === 'preview' ? { effort: 'low' as const } : {}),
    },
    messages: [{ role: 'user', content: renderJobInput(job, revision) }],
    // No assistant prefill: current models reject a trailing assistant turn here.
  };
}

/**
 * Params for one fact check. No thinking and no cache_control: Haiku 4.5 does
 * not take adaptive thinking, and its 4,096-token cache minimum is well above
 * this prompt, so a breakpoint would only ever pay the write premium.
 */
export function buildCheckRequest(
  original: string,
  rewrite: string,
  systemPrompt: string,
  model: string = checkModel(),
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: CHECK_MAX_TOKENS,
    system: systemPrompt,
    output_config: { format: { type: 'json_schema', schema: CHECK_OUTPUT_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: ['ORIGINAL:', original, '', 'REWRITE:', rewrite].join('\n'),
      },
    ],
  };
}

/**
 * Params for one tone review. The system prompt is the review rubric followed
 * by the rewrite brief, which is the same for every job, so it carries the
 * cache breakpoint; the pair under review sits in `messages`. Adaptive
 * thinking at low effort: this is a judgement, not a transcription, but the
 * verdict is short.
 */
export function buildToneRequest(
  original: string,
  rewrite: string,
  systemPrompt: string,
  model: string = toneModel(),
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: TONE_MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: CHECK_OUTPUT_SCHEMA }, effort: 'low' },
    messages: [
      {
        role: 'user',
        content: ['ORIGINAL:', original, '', 'REWRITE:', rewrite].join('\n'),
      },
    ],
  };
}

/* ---------- Responses ---------- */

const ArticleOutput = z.object({
  headline: z.string().min(1),
  standfirst: z.union([z.string(), z.null()]),
  bodyHtml: z.string().min(1),
  captions: z.array(z.string()),
  // Optional so hand-written claude-code parts from before the progress line still parse.
  progress: z.union([z.string(), z.null()]).optional(),
  upside: z.number().int().min(0).max(3).optional(),
  context: z
    .union([z.object({ text: z.string().min(1), sourceUrl: z.string().url() }), z.null()])
    .optional(),
});

const PreviewOutput = z.object({
  headline: z.string().min(1),
  trail: z.union([z.string(), z.null()]),
  progress: z.union([z.string(), z.null()]).optional(),
  upside: z.number().int().min(0).max(3).optional(),
});

const CheckOutput = z.object({
  ok: z.boolean(),
  issues: z.array(z.string()),
});

function describeZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** `null` and blank strings both mean "no value" in our contract. */
function optional(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function failed(job: Job, error: string): JobResult {
  return { id: job.id, kind: job.kind, error };
}

/** Concatenated text of a message, ignoring thinking blocks. */
export function messageText(message: Pick<Anthropic.Message, 'content'>): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Turn the model's text into a JobResult. Structured output should make this
 * total, but a JobResult error is cheaper than a broken page: anything that is
 * not valid JSON, does not match the schema, or returns the wrong number of
 * captions becomes `{id, kind, error}` and is published headline-only.
 */
export function parseRewriteOutput(job: Job, text: string): JobResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return failed(job, `model did not return JSON (${errorMessage(error)})`);
  }

  if (job.kind === 'article') {
    const parsed = ArticleOutput.safeParse(value);
    if (!parsed.success) {
      return failed(job, `output did not match the article schema — ${describeZodIssues(parsed.error)}`);
    }
    const expected = job.input.captions.length;
    if (parsed.data.captions.length !== expected) {
      return failed(
        job,
        `expected ${expected} caption${expected === 1 ? '' : 's'}, got ${parsed.data.captions.length}`,
      );
    }
    const output: ArticleJobOutput = {
      headline: parsed.data.headline.trim(),
      bodyHtml: parsed.data.bodyHtml,
      captions: parsed.data.captions,
    };
    const standfirst = optional(parsed.data.standfirst);
    if (standfirst !== undefined) output.standfirst = standfirst;
    const progress = optional(parsed.data.progress ?? null);
    if (progress !== undefined) output.progress = progress;
    if (parsed.data.upside !== undefined) output.upside = parsed.data.upside;
    // The context line is optional and additive, so an uncited one is dropped
    // rather than costing the whole rewrite; assemble.ts applies the same rule.
    const context = parsed.data.context;
    if (context && context.text.trim() && (job.input.context ?? []).some((item) => item.url === context.sourceUrl)) {
      output.context = { text: context.text.trim(), sourceUrl: context.sourceUrl };
    }
    return { id: job.id, kind: 'article', output };
  }

  const parsed = PreviewOutput.safeParse(value);
  if (!parsed.success) {
    return failed(job, `output did not match the preview schema — ${describeZodIssues(parsed.error)}`);
  }
  const output: PreviewJobOutput = { headline: parsed.data.headline.trim() };
  const trail = optional(parsed.data.trail);
  if (trail !== undefined) output.trail = trail;
  const progress = optional(parsed.data.progress ?? null);
  if (progress !== undefined) output.progress = progress;
  if (parsed.data.upside !== undefined) output.upside = parsed.data.upside;
  return { id: job.id, kind: 'preview', output };
}

/**
 * Turn the checker's text into a CheckResult. A response we cannot read fails
 * closed — an unverified rewrite is demoted to headline-only by assemble.ts
 * rather than published.
 */
export function parseCheckOutput(path: string, text: string): CheckResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { path, ok: false, issues: [`fact check did not return JSON (${errorMessage(error)})`] };
  }
  const parsed = CheckOutput.safeParse(value);
  if (!parsed.success) {
    return {
      path,
      ok: false,
      issues: [`fact check did not match the schema — ${describeZodIssues(parsed.error)}`],
    };
  }
  return { path, ok: parsed.data.ok, issues: parsed.data.issues };
}

/* ---------- Batch custom ids ---------- */

const SAFE_CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A custom_id for one batch request.
 *
 * Job ids look like `a:/environment/2026/sep/23/slug`, which the Batches API
 * will not accept — custom_id is limited to [A-Za-z0-9_-], 64 characters. The
 * index prefix keeps the result unique even after truncation, and the rest is
 * kept readable so a raw .jsonl is still legible. Results are matched back to
 * jobs through this id, never through order.
 */
export function batchCustomId(job: Job, index: number): string {
  if (SAFE_CUSTOM_ID.test(job.id)) return job.id;
  const slug = job.id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${index}-${slug}`.slice(0, 64);
}

/* ---------- Usage and cost ---------- */

export interface TokenTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface Prices {
  /** USD per million tokens. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * Claude Sonnet 5 is $2/$10 per MTok; the Batches API is 50% off, so $1/$5.
 * Cache reads are 0.1x base input and cache writes 1.25x (5-minute TTL).
 */
export const SONNET_5_BATCH_PRICES: Prices = {
  input: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5,
};

/** The same table without the batch discount, for --no-batch runs. */
export const SONNET_5_STANDARD_PRICES: Prices = {
  input: 2,
  cacheWrite: 2.5,
  cacheRead: 0.2,
  output: 10,
};

export function emptyTotals(): TokenTotals {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/** Fold one response's `usage` into a running total. */
export function addUsage(
  totals: TokenTotals,
  usage: Partial<Anthropic.Usage> | null | undefined,
): TokenTotals {
  if (!usage) return totals;
  totals.input += usage.input_tokens ?? 0;
  totals.cacheRead += usage.cache_read_input_tokens ?? 0;
  totals.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  totals.output += usage.output_tokens ?? 0;
  return totals;
}

/** Dollars, at the given per-MTok price table. */
export function estimateCostUsd(totals: TokenTotals, prices: Prices): number {
  return (
    (totals.input * prices.input +
      totals.cacheWrite * prices.cacheWrite +
      totals.cacheRead * prices.cacheRead +
      totals.output * prices.output) /
    1_000_000
  );
}

const n = (value: number): string => value.toLocaleString('en-GB');

/** One line of token totals and an estimated cost. */
export function formatUsage(totals: TokenTotals, prices: Prices, label: string): string {
  const cost = estimateCostUsd(totals, prices);
  return (
    `tokens: ${n(totals.input)} input, ${n(totals.cacheRead)} cache read, ` +
    `${n(totals.cacheWrite)} cache write, ${n(totals.output)} output — ` +
    `est. $${cost.toFixed(4)} at ${label}`
  );
}
