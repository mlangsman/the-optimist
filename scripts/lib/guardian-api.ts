/**
 * Guardian Content API client.
 *
 * Developer keys are limited to roughly one request per second, so every call
 * goes through a single sequential queue with a fixed gap, one retry on 429/5xx,
 * and a hard cap on the number of requests per process run.
 *
 * The API key is never logged: error messages are built from a redacted URL.
 */
import { z } from 'zod';
import type { Image, RawArticle, RawData } from '../../src/lib/types.js';

export type RawPreview = RawData['previews'][string];
export type RawRelated = RawArticle['related'][number];

const API_BASE = 'https://content.guardianapis.com';
const WEB_BASE = 'https://www.theguardian.com';

/** Gap between requests (developer keys allow ~1/sec; 250 ms plus latency stays clear). */
export const REQUEST_GAP_MS = 250;
/** Backoff before the single retry. */
const RETRY_DELAY_MS = 1_500;
/** Safety valve: one run must never hammer the API. */
export const MAX_REQUESTS_PER_RUN = 200;

const ITEM_FIELDS = 'headline,standfirst,trailText,body,byline,thumbnail,main,lastModified';
const PREVIEW_FIELDS = 'headline,trailText,byline,thumbnail';

/* ---------- response schemas (unknown at the boundary, validated with zod) ---------- */

const fieldsSchema = z
  .object({
    headline: z.string().optional(),
    standfirst: z.string().optional(),
    trailText: z.string().optional(),
    body: z.string().optional(),
    byline: z.string().optional(),
    thumbnail: z.string().optional(),
  })
  .optional();

const assetSchema = z.object({
  type: z.string().optional(),
  file: z.string().optional(),
  typeData: z
    .object({
      secureFile: z.string().optional(),
      width: z.union([z.string(), z.number()]).optional(),
      height: z.union([z.string(), z.number()]).optional(),
      alt: z.string().optional(),
      altText: z.string().optional(),
      credit: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
});

const elementSchema = z.object({
  id: z.string().optional(),
  relation: z.string().optional(),
  type: z.string().optional(),
  assets: z.array(assetSchema).optional(),
});

const tagSchema = z.object({ id: z.string() });

const contentSchema = z.object({
  id: z.string(),
  webUrl: z.string(),
  webTitle: z.string().optional(),
  sectionId: z.string().optional(),
  sectionName: z.string().optional(),
  webPublicationDate: z.string().optional(),
  fields: fieldsSchema,
  tags: z.array(tagSchema).optional(),
  elements: z.array(elementSchema).optional(),
});

const itemResponseSchema = z.object({
  response: z.object({
    status: z.string(),
    content: contentSchema.optional(),
    relatedContent: z.array(contentSchema).optional(),
    message: z.string().optional(),
  }),
});

type Content = z.infer<typeof contentSchema>;

/* ---------- rate-limited request queue ---------- */

let queue: Promise<unknown> = Promise.resolve();
let requestCount = 0;
let failureCount = 0;

export function getRequestCount(): number {
  return requestCount;
}

export function getFailureCount(): number {
  return failureCount;
}

/** Test/utility hook: reset the per-run counters and the queue. */
export function resetRequestBudget(): void {
  queue = Promise.resolve();
  requestCount = 0;
  failureCount = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    await sleep(REQUEST_GAP_MS);
    return task();
  });
  // Keep the chain alive regardless of individual failures.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function buildUrl(path: string, apiKey: string, params: Record<string, string>): URL {
  const url = new URL(API_BASE + (path.startsWith('/') ? path : `/${path}`));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('api-key', apiKey);
  return url;
}

