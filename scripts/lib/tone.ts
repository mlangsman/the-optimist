/**
 * Deterministic tone lint for rewritten copy. No network, no model.
 *
 * It cannot judge optimism, but it catches the two ways a rewrite most often
 * fails the brief without anyone noticing:
 *
 *   1. A cosmetic edit — "warns" swapped for "says" and nothing else moved.
 *      Measured as token overlap with the original.
 *   2. A headline whose centre of gravity is still a word of loss, harm,
 *      threat or fear (the brief's "third rule"), or a standfirst, trail or
 *      opening paragraph leaning on the same vocabulary.
 *   3. A headline stretched long to hold every step of the response — a
 *      warning, since the brief wants short, warm headlines.
 *
 * Quoted spans are exempt: a quote is a fact, and the brief says quotes stay.
 * Everything here is pure so scripts/lib/tone.test.ts can pin it down.
 */
import type { ArticleJobOutput, Job, PreviewJobOutput } from '../../src/lib/types.js';
import { stripTags } from './html.js';

/**
 * Words that mark a headline as centred on the setback. Kept to words that are
 * nearly always the writer's own choice rather than a fact: "died" is a fact
 * and stays; "bleak" is a verdict.
 */
export const DOOM_TERMS: readonly string[] = [
  'alarm',
  'alarming',
  'bleak',
  'blow',
  'catastrophe',
  'catastrophic',
  'chaos',
  'collapse',
  'collapses',
  'collapsing',
  'crackdown',
  'crisis',
  'crumbling',
  'devastated',
  'devastating',
  'dire',
  'disaster',
  'disastrous',
  'doom',
  'doomed',
  'dread',
  'fear',
  'feared',
  'fears',
  'freefall',
  'fury',
  'furious',
  'grim',
  'horrific',
  'horror',
  'meltdown',
  'nightmare',
  'outrage',
  'panic',
  'perilous',
  'plunge',
  'plunges',
  'row',
  'scramble',
  'scrambles',
  'slam',
  'slams',
  'blast',
  'blasts',
  'spiral',
  'spiralling',
  'threat',
  'threatens',
  'threatened',
  'turmoil',
  'under fire',
  'warn',
  'warned',
  'warning',
  'warns',
  'worst',
];

/**
 * Compounds the Guardian's style guide requires, so they never count. "Climate
 * crisis" is house style; a headline built on it is judged by the model review,
 * not here.
 */
export const ALLOWED_PHRASES: readonly string[] = ['climate crisis', 'cost of living crisis'];

/**
 * A rewritten headline longer than this many words, and longer than the
 * original, reads like a list of procedural steps rather than a headline.
 */
export const HEADLINE_MAX_WORDS = 14;

/** A rewrite sharing at least this fraction of its tokens with the original is a cosmetic edit. */
export const COSMETIC_EDIT_THRESHOLD = 0.85;

export type Severity = 'error' | 'warning';

export interface ToneIssue {
  path: string;
  kind: Job['kind'];
  /** Which piece of copy: headline, standfirst, trail or opening. */
  field: 'headline' | 'standfirst' | 'trail' | 'opening';
  severity: Severity;
  issue: string;
}

