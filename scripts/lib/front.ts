/**
 * Front page parser for https://www.theguardian.com/uk.
 *
 * Pure: HTML in, RawContainer[] out. No I/O, no network. See front.test.ts.
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Image, RawCard, RawContainer } from '../../src/lib/types.js';

/** Words that should stay upper-cased when a container id is turned into a title. */
const ACRONYMS = new Set(['uk', 'us', 'usa', 'eu', 'ai', 'tv', 'nhs', 'bbc', 'mp', 'mps']);

/**
 * The highlights strip above #news has no id, only an inline custom property.
 * Everything else is a real container section with a data-component.
 */
const HIGHLIGHTS_SELECTOR = 'section[style*="--highlights-container-background"]';
const CONTAINER_SELECTOR = 'section[data-component][id]';

/**
 * Card links come in two flavours depending on the container layout:
 *  - flexible/static containers: data-link-name="news | group-0 | card-@3 | media-picture"
 *  - some scrollable containers: data-link-name="article"
 * Sub-links inside a card carry no data-link-name at all and are ignored.
 */
const CARD_ANCHOR_SELECTOR = 'a[data-link-name*="card-@"], a[data-link-name="article"]';

/** Matches the /YYYY/mon/DD/ segment every Guardian article path contains. */
const DATE_SEGMENT = /\/\d{4}\/[a-z]{3}\/\d{1,2}\//;

/** "climate-crisis-&amp;-environment" -> "Climate Crisis & Environment", "the-long-read-" -> "The Long Read". */
export function titleFromId(id: string): string {
  const cleaned = id
    .replace(/&amp;/g, '&')
    .replace(/-+$/, '')
    .trim();
  const words = cleaned.split('-').filter((w) => w.length > 0);
  if (words.length === 0) return id;
  return words
    .map((word) => {
      if (word === '&') return '&';
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * True for hrefs that look like a Guardian content path we can ask the Content API about.
 * Liveblogs (/politics/live/...) pass — filtering by tone happens later in jobs.ts.
 */
export function isArticlePath(href: string | undefined): href is string {
  if (!href) return false;
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  if (href.includes('#') || href.includes('?')) return false;
  return DATE_SEGMENT.test(href);
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractImage($: cheerio.CheerioAPI, anchor: cheerio.Cheerio<AnyNode>): Image | undefined {
  const card = anchor.closest('li');
  const scope = card.length > 0 ? card : anchor.parent();
  const img = scope.find('img[src]').first();
  if (img.length === 0) return undefined;

  const src = img.attr('src')?.trim();
  if (!src || !/^https?:\/\//i.test(src)) return undefined;

  const image: Image = { src: cardImageUrl(src) };
  const alt = normaliseWhitespace(img.attr('alt') ?? '');
  if (alt) image.alt = alt;

  const width = Number.parseInt(img.attr('width') ?? '', 10);
  const height = Number.parseInt(img.attr('height') ?? '', 10);
  if (Number.isFinite(width) && width > 0) image.width = width;
  if (Number.isFinite(height) && height > 0) image.height = height;

  return image;
}

function extractHeadline(
  $: cheerio.CheerioAPI,
  anchor: cheerio.Cheerio<AnyNode>,
): string | undefined {
  const aria = normaliseWhitespace(anchor.attr('aria-label') ?? '');
  if (aria) return aria;

  const own = normaliseWhitespace(anchor.text());
  if (own) return own;

  const card = anchor.closest('li');
  if (card.length > 0) {
    const heading = normaliseWhitespace(card.find('h2, h3').first().text());
    if (heading) return heading;
  }
  return undefined;
}

function parseCards($: cheerio.CheerioAPI, section: cheerio.Cheerio<AnyNode>): RawCard[] {
  const cards: RawCard[] = [];
  const byPath = new Map<string, RawCard>();

  section.find(CARD_ANCHOR_SELECTOR).each((_i, element) => {
    const anchor = $(element);
    const href = anchor.attr('href')?.trim();
    if (!isArticlePath(href)) return;

    const headline = extractHeadline($, anchor);
    const image = extractImage($, anchor);

    const existing = byPath.get(href);
    if (existing) {
      // Same card, second anchor (picture + headline). Keep the first, but fill the gaps.
      if (!existing.headline && headline) existing.headline = headline;
      if (!existing.image && image) existing.image = image;
      return;
    }

    const card: RawCard = { path: href };
    if (headline) card.headline = headline;
    if (image) card.image = image;
    byPath.set(href, card);
    cards.push(card);
  });

  return cards;
}

/**
 * Parse the Guardian UK front page into ordered containers of cards.
 * Containers with no article-like cards (thrashers, ad slots, trending topics) are dropped.
 */
/**
 * Front-page cards link to tiny renditions (width=98 for the highlights strip).
 * The Guardian image CDN resizes on request, so ask for a card-sized one instead.
 */
export function cardImageUrl(src: string): string {
  try {
    const url = new URL(src);
    if (url.hostname !== 'i.guim.co.uk') return src;
    url.searchParams.set('width', '620');
    url.searchParams.set('dpr', '1');
    return url.toString();
  } catch {
    return src;
  }
}

export function parseFront(html: string): RawContainer[] {
  const $ = cheerio.load(html);
  const containers: RawContainer[] = [];
  const seenIds = new Set<string>();

  // A single combined selector keeps the sections in document order, so the
  // unnamed highlights strip lands above #news exactly as it does on the page.
  $(`${HIGHLIGHTS_SELECTOR}, ${CONTAINER_SELECTOR}`).each((_i, element) => {
    const section = $(element);
    const rawId = section.attr('id');
    const id = rawId ? rawId.replace(/&amp;/g, '&').trim() : 'highlights';
    if (seenIds.has(id)) return;

    const cards = parseCards($, section);
    if (cards.length === 0) return;

    seenIds.add(id);
    containers.push({
      id,
      title: id === 'highlights' ? 'Highlights' : titleFromId(id),
      cards,
    });
  });

  return containers;
}
