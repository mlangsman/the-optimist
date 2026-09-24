import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { cardImageUrl, isArticlePath, parseFront, titleFromId } from './front.js';

const fixture = readFileSync(
  fileURLToPath(new URL('../__fixtures__/front-sample.html', import.meta.url)),
  'utf8',
);
const containers = parseFront(fixture);
const byId = new Map(containers.map((c) => [c.id, c]));

describe('titleFromId', () => {
  it('turns kebab ids into titles', () => {
    assert.equal(titleFromId('news'), 'News');
    assert.equal(titleFromId('more-top-stories'), 'More Top Stories');
  });

  it('strips the trailing hyphen', () => {
    assert.equal(titleFromId('the-long-read-'), 'The Long Read');
  });

  it('decodes &amp;', () => {
    assert.equal(titleFromId('climate-crisis-&amp;-environment'), 'Climate Crisis & Environment');
    assert.equal(titleFromId('business-&-technology'), 'Business & Technology');
  });

  it('upper-cases known acronyms', () => {
    assert.equal(titleFromId('uk-news'), 'UK News');
  });
});

describe('isArticlePath', () => {
  it('accepts relative paths with a date segment', () => {
    assert.equal(isArticlePath('/environment/2026/sep/23/slug'), true);
    assert.equal(isArticlePath('/politics/live/2026/sep/24/slug'), true);
  });

  it('rejects section fronts, absolute urls and query strings', () => {
    assert.equal(isArticlePath('/uk-news'), false);
    assert.equal(isArticlePath('https://www.theguardian.com/world'), false);
    assert.equal(isArticlePath('//www.theguardian.com/world/2026/sep/23/slug'), false);
    assert.equal(isArticlePath('/info/2026/sep/23/slug?x=1'), false);
    assert.equal(isArticlePath(undefined), false);
  });
});

describe('parseFront', () => {
  it('returns the containers in page order', () => {
    assert.deepEqual(
      containers.map((c) => c.id),
      ['highlights', 'news', 'opinion', 'uk-news', 'world-news'],
    );
  });

  it('titles the unnamed highlights strip', () => {
    assert.equal(byId.get('highlights')?.title, 'Highlights');
    assert.equal(byId.get('opinion')?.title, 'Opinion');
  });

  it('finds at least 8 cards in the news container', () => {
    const news = byId.get('news');
    assert.ok(news, 'news container is missing');
    assert.ok(news.cards.length >= 8, `expected >= 8 news cards, got ${news.cards.length}`);
  });

  it('gives the first news card a path and a headline', () => {
    const first = byId.get('news')?.cards[0];
    assert.ok(first);
    assert.match(first.path, /^\/[a-z0-9-]+\/\d{4}\/[a-z]{3}\/\d{1,2}\//);
    assert.ok(first.headline && first.headline.length > 10, 'first card has no headline');
  });

  it('never repeats a path within a container', () => {
    for (const container of containers) {
      const paths = container.cards.map((c) => c.path);
      assert.equal(
        new Set(paths).size,
        paths.length,
        `duplicate paths in container "${container.id}"`,
      );
    }
  });

  it('only emits article-like paths', () => {
    for (const container of containers) {
      for (const card of container.cards) {
        assert.ok(isArticlePath(card.path), `bad path ${card.path} in ${container.id}`);
      }
    }
  });

  it('picks up card images from the surrounding <li>', () => {
    const withImage = byId.get('news')?.cards.find((c) => c.image);
    assert.ok(withImage?.image, 'no news card carried an image');
    assert.match(withImage.image.src, /^https:\/\/i\.guim\.co\.uk\//);
    assert.ok(withImage.image.alt && withImage.image.alt.length > 0);
  });

  it('handles scrollable containers whose cards are plain "article" links', () => {
    const world = byId.get('world-news');
    assert.ok(world);
    assert.ok(world.cards.length >= 3);
    assert.ok(world.cards.every((c) => typeof c.headline === 'string' && c.headline.length > 0));
  });

  it('drops containers with no cards', () => {
    assert.equal(
      containers.some((c) => c.cards.length === 0),
      false,
    );
  });

  it('returns an empty list for html with no containers', () => {
    assert.deepEqual(parseFront('<html><body><p>nothing here</p></body></html>'), []);
  });
});

it('cardImageUrl asks the Guardian CDN for a 620px rendition', () => {
  const out = cardImageUrl('https://i.guim.co.uk/img/media/abc/0_0_5000_4000/master/5000.jpg?width=98&dpr=2&s=none&crop=1%3A1');
  assert.ok(out.includes('width=620'));
  assert.ok(out.includes('dpr=1'));
  assert.ok(out.includes('crop=1%3A1'));
  assert.equal(cardImageUrl('https://example.com/a.jpg?width=98'), 'https://example.com/a.jpg?width=98');
});
