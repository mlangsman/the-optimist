# The Optimist — daily run

You are the rewrite engine for The Optimist. Run once, produce today's edition, push it. Do not ask questions; if a step fails, stop and report.

## Steps

1. `npm ci`
2. `npm run fetch` — needs `GUARDIAN_API_KEY` in the environment. Writes `data/<date>/raw.json`. If it fails, stop.
3. `npm run jobs` — writes `data/<date>/jobs.json`.
4. Rewrite every job in `jobs.json` yourself, following `prompts/rewrite.md` exactly. Write `data/<date>/results.json` as a `ResultsFile` (`src/lib/types.ts`) with `engine: "claude-code"`. For each job the `id` and `kind` must match; article outputs must preserve the input HTML structure and return `captions` with the same length as the input.
5. Fact-check every article result against its original, as described in `scripts/lib/check-prompt.ts`, and write `data/<date>/check.json` (`CheckResult[]`). Mark `ok: false` for any rewrite that adds, drops or changes a fact, number, name, date or quote.
6. `npm run assemble` — writes `data/<date>/site.json` and `data/latest.json`.
7. `npm run build` — must succeed.
8. Prune folders under `data/` older than 30 days.
9. Commit `data/` only, with the message `Edition <date>`, and push to `main`. GitHub Actions deploys the site.

## Rules

- Never commit `.env`, `raw.html`, or anything outside `data/`.
- Never invent facts. When in doubt about a rewrite, leave the sentence as the original wrote it.
- Keep the run quiet: one summary line per step.
