import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { absoluteHttps, sanitiseHtml } from './sanitise.js';

describe('absoluteHttps', () => {
  it('prefixes Guardian-relative paths', () => {
    assert.equal(
      absoluteHttps('/world/2026/sep/23/slug'),
      'https://www.theguardian.com/world/2026/sep/23/slug',
    );
  });

  it('upgrades http and protocol-relative urls', () => {
    assert.equal(absoluteHttps('http://example.com/a'), 'https://example.com/a');
    assert.equal(absoluteHttps('//i.guim.co.uk/a.jpg'), 'https://i.guim.co.uk/a.jpg');
  });

  it('rejects non-http schemes and junk', () => {
    assert.equal(absoluteHttps('javascript:alert(1)'), undefined);
    assert.equal(absoluteHttps('mailto:a@b.com'), undefined);
    assert.equal(absoluteHttps('#anchor'), undefined);
    assert.equal(absoluteHttps(''), undefined);
    assert.equal(absoluteHttps(undefined), undefined);
  });
});

describe('sanitiseHtml', () => {
  it('keeps allowed structural tags', () => {
    const input =
      '<p>One</p><h2>Two</h2><h3>Three</h3><blockquote><p>Q</p></blockquote>' +
      '<ul><li>a</li></ul><ol><li>b</li></ol><p><strong>s</strong><em>e</em><b>b</b><i>i</i>' +
      '<br><sub>2</sub><sup>3</sup></p>';
    assert.equal(sanitiseHtml(input), input);
  });

  it('drops scripts, iframes, asides and embeds with their contents', () => {
    const out = sanitiseHtml(
      '<p>Keep</p><script>evil()</script><iframe src="https://x"></iframe>' +
        '<aside><p>Related</p></aside><figure class="element-atom"><gu-atom>x</gu-atom></figure>',
    );
    assert.equal(out.includes('evil'), false);
    assert.equal(out.includes('iframe'), false);
    assert.equal(out.includes('Related'), false);
    assert.equal(out.includes('gu-atom'), false);
    assert.ok(out.startsWith('<p>Keep</p>'));
  });

  it('unwraps unknown wrappers but keeps their text', () => {
    assert.equal(
      sanitiseHtml('<div class="x"><p>Hello <span data-y="1">world</span></p></div>'),
      '<p>Hello world</p>',
    );
  });

  it('strips every attribute that is not allow-listed', () => {
    assert.equal(
      sanitiseHtml('<p class="dcr-1" data-track="x" onclick="evil()">Text</p>'),
      '<p>Text</p>',
    );
  });

  it('makes links absolute https and adds rel="noopener"', () => {
    assert.equal(
      sanitiseHtml('<p><a href="/world/2026/sep/23/slug" data-link-name="in body link">L</a></p>'),
      '<p><a href="https://www.theguardian.com/world/2026/sep/23/slug" rel="noopener">L</a></p>',
    );
  });

  it('unwraps links with unusable hrefs, keeping the words', () => {
    assert.equal(sanitiseHtml('<p><a href="javascript:evil()">Click</a></p>'), '<p>Click</p>');
  });

  it('keeps figure/figcaption/img and drops images without a usable src', () => {
    const out = sanitiseHtml(
      '<figure class="element-image"><img src="//i.guim.co.uk/a.jpg" alt="A" width="620" height="372" srcset="x"><figcaption>Cap</figcaption></figure>',
    );
    assert.ok(out.includes('src="https://i.guim.co.uk/a.jpg"'));
    assert.ok(out.includes('alt="A"'));
    assert.ok(out.includes('width="620"'));
    assert.equal(out.includes('srcset'), false);
    assert.ok(out.includes('<figcaption>Cap</figcaption>'));

    assert.equal(sanitiseHtml('<figure><img src="data:image/png;base64,AAA"></figure>'), '<figure></figure>');
  });

  it('handles empty input', () => {
    assert.equal(sanitiseHtml(''), '');
    assert.equal(sanitiseHtml('   '), '');
  });
});
