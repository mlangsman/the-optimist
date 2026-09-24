/**
 * The single data entry point for the site build.
 *
 * The pipeline writes `data/latest.json`; when that file is absent (a fresh
 * clone, CI, or a local build with no pipeline run) we fall back to the
 * checked-in fixture so the site always builds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Article, Card, FrontContainer, SiteData } from './types';

const LATEST = 'data/latest.json';
const FIXTURE = 'data/fixture/site.json';

let cached: SiteData | undefined;

function readJson(relativePath: string): SiteData {
	const absolute = resolve(process.cwd(), relativePath);
	return JSON.parse(readFileSync(absolute, 'utf8')) as SiteData;
}

/**
 * Load `data/latest.json`, falling back to `data/fixture/site.json`.
 *
 * Cached for the lifetime of the build so the source is logged exactly once.
 */
export function loadSiteData(): SiteData {
	if (cached) return cached;

	if (existsSync(resolve(process.cwd(), LATEST))) {
		// A present-but-broken edition must fail the build, never silently ship the fixture.
		cached = readJson(LATEST);
		console.log(`[the-optimist] site data: ${LATEST}`);
	} else {
		cached = readJson(FIXTURE);
		console.log(`[the-optimist] site data: ${FIXTURE} (no ${LATEST} present)`);
	}

	return cached;
}

/** Front containers in the order the pipeline emitted them. */
export function frontContainers(): FrontContainer[] {
	return loadSiteData().front;
}

/** Every article, as `[path, article]` pairs, for `getStaticPaths`. */
export function articleEntries(): Array<[string, Article]> {
	return Object.entries(loadSiteData().articles);
}

/** Look up a single article by its Guardian content path. */
export function articleByPath(path: string): Article | undefined {
	return loadSiteData().articles[path];
}

/**
 * The container marked as the primary block on the front page.
 *
 * The Guardian's front page leads with its `news` container; everything else
 * is rendered as a secondary block at a smaller scale.
 */
export const PRIMARY_CONTAINER_ID = 'news';

/** The compact horizontal strip container. */
export const STRIP_CONTAINER_ID = 'highlights';

/**
 * Map a container id to a pillar so cards can pick up a pillar colour.
 *
 * Unknown containers fall back to `news`, matching the Guardian's own default
 * for untagged front containers.
 */
export type Pillar = 'news' | 'opinion' | 'sport' | 'culture' | 'lifestyle';

const PILLARS: readonly Pillar[] = ['news', 'opinion', 'sport', 'culture', 'lifestyle'];

export function pillarFor(id: string): Pillar {
	const lower = id.toLowerCase();
	const match = PILLARS.find((pillar) => lower.includes(pillar));
	return match ?? 'news';
}

/** The pillar implied by a card's kicker/section, for the kicker colour. */
export function pillarForCard(card: Card, fallback: Pillar): Pillar {
	if (!card.kicker) return fallback;
	const lower = card.kicker.toLowerCase();
	if (lower.includes('comment') || lower.includes('opinion')) return 'opinion';
	if (lower.includes('sport') || lower.includes('football')) return 'sport';
	if (lower.includes('culture') || lower.includes('film') || lower.includes('music')) return 'culture';
	if (lower.includes('lifestyle') || lower.includes('food') || lower.includes('travel')) return 'lifestyle';
	return fallback;
}
