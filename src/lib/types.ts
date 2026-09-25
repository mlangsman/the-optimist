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
  /** One line on the response or progress in the story ("What's being done"), from the copy's own facts. */
  progress?: string;
  /** The engine's 0–3 score for how strong the story's genuine upside is; the front is ranked by it. */
  upside?: number;
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

/** A context line as published: the text, and the Guardian piece it is drawn from. */
export interface ArticleContext {
  /** 10–30 words, built only from the cited piece. */
  text: string;
  /** Absolute theguardian.com URL of the cited piece. */
  sourceUrl: string;
  sourceHeadline: string;
}

export interface Article {
  path: string;
  url: string;
  section: { id: string; name: string };
  /** ISO 8601 */
  publishedAt: string;
  headline: string;
  standfirst?: string;
  /** One line on the response or progress in the story ("What's being done"), from the copy's own facts. */
  progress?: string;
  /** The engine's 0–3 upside score, judged from the full body. Wins over the preview's on the card. */
  upside?: number;
  /**
   * "Also in the Guardian": one line drawn from earlier Guardian coverage of
   * the same story (scripts/context.ts), with the piece it came from. Shown
   * under the progress line; never part of the headline, standfirst or body.
   */
  context?: ArticleContext;
  /** Rewritten body. Same tag structure as the original (p, h2, blockquote, figure, ul/li, a). */
  bodyHtml: string;
  /** Pseudonymised byline. */
  byline?: string;
  mainImage?: Image;
  /** Related stories — always unlinked. */
  related: Card[];
  /** 'headline-only' when the rewrite was skipped or failed the fact check. */
  status: ArticleStatus;
  /** Headline, standfirst, byline and URL only — the original body is never persisted. */
  original: Original;
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
  /**
   * Recent Guardian stories from constructive sections (science, environment,
   * global development and so on), headline + trail only. The engine picks the
   * genuinely good news among them for the "What's going right" container
   * (data/<date>/going-right.json). Absent in older raw.json files.
   */
  candidates?: Record<string, Pick<RawArticle, 'path' | 'url' | 'section' | 'headline' | 'trail' | 'byline' | 'mainImage' | 'tags'>>;
}

/* ---------- Rewrite engine contract ---------- */

/**
 * One earlier Guardian piece on the same story, found by scripts/context.ts.
 * The engine may draw one context line from it; the fact check verifies that
 * line against `excerpt`, so nothing outside the excerpt may be used.
 */
export interface ContextItem {
  path: string;
  /** Absolute theguardian.com URL. */
  url: string;
  headline: string;
  trail?: string;
  /** ISO 8601 */
  publishedAt: string;
  /** The opening of the piece's body text, plain, capped (see scripts/context.ts). */
  excerpt: string;
}

/** data/<date>/context.json: earlier coverage per article job, keyed by content path. */
export interface ContextFile {
  date: string;
  context: Record<string, ContextItem[]>;
}

export interface ArticleJobInput {
  headline: string;
  standfirst?: string;
  bodyHtml: string;
  /** Figure captions found in bodyHtml, in order. */
  captions: string[];
  /** Earlier Guardian coverage of the same story, when scripts/context.ts ran. */
  context?: ContextItem[];
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
  /** "What's being done": one sentence, 10–25 words, on the response or progress the body reports. Omit when there is none. */
  progress?: string;
  /**
   * How strong the story's genuine upside is, judged from the full body with
   * the same 0–3 scale as a preview. The front-page card uses this over the
   * preview's score. The front drops 0 and demotes 1.
   */
  upside?: number;
  /**
   * "Also in the Guardian": at most one line, 10–30 words, built only from the
   * `excerpt` of one item in the job's `context`, citing that item's `url`.
   * Omit when no item reports a concrete response or improvement.
   */
  context?: { text: string; sourceUrl: string };
}

export interface PreviewJobOutput {
  headline: string;
  trail?: string;
  /** "What's being done": one sentence on the response or progress the headline and trail report. Omit when there is none. */
  progress?: string;
  /**
   * How strong the story's genuine upside is, judged from the original copy:
   * 0 none (a dark story, told with dignity), 1 a response to a setback,
   * 2 real progress alongside a setback, 3 good news in its own right. Pure
   * features, culture and lifestyle score 2. The front is ranked by it.
   */
  upside?: number;
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

/** One reviewer's verdict on one piece of copy. */
export interface Verdict {
  ok: boolean;
  /** One short sentence per problem, quoting the offending words. */
  issues: string[];
}

/**
 * Output of the review pass (scripts/check.ts), one per rewritten job.
 *
 * `ok`/`issues` is the fact check: a failure means the rewrite is not
 * published (an article goes headline-only, a preview falls back to the
 * original). `tone` is the editorial review against prompts/rewrite.md: a
 * failure never blocks publication on its own, but scripts/revise.ts and the
 * daily routine send the copy back with the notes until it passes.
 */
export interface CheckResult {
  path: string;
  /** Defaults to 'article' when absent (older check.json files). */
  kind?: 'article' | 'preview';
  ok: boolean;
  /** Claims in the rewrite not supported by, or contradicting, the original. */
  issues: string[];
  tone?: Verdict;
}
