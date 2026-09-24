/**
 * The "What's going right" container: the engine's pick of genuinely good news
 * from raw.json's `candidates`, written to data/<date>/going-right.json as an
 * array of content paths in display order. jobs.ts gives each pick a preview
 * job; assemble.ts turns them into a front container.
 */
import type { RawData } from '../../src/lib/types.js';
import { errorMessage, readJson } from './cli.js';

export const GOING_RIGHT_ID = 'going-right';
export const GOING_RIGHT_TITLE = 'What’s going right';
/** Picks beyond this are ignored, so the container stays a short, strong list. */
export const GOING_RIGHT_MAX = 8;

/** The picks, in order, or [] when the file is absent. Throws on a malformed file. */
export function readGoingRight(file: string): string[] {
  let picks: unknown;
  try {
    picks = readJson<unknown>(file, 'going-right.json');
  } catch (error) {
    if (errorMessage(error).startsWith('Missing going-right.json')) return [];
    throw error;
  }
  if (!Array.isArray(picks) || !picks.every((pick) => typeof pick === 'string')) {
    throw new Error('going-right.json must be an array of content paths');
  }
  return [...new Set(picks)].slice(0, GOING_RIGHT_MAX);
}

/** Picks that exist in raw.candidates, in order. Unknown paths are dropped. */
export function validPicks(raw: RawData, picks: readonly string[]): string[] {
  const candidates = raw.candidates ?? {};
  return picks.filter((path) => path in candidates);
}