/** URL for error messages — identical to the request, minus the key. */
function redactUrl(url: URL): string {
  const safe = new URL(url.toString());
  safe.searchParams.set('api-key', 'REDACTED');
  return safe.toString();
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** One rate-limited GET, validated with `schema`. Retries once on 429/5xx. */
async function requestJson<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
  return enqueue(async () => {
    if (requestCount >= MAX_REQUESTS_PER_RUN) {
      throw new Error(
        `Guardian API request cap reached (${MAX_REQUESTS_PER_RUN} per run); skipping ${url.pathname}`,
      );
    }

    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      requestCount++;
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'the-optimist/0.1' },
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        break;
      }

      if (!response.ok) {
        lastError = `HTTP ${response.status} ${response.statusText}`;
        if (attempt === 0 && isRetryable(response.status)) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        failureCount++;
        throw new Error(`Guardian API ${lastError} for ${redactUrl(url)}`);
      }

      const body: unknown = await response.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        failureCount++;
        throw new Error(
          `Unexpected Guardian API response for ${url.pathname}: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        );
      }
      return parsed.data;
    }

    failureCount++;
    throw new Error(`Guardian API request failed for ${redactUrl(url)}: ${lastError}`);
  });
}

/* ---------- mapping ---------- */

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Largest main-image asset, falling back to fields.thumbnail. */
function toMainImage(content: Content): Image | undefined {
  const main = (content.elements ?? []).find(
    (element) => element.relation === 'main' && (element.type ?? 'image') === 'image',
  );

  if (main?.assets?.length) {
    let best: (typeof main.assets)[number] | undefined;
    let bestWidth = -1;
    for (const asset of main.assets) {
      const src = asset.typeData?.secureFile ?? asset.file;
      if (!src || !src.startsWith('https://')) continue;
      const width = toNumber(asset.typeData?.width) ?? 0;
      if (width > bestWidth) {
        bestWidth = width;
        best = asset;
      }
    }
    const src = best?.typeData?.secureFile ?? best?.file;
    if (src) {
      const image: Image = { src };
      const alt = best?.typeData?.alt ?? best?.typeData?.altText;
      if (alt) image.alt = alt;
      if (best?.typeData?.credit) image.credit = best.typeData.credit;
      const width = toNumber(best?.typeData?.width);
      const height = toNumber(best?.typeData?.height);
      if (width) image.width = width;
      if (height) image.height = height;
      return image;
    }
  }

  const thumbnail = content.fields?.thumbnail;
  return thumbnail ? { src: thumbnail } : undefined;
}

function contentPath(content: Content): string {
  return content.id.startsWith('/') ? content.id : `/${content.id}`;
}

function toRelated(content: Content): RawRelated {
  const related: RawRelated = {
    path: contentPath(content),
    url: content.webUrl,
    section: {
      id: content.sectionId ?? '',
      name: content.sectionName ?? '',
    },
    headline: content.fields?.headline ?? content.webTitle ?? '',
  };
  const trail = content.fields?.trailText;
  if (trail) related.trail = trail;
  const byline = content.fields?.byline;
  if (byline) related.byline = byline;
  const image = toMainImage(content);
  if (image) related.mainImage = image;
  return related;
}

function toPreview(content: Content): RawPreview {
  const preview: RawPreview = {
    ...toRelated(content),
    tags: (content.tags ?? []).map((tag) => tag.id),
  };
  return preview;
}

function toArticle(content: Content, relatedContent: Content[]): RawArticle {
  const article: RawArticle = {
    path: contentPath(content),
    url: content.webUrl,
    section: {
      id: content.sectionId ?? '',
      name: content.sectionName ?? '',
    },
    publishedAt: content.webPublicationDate ?? '',
    headline: content.fields?.headline ?? content.webTitle ?? '',
    bodyHtml: content.fields?.body ?? '',
    tags: (content.tags ?? []).map((tag) => tag.id),
    related: relatedContent.slice(0, 6).map(toRelated),
  };
  const standfirst = content.fields?.standfirst;
  if (standfirst) article.standfirst = standfirst;
  const trail = content.fields?.trailText;
  if (trail) article.trail = trail;
  const byline = content.fields?.byline;
  if (byline) article.byline = byline;
  const image = toMainImage(content);
  if (image) article.mainImage = image;
  return article;
}

/* ---------- public API ---------- */

/** Absolute theguardian.com URL for a content path. */
export function webUrlFor(path: string): string {
  return WEB_BASE + (path.startsWith('/') ? path : `/${path}`);
}

/** Full article: body, standfirst, tags, main image and up to 6 related items. */
export async function fetchItem(path: string, apiKey: string): Promise<RawArticle> {
  const url = buildUrl(path, apiKey, {
    'show-fields': ITEM_FIELDS,
    'show-tags': 'contributor,tone,type',
    'show-elements': 'image',
    'show-related': 'true',
  });
  const data = await requestJson(url, itemResponseSchema);
  if (data.response.status !== 'ok' || !data.response.content) {
    throw new Error(
      `Guardian API returned status "${data.response.status}" for ${path}` +
        (data.response.message ? `: ${data.response.message}` : ''),
    );
  }
  return toArticle(data.response.content, data.response.relatedContent ?? []);
}

/** Headline + trail + byline + thumbnail only. Used for every non-News card. */
export async function fetchPreview(path: string, apiKey: string): Promise<RawPreview> {
  const url = buildUrl(path, apiKey, {
    'show-fields': PREVIEW_FIELDS,
    'show-tags': 'tone,type',
  });
  const data = await requestJson(url, itemResponseSchema);
  if (data.response.status !== 'ok' || !data.response.content) {
    throw new Error(
      `Guardian API returned status "${data.response.status}" for ${path}` +
        (data.response.message ? `: ${data.response.message}` : ''),
    );
  }
  return toPreview(data.response.content);
}
