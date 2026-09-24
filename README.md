# The Optimist

A daily mirror of the Guardian's UK front page, rewritten with an optimistic point of view. Every fact, figure, quote and name is kept; only the framing changes. A personal, non-commercial experiment in editorial tone.

**Not affiliated with Guardian News & Media.** Article text is adapted from Guardian journalism under the [Open Platform](https://open-platform.theguardian.com/) developer terms, with attribution and a link to the original on every article page. Bylines are pseudonymised; the real byline appears in the attribution line.

## How it works

```
Guardian front page (HTML)  ──►  fetch  ──►  raw.json
Guardian Content API        ──┘                 │
                                              jobs  ──►  jobs.json
                                                            │
                              rewrite engine (one of two)   ▼
                              • claude-code: Claude Code does it   results.json ◄──┐
                              • api: Anthropic Message Batches        │            │
                                                             tone ──► tone.json    │
                                                            check ──► check.json   │
                                                                        │          │
                                                           revise ─────┴───────────┘  (until clean)
                                                                        │
                                                         assemble ──► site.json → data/latest.json
                                                                        │
                                                              astro build ──► GitHub Pages
```

- **Scope.** The front page's News block is fetched in full and rewritten (headline, standfirst, body, captions). Every other front-page card, and the related stories on each article, gets a rewritten headline and trail only and is not linked. One level of depth.
- **Engines.** The rewrite step reads `jobs.json` and writes `results.json`. Anything that honours that contract is an engine. `scripts/rewrite-api.ts` is the reference implementation on the Anthropic API (Sonnet 5 via the Batch API, structured outputs, prompt caching). The daily run uses Claude Code itself as the engine, on a scheduled cloud routine, so there is no API bill.
- **Review.** Three passes look at every rewrite, previews included, and nothing false or half-hearted ships:
  - `scripts/tone.ts` is a mechanical lint with no model behind it. It fails the run on an unchanged or cosmetically edited headline where the original carried a setback ("warns" swapped for "says" and nothing else moved), on a rewritten headline still centred on a word of loss, harm, threat or fear, and on any preview with no rewrite at all. Quotations and house-style compounds such as "climate crisis" are exempt.
  - `scripts/check.ts` runs two model reviewers on each pair: a fact check (Haiku, thinking off) that demotes anything with an unsupported or altered claim, and a tone review (Sonnet, low effort) that judges the copy against `prompts/rewrite.md` as an editor would, and writes notes for the writer.
  - `scripts/revise.ts` sends every rewrite that failed a review back to the rewriter with the previous attempt and the notes, then `check.ts --only=failed` and `tone.ts` run again. Loop until clean. The daily routine does the same loop by hand.
- **Dropped stories.** `data/<date>/drop.json` (optional) maps content paths to a reason; `scripts/assemble.ts` leaves those stories out of the front page, article pages and related rails. The daily routine fills it with the stories too bleak for the paper to run.
- **Tone.** `prompts/rewrite.md` holds the editorial rules: analyse each story for its upsides, build the headline entirely on the strongest one, move the setback to the standfirst, keep Guardian house style, never invent a fact, and never make a cosmetic edit.

## Running it

```bash
cp .env.example .env        # add GUARDIAN_API_KEY (and ANTHROPIC_API_KEY for the api engine)
npm install
npm run fetch               # data/<today>/raw.json      (--front-only needs no key)
npm run jobs                # data/<today>/jobs.json
npm run rewrite:api         # data/<today>/results.json  (or produce it with another engine)
npm run tone                # data/<today>/tone.json     (no key needed; exits 1 on errors)
npm run check               # data/<today>/check.json    (facts + tone; --no-tone for facts only)
npm run revise              # re-run the failures with the reviewers' notes, then:
npm run check -- --only=failed && npm run tone
npm run assemble            # data/<today>/site.json + data/latest.json
npm run build               # dist/
```

`npm test` runs the unit tests (front-page parser, bylines, sanitiser, request builders). `npm run dev` previews the site; without `data/latest.json` it renders `data/fixture/site.json`.

## Layout

| Path | What |
|---|---|
| `scripts/` | Pipeline CLIs and their libraries (`lib/front.ts` parser, `lib/guardian-api.ts` client, `lib/bylines.ts`, `lib/sanitise.ts`, `lib/anthropic.ts`, `lib/tone.ts` lint, `lib/check-prompt.ts` review prompts) |
| `prompts/rewrite.md` | The system prompt every engine uses |
| `src/lib/types.ts` | The data contract shared by pipeline and site |
| `src/` | Astro site: pages, components, styles (Guardian design tokens from `@guardian/source`) |
| `data/` | One folder per day plus `latest.json`; the site builds from `latest.json` only |
| `routine/` | Instructions for the scheduled Claude Code run |

## Bylines

Names are spoonerised (Marina Hyde → Harina Myde). Where the swap does not read cleanly, a deterministic stock name is used instead, so the same journalist always maps to the same alias. Agency bylines pass through unchanged.

## Fonts

The Guardian's typefaces are proprietary. The site uses free lookalikes by default; the font stacks live in one place in `src/styles/tokens.css`.
