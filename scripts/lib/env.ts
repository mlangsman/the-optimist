/**
 * Minimal .env reader — no dependency, no magic.
 * Parses KEY=VALUE lines, ignores blanks and # comments, never overrides an
 * existing process.env value (so CI secrets always win over a local file).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Parse .env text into a plain record. Exported for testing. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load a .env file into process.env if it exists. Missing file is not an error. */
export function loadEnv(file = '.env'): void {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Read the Guardian Open Platform key. Never printed or logged anywhere.
 * Throws a readable error (not a stack-trace-first crash) when it is absent.
 */
export function requireGuardianKey(): string {
  loadEnv();
  const key = process.env.GUARDIAN_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'GUARDIAN_API_KEY is not set. Put it in .env (see .env.example) or export it.\n' +
        'Get a free developer key at https://open-platform.theguardian.com/access/\n' +
        'Or run with --front-only to skip the Content API entirely.',
    );
  }
  return key;
}

/**
 * Read the Anthropic API key, for the `api` rewrite engine and the fact check.
 * Never printed or logged anywhere — only handed to the SDK client.
 */
export function requireAnthropicKey(): string {
  loadEnv();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Put it in .env (see .env.example) or export it.\n' +
        'Get a key at https://console.anthropic.com/settings/keys\n' +
        'Or rewrite with the claude-code engine, which needs no key.',
    );
  }
  return key;
}
