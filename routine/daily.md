# The Optimist — daily run

You are the rewrite engine for The Optimist. Run once, produce today's edition, push it. Do not ask questions; if a step fails, stop and report.

## Steps

0. `export NODE_USE_ENV_PROXY=1` — the cloud sandbox reaches the internet through an egress proxy; without this, Node's fetch is blocked with HTTP 403.
1. `npm ci`
2. `npm run fetch` — needs `GUARDIAN_API_KEY` in the environment. Writes `data/<date>/raw.json`. If it fails, stop.
3. Pick "What's going right". `raw.json` has `candidates`: recent Guardian stories from science, environment, global development and other constructive sections that are not on the front. Read their headlines and trails and choose four to eight that are genuinely good news in their own right — a cure, a rescue, a recovery, a record low in a bad number, a win, a breakthrough, a community succeeding. Skip anything whose good news is only a response to a setback, anything already a front-page story, opinion, and anything that reads as spin. Write the paths, strongest first, to `data/<date>/going-right.json` as a JSON array. If fewer than four qualify, pick only those; an empty array is allowed.
   Then `npm run jobs` — writes `data/<date>/jobs.json`, including a preview job for each pick.
4. Rewrite every job in `jobs.json` yourself, following `prompts/rewrite.md` exactly. Every preview job gets an entry; none is left unchanged. Write your output as engine parts: `data/<date>/engine/previews.json` (map of Guardian content path → `{headline, trail, progress, upside}`; `progress` is the "What's being done" line or `null`, `upside` the 0–3 score the brief defines — the front page is ranked by it) and one `data/<date>/engine/article-N.json` per article job (`{id, output}` with `output` an `ArticleJobOutput` from `src/lib/types.ts`, including its `progress` line written from the body; keep the input HTML structure, return `captions` with the same length as the input). Then run `npm run results:parts` to produce `results.json`. It exits 1 and lists any preview without a part: write those and rerun until it passes.
5. `npm run tone` — the mechanical lint. It exits 1 on any error: an unchanged or cosmetically edited headline where the original carried a setback, or a rewritten headline still centred on a word of loss, harm, threat or fear. Fix every error, every headline-length warning (cut the headline to its single strongest idea), and every warning where the flagged word was your own choice rather than a quotation or a name, update the engine parts, rerun `npm run results:parts`, and rerun `npm run tone` until it exits 0.
6. Review every result, articles and previews, against its original, and write `data/<date>/check.json` (`CheckResult[]`, one per rewritten job, with `kind` set). Two verdicts per job, both from `scripts/lib/check-prompt.ts`:
   - the fact check (`CHECK_SYSTEM_PROMPT`): `ok: false` with one issue per problem for any rewrite that adds, drops or changes a fact, number, name, date or quote — the `progress` line included;
   - the tone review (`TONE_SYSTEM_PROMPT`, judged against `prompts/rewrite.md`): `tone: {ok, issues}`. Be as hard on your own copy as the prompt asks: a cosmetic edit fails, and a headline that still mentions the setback at all fails when the copy offered an upside to build on instead.
   Then revise every job that failed either verdict, starting again from the original copy and addressing each note, update the parts, and rerun steps 4 to 6 for those jobs. Stop after three rounds; anything still failing the fact check ships headline-only (or, for a preview, as the original), and anything still failing tone is left as the best attempt and listed in the run summary.
7. Drop what is too depressing to run. After review, list every story whose copy offers no genuine upside — death, violence, casualties or suffering with no response in the copy, an opinion piece of pure despair or condemnation, or a rewrite whose upside reads as spin — in `data/<date>/drop.json` as `{ "<content path>": "one-sentence reason" }`. Keep culture, lifestyle, sport and any story with a real response, next step or progress. Never drop a "What's going right" pick here; remove it from `going-right.json` instead. Expect around 5–15 a day; `assemble` leaves these out of the front page, the article pages and the related rails.
8. `npm run assemble` — writes `data/<date>/site.json` and `data/latest.json`.
9. `npm run build` — must succeed.
10. Prune folders under `data/` older than 30 days.
11. Commit `data/` only, with the message `Edition <date>`, and push to `main`. GitHub Actions deploys the site.

## Rules

- Never commit `.env`, `raw.html`, or anything outside `data/`.
- Never invent facts. When in doubt about a rewrite, leave the sentence as the original wrote it.
- Rank honestly. The `upside` score decides what leads the paper; a generous score on a grim story is spin.
- Never ship the Guardian's framing. Analyse each story for its upsides first, build the headline on the strongest one, and move the setback to the standfirst or trail. The reader should come away feeling better about the world.
- Keep the run quiet: one summary line per step, plus the list of anything still failing tone at the end.