/** Drop single- and double-quoted spans, straight or curly. */
export function withoutQuotes(text: string): string {
  return text
    .replace(/[‘'][^‘’']*[’']/g, ' ')
    .replace(/[“"][^“”"]*[”"]/g, ' ')
    // A quote that opens and never closes: drop the rest of the string.
    .replace(/[‘“].*$/g, ' ');
}

/** Lowercase word tokens, punctuation stripped. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Fraction of the longer text's tokens that also appear in the shorter one.
 * 1 means the same words in some order; 0 means nothing shared.
 */
export function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const longer = ta.length >= tb.length ? ta : tb;
  const shorter = new Set(ta.length >= tb.length ? tb : ta);
  if (longer.length === 0) return 1;
  let shared = 0;
  for (const token of longer) if (shorter.has(token)) shared++;
  return shared / longer.length;
}

/** Doom terms that appear in the text outside quotation marks and allowed phrases. */
export function doomTerms(text: string): string[] {
  let scan = withoutQuotes(text).toLowerCase();
  for (const phrase of ALLOWED_PHRASES) scan = scan.split(phrase).join(' ');
  const found: string[] = [];
  for (const term of DOOM_TERMS) {
    const pattern = new RegExp(`(^|[^a-z])${term.replace(/ /g, '\\s+')}(?=$|[^a-z])`, 'i');
    if (pattern.test(scan)) found.push(term);
  }
  return found;
}

function firstParagraph(bodyHtml: string): string | undefined {
  const match = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(bodyHtml);
  return match ? stripTags(match[1]) : undefined;
}

interface Copy {
  headline: { original: string; rewrite: string };
  secondary?: { field: 'standfirst' | 'trail'; original?: string; rewrite?: string };
  opening?: { rewrite: string };
}

/**
 * Does the original copy carry a setback at all? A recipe or a newsletter
 * sign-up has nothing to re-angle, so leaving it nearly alone is fine. A
 * headline built on "bleak" or "warns" has to move, and a cosmetic edit of
 * it is the failure this lint exists to catch.
 */
export function hasSetback(...texts: Array<string | undefined>): boolean {
  return doomTerms(texts.filter((text): text is string => text !== undefined).join(' ')).length > 0;
}

function lint(path: string, kind: Job['kind'], copy: Copy): ToneIssue[] {
  const issues: ToneIssue[] = [];
  const add = (field: ToneIssue['field'], severity: Severity, issue: string): void => {
    issues.push({ path, kind, field, severity, issue });
  };

  const { original, rewrite } = copy.headline;
  const setback = hasSetback(original, copy.secondary?.original);
  // A cosmetic edit of a setback headline is an error; of a recipe, a warning.
  const cosmeticSeverity: Severity = setback ? 'error' : 'warning';
  const headlineOverlap = overlap(original, rewrite);
  if (rewrite.trim() === original.trim()) {
    add('headline', cosmeticSeverity, `headline is unchanged from the original: "${rewrite}"`);
  } else if (headlineOverlap >= COSMETIC_EDIT_THRESHOLD) {
    add(
      'headline',
      cosmeticSeverity,
      `headline is a cosmetic edit of the original (${Math.round(headlineOverlap * 100)} per cent of the words are the same): "${rewrite}"`,
    );
  }
  const words = tokens(withoutQuotes(rewrite)).length;
  if (words > HEADLINE_MAX_WORDS && words > tokens(withoutQuotes(original)).length) {
    add(
      'headline',
      'warning',
      `headline is ${words} words; keep it to ${HEADLINE_MAX_WORDS} or fewer and move the detail to the trail: "${rewrite}"`,
    );
  }
  const headlineDoom = doomTerms(rewrite);
  if (headlineDoom.length > 0) {
    add('headline', 'error', `headline is centred on ${headlineDoom.map((t) => `"${t}"`).join(', ')}: "${rewrite}"`);
  }

  if (copy.secondary?.rewrite) {
    const { field, rewrite: text } = copy.secondary;
    const doom = doomTerms(text);
    if (doom.length > 0) {
      add(field, 'warning', `${field} leans on ${doom.map((t) => `"${t}"`).join(', ')}: "${text}"`);
    }
  }

  if (copy.opening) {
    const doom = doomTerms(copy.opening.rewrite);
    if (doom.length > 0) {
      add('opening', 'warning', `opening paragraph leans on ${doom.map((t) => `"${t}"`).join(', ')}`);
    }
  }
  return issues;
}

export function lintPreview(job: Extract<Job, { kind: 'preview' }>, output: PreviewJobOutput): ToneIssue[] {
  const secondary: Copy['secondary'] = { field: 'trail' };
  if (job.input.trail !== undefined) secondary.original = job.input.trail;
  if (output.trail !== undefined) secondary.rewrite = output.trail;
  return lint(job.path, 'preview', {
    headline: { original: job.input.headline, rewrite: output.headline },
    secondary,
  });
}

export function lintArticle(job: Extract<Job, { kind: 'article' }>, output: ArticleJobOutput): ToneIssue[] {
  const secondary: Copy['secondary'] = { field: 'standfirst' };
  const originalStandfirst = stripTags(job.input.standfirst);
  const rewriteStandfirst = stripTags(output.standfirst);
  if (originalStandfirst !== undefined) secondary.original = originalStandfirst;
  if (rewriteStandfirst !== undefined) secondary.rewrite = rewriteStandfirst;
  const opening = firstParagraph(output.bodyHtml);
  return lint(job.path, 'article', {
    headline: { original: job.input.headline, rewrite: output.headline },
    secondary,
    ...(opening === undefined ? {} : { opening: { rewrite: opening } }),
  });
}

/** One line per issue, grouped by path, for a terminal. */
export function formatIssues(issues: readonly ToneIssue[]): string {
  const lines: string[] = [];
  let lastPath: string | undefined;
  for (const issue of issues) {
    if (issue.path !== lastPath) {
      lines.push(`${issue.kind} ${issue.path}`);
      lastPath = issue.path;
    }
    lines.push(`  ${issue.severity === 'error' ? 'ERROR' : 'warn '} ${issue.field}: ${issue.issue}`);
  }
  return lines.join('\n');
}
