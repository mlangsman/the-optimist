/**
 * Body HTML sanitiser for the published site.
 *
 * Guardian article bodies carry embeds, custom elements and tracking markup we
 * neither want nor render. Only a small tag/attribute allow-list survives.
 */
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

const GUARDIAN_BASE = 'https://www.theguardian.com';

/** Tag -> attributes kept on it. Everything not listed here is removed. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  p: [],
  h2: [],
  h3: [],
  blockquote: [],
  ul: [],
  ol: [],
  li: [],
  strong: [],
  em: [],
  b: [],
  i: [],
  a: ['href'],
  figure: [],
  figcaption: [],
  img: ['src', 'alt', 'width', 'height'],
  br: [],
  sub: [],
  sup: [],
};

/** Removed together with their contents — these carry no prose worth keeping. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'param',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'label',
  'aside',
  'nav',
  'footer',
  'header',
  'template',
  'link',
  'meta',
  'title',
  'base',
  'table',
  'picture',
]);

/** Turn a relative or http URL into an absolute https one; undefined if it cannot be. */
export function absoluteHttps(href: string | undefined): string | undefined {
  const value = href?.trim();
  if (!value) return undefined;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return GUARDIAN_BASE + value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return undefined;
  return url.toString();
}

/**
 * Keep only the allow-listed tags and attributes.
 * Unknown-but-harmless wrappers (div, span, section, …) are unwrapped so their
 * text survives; embeds, scripts and custom elements are dropped outright.
 */
export function sanitiseHtml(html: string): string {
  if (!html) return '';
  const $ = cheerio.load(html, null, false);

  // Deepest-first, so unwrapping a parent cannot resurrect a child we already handled.
  const elements = $('*').toArray().reverse() as Element[];

  for (const element of elements) {
    const node = $(element);
    const tag = element.tagName?.toLowerCase();
    if (!tag) continue;

    if (DROP_WITH_CONTENT.has(tag) || tag.includes('-')) {
      node.remove();
      continue;
    }

    const allowedAttrs = ALLOWED[tag];
    if (!allowedAttrs) {
      // Unknown wrapper: keep the children, lose the tag.
      node.replaceWith(node.contents());
      continue;
    }

    for (const name of Object.keys(element.attribs ?? {})) {
      if (!allowedAttrs.includes(name)) node.removeAttr(name);
    }

    if (tag === 'a') {
      const href = absoluteHttps(node.attr('href'));
      if (!href) {
        // javascript:, mailto:, anchors — drop the link, keep the words.
        node.replaceWith(node.contents());
        continue;
      }
      node.attr('href', href);
      node.attr('rel', 'noopener');
    }

    if (tag === 'img') {
      const src = absoluteHttps(node.attr('src'));
      if (!src) {
        node.remove();
        continue;
      }
      node.attr('src', src);
    }
  }

  return ($.root().html() ?? '').trim();
}
