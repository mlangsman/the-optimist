/**
 * Shared data contract for The Optimist pipeline and site.
 *
 * Pipeline:  raw.json  --(jobs)-->  jobs.json  --(engine)-->  results.json  --(assemble)-->  site.json
 * The Astro site reads exactly one file: data/latest.json (a SiteData).
 */

export type Engine = 'claude-code' | 'api';

export interface Image {
  /** Guardian CDN URL (i.guim.co.uk). Hot-linked, never re-hosted. */
  src: string;
  alt?: string;
  credit?: string;
  width?: number;
  height?: number;
}

export interface Original {
  headline: string;
  trail?: string;
  standfirst?: string;
  byline?: string;
  /** Absolute theguardian.com URL. */
  url: string;
}

/** A card on the front page or in an article's related rail. */
export interface Card {
  /** Guardian content path, e.g. "/environment/2026/sep/23/slug". Unique key. */
  path: string;
  /** True only when a full rewritten Article exists for this path (News block). */
  linked: boolean;
  /** Small label above the headline, e.g. "Environment". */
  kicker?: string;
  /** Rewritten headline. */
  headline: string;
  /** Rewritten trail text (standfirst-style excerpt). */
  trail?: string;
  image?: Image;
  /** Pseudonymised byline (see scripts/bylines.ts). */
  byline?: string;
  original: Original;
}

export interface FrontContainer {
  /** Guardian container id, e.g. "news", "highlights", "opinion". */
  id: string;
  /** Display title, e.g. "News". */
  title: string;
  cards: Card[];
}

export type ArticleStatus = 'rewritten' | 'headline-only';

export interface Article {
  path: string;
  url: string;
  section: { id: string; name: string };
  /** ISO 8601 */
  publishedAt: string;
  headline: string;
  standfirst?: string;
  /** Rewritten body. Same tag structure as the original (p, h2, blockquote, figure, ul/li, a). */
  bodyHtml: string;
  /** Pseudonymised byline. */
  byline?: string;
  mainImage?: Image;
  /** Related stories — always unlinked. */
  related: Card[];
  /** 'headline-only' when the rewrite was skipped or failed the fact check. */
  status: ArticleStatus;
  original: Original & { bodyHtml: string };
}

/** The single input to the site build. Written to data/YYYY-MM-DD/site.json and copied to data/latest.json. */
export interface SiteData {
  /** YYYY-MM-DD (Europe/London) */
  date: string;
  /** ISO 8601 */
  generatedAt: string;
  engine: Engine;
  front: FrontContainer[];
  /** Keyed by Card.path. */
  articles: Record<string, Article>;
}

/* ---------- Pipeline intermediates ---------- */

export interface RawCard {
  path: string;
  /** Headline as shown on the front page card (aria-label / card text). */
  headline?: string;
  image?: Image;
}

export interface RawContainer {
  id: string;
  title: string;
  cards: RawCard[];
}

/** Content API item, trimmed to what we use. */
export interface RawArticle {
  path: string;
  url: string;
  section: { id: string; name: string };
  publishedAt: string;
  headline: string;
  standfirst?: string;
  trail?: string;
  bodyHtml: string;
  byline?: string;
  mainImage?: Image;
  /** Tag ids, e.g. "tone/minutebyminute". */
  tags: string[];
  /** Related content from show-related=true, headline + trail only. */
  related: Array<Pick<RawArticle, 'path' | 'url' | 'section' | 'headline' | 'trail' | 'byline' | 'mainImage'>>;
}

export interface RawData {
  date: string;
  fetchedAt: string;
  front: RawContainer[];
  /** Full articles for the News block, keyed by path. */
  articles: Record<string, RawArticle>;
  /** Headline + trail for every other card and related item, keyed by path. */
  previews: Record<string, Pick<RawArticle, 'path' | 'url' | 'section' | 'headline' | 'trail' | 'byline' | 'mainImage' | 'tags'>>;
}

/* ---------- Rewrite engine contract ---------- */

export interface ArticleJobInput {
  headline: string;
  standfirst?: string;
  bodyHtml: string;
  /** Figure captions found in bodyHtml, in order. */
  captions: string[];
}

export interface PreviewJobInput {
  headline: string;
  trail?: string;
}

export type Job =
  | { id: string; kind: 'article'; path: string; input: ArticleJobInput }
  | { id: string; kind: 'preview'; path: string; input: PreviewJobInput };

export interface ArticleJobOutput {
  headline: string;
  standfirst?: string;
  bodyHtml: string;
  captions: string[];
}

export interface PreviewJobOutput {
  headline: string;
  trail?: string;
}

export type JobResult =
  | { id: string; kind: 'article'; output: ArticleJobOutput }
  | { id: string; kind: 'preview'; output: PreviewJobOutput }
  | { id: string; kind: 'article' | 'preview'; error: string };

export interface JobsFile {
  date: string;
  /** Path to the shared system prompt used by every engine. */
  systemPromptPath: string;
  jobs: Job[];
}

export interface ResultsFile {
  date: string;
  engine: Engine;
  results: JobResult[];
}

/** Output of the fact-check pass (scripts/check.ts). */
export interface CheckResult {
  path: string;
  ok: boolean;
  /** Claims in the rewrite not supported by, or contradicting, the original. */
  issues: string[];
}
