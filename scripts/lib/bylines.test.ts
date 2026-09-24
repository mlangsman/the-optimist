import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fnv1a, onset, pseudonymiseByline, stockName } from './bylines.js';

describe('onset', () => {
  it('takes the leading consonant cluster', () => {
    assert.equal(onset('Crerar'), 'Cr');
    assert.equal(onset('Marina'), 'M');
  });

  it('treats a non-initial y as a vowel', () => {
    assert.equal(onset('Hyde'), 'H');
  });

  it('is empty for vowel-initial words', () => {
    assert.equal(onset('Ana'), '');
    assert.equal(onset('Ed'), '');
  });
});

describe('pseudonymiseByline — spoonerisms', () => {
  it('swaps single-letter onsets', () => {
    assert.equal(pseudonymiseByline('Marina Hyde'), 'Harina Myde');
  });

  it('swaps whole consonant clusters, not just first letters', () => {
    assert.equal(pseudonymiseByline('Pippa Crerar'), 'Crippa Perar');
  });

  it('moves the cluster across when one name is vowel-initial', () => {
    assert.equal(pseudonymiseByline('Ed Miliband'), 'Med Iliband');
  });

  it('keeps a trailing role', () => {
    assert.equal(pseudonymiseByline('Pippa Crerar Political editor'), 'Crippa Perar Political editor');
  });

  it('keeps an "in <place>" suffix unchanged', () => {
    assert.equal(pseudonymiseByline('Jane Doe in Paris'), 'Dane Joe in Paris');
  });
});

describe('pseudonymiseByline — fallbacks', () => {
  it('uses a deterministic stock name when both initials match', () => {
    const out = pseudonymiseByline('Simon Smith');
    assert.ok(out);
    assert.notEqual(out, 'Simon Smith');
    assert.equal(out, stockName('Simon Smith'));
    assert.match(out, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it('uses a stock name when a name is an initial', () => {
    const out = pseudonymiseByline('J Kenner');
    assert.ok(out);
    assert.equal(out, stockName('J Kenner'));
  });

  it('avoids results with three consecutive leading consonants', () => {
    // Chris/Strong would spoonerise to "Strris"/"Chong" — the first is unpronounceable.
    const out = pseudonymiseByline('Chris Strong');
    assert.ok(out);
    assert.equal(out, stockName('Chris Strong'));
  });
});

describe('pseudonymiseByline — pass-through', () => {
  for (const agency of [
    'Guardian staff',
    'Guardian staff and agencies',
    'Reuters',
    'Agence France-Presse',
    'PA Media',
    'Associated Press',
  ]) {
    it(`leaves "${agency}" alone`, () => {
      assert.equal(pseudonymiseByline(agency), agency);
    });
  }

  it('leaves a role-only byline alone', () => {
    assert.equal(pseudonymiseByline('Political editor'), 'Political editor');
  });

  it('leaves a single unparseable token alone', () => {
    assert.equal(pseudonymiseByline('Anonymous'), 'Anonymous');
  });

  it('returns undefined for undefined and empty input', () => {
    assert.equal(pseudonymiseByline(undefined), undefined);
    assert.equal(pseudonymiseByline('   '), undefined);
  });
});

describe('pseudonymiseByline — multi-author', () => {
  it('handles "A and B"', () => {
    assert.equal(pseudonymiseByline('Marina Hyde and Pippa Crerar'), 'Harina Myde and Crippa Perar');
  });

  it('handles a comma-separated list with a trailing "and"', () => {
    assert.equal(
      pseudonymiseByline('Marina Hyde, Jane Doe and Pippa Crerar'),
      'Harina Myde, Dane Joe and Crippa Perar',
    );
  });

  it('keeps per-author location suffixes', () => {
    assert.equal(
      pseudonymiseByline('Jane Doe in Paris and Marina Hyde in Rome'),
      'Dane Joe in Paris and Harina Myde in Rome',
    );
  });
});

describe('pseudonymiseByline — determinism', () => {
  const samples = [
    'Marina Hyde',
    'Simon Smith',
    'Pippa Crerar Political editor',
    'Jane Doe in Paris',
    'Guardian staff',
    'Marina Hyde and Pippa Crerar',
  ];

  it('is idempotent across calls', () => {
    for (const sample of samples) {
      const a = pseudonymiseByline(sample);
      const b = pseudonymiseByline(sample);
      const c = pseudonymiseByline(sample);
      assert.equal(a, b);
      assert.equal(b, c);
    }
  });

  it('pins the hash so the mapping never drifts', () => {
    assert.equal(fnv1a(''), 0x811c9dc5);
    assert.equal(fnv1a('a'), 0xe40c292c);
    assert.equal(fnv1a('foobar'), 0xbf9cf968);
  });

  it('gives different stock names to different inputs', () => {
    const names = new Set(
      ['Simon Smith', 'Sarah Stone', 'Tom Taylor', 'Bella Brown'].map((n) => stockName(n)),
    );
    assert.equal(names.size, 4);
  });
});
