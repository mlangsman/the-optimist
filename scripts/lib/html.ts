/**
 * Small HTML helpers shared by jobs.ts and assemble.ts.
 */
import * as cheerio from 'cheerio';

/** Plain text of an HTML fragment, with entities decoded and whitespace collapsed. */
export function stripTags(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const text = cheerio.load(html, null, false).root().text().replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

/** Text of every <figcaption> in a body, in document order. */
export function extractCaptions(bodyHtml: string): string[] {
  const $ = cheerio.load(bodyHtml, null, false);
  return $('figcaption')
    .toArray()
    .map((element) => $(element).text().replace(/\s+/g, ' ').trim());
}

/**
 * Write rewritten captions back into a body's <figcaption>s, in order.
 * Extra captions are ignored; missing ones leave the original text in place.
 */
export function applyCaptions(bodyHtml: string, captions: readonly string[]): string {
  if (captions.length === 0) return bodyHtml;
  const $ = cheerio.load(bodyHtml, null, false);
  $('figcaption').each((index, element) => {
    const replacement = captions[index];
    if (typeof replacement === 'string' && replacement.length > 0) {
      $(element).text(replacement);
    }
  });
  return $.root().html() ?? bodyHtml;
}

/**
 * A standfirst as plain text: the first paragraph only. Guardian standfirsts are
 * HTML and sometimes carry a trailing <ul> of related links we never want.
 */
export function standfirstText(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const $ = cheerio.load(html, null, false);
  const first = $('p').first();
  const text = (first.length > 0 ? first.text() : $.root().text()).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}
