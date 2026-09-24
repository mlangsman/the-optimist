/**
 * Small shared helpers for the pipeline scripts: argument parsing, the
 * Europe/London pipeline date, data paths, and friendly file I/O.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DATA_DIR = resolve(process.cwd(), 'data');

export interface Args {
  flags: Set<string>;
  options: Map<string, string>;
}

/** Parse `--flag` and `--key=value` from argv (everything after `node script.ts`). */
export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else options.set(body.slice(0, eq), body.slice(eq + 1));
  }
  return { flags, options };
}

/** Today in Europe/London as YYYY-MM-DD. */
export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Resolve the run date from `--date=YYYY-MM-DD`, defaulting to today in London. */
export function resolveDate(args: Args): string {
  const override = args.options.get('date');
  if (override === undefined) return londonToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(override)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${override}"`);
  }
  return override;
}

export function dayDir(date: string): string {
  return join(DATA_DIR, date);
}

export function dayFile(date: string, name: string): string {
  return join(dayDir(date), name);
}

/** Print `--help` text and exit 0 when the flag is present. */
export function maybeHelp(args: Args, text: string): void {
  if (args.flags.has('help') || args.flags.has('h')) {
    process.stdout.write(`${text.trim()}\n`);
    process.exit(0);
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeText(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, 'utf8');
}

/** Read + JSON.parse a file, turning ENOENT and syntax errors into readable messages. */
export function readJson<T>(file: string, what: string): T {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Missing ${what}: ${file}`);
    }
    throw new Error(`Could not read ${what} (${file}): ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${what} is not valid JSON (${file}): ${errorMessage(error)}`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `importMetaUrl`'s module is the file node was asked to run. */
export function isEntryPoint(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}

/**
 * Run a script body when its module is the entry point, printing a one-line
 * error instead of a stack trace when it fails. Importing the module (from a
 * test, say) does not run it.
 */
export function runMain(importMetaUrl: string, main: () => Promise<void> | void): void {
  if (!isEntryPoint(importMetaUrl)) return;
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      process.exitCode = 1;
      process.stderr.write(`Error: ${errorMessage(error)}\n`);
    }
  })();
}
