/**
 * Base-path aware URL helpers.
 *
 * Astro exposes the configured `base` as `import.meta.env.BASE_URL`. Depending
 * on the configured value that is `/`, `/the-optimist` or `/the-optimist/`, so
 * every internal href goes through {@link withBase} rather than concatenating
 * strings by hand.
 */

/** `import.meta.env.BASE_URL` with any trailing slash removed (`''` at root). */
function basePrefix(): string {
	const raw: string = import.meta.env.BASE_URL ?? '/';
	return raw.replace(/\/+$/, '');
}

/**
 * Prefix a site-absolute path with the configured base path.
 *
 * @param path A site-absolute path such as `/about` or `/article/x/y`.
 * @returns e.g. `/the-optimist/about`, never containing a double slash.
 */
export function withBase(path: string): string {
	const suffix = `/${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
	const href = `${basePrefix()}${suffix}`;
	return href === '' ? '/' : href;
}

/**
 * The href for a rewritten article.
 *
 * @param contentPath A Guardian content path, always starting with `/`
 *   (e.g. `/environment/2026/sep/23/slug`).
 */
export function articleHref(contentPath: string): string {
	return withBase(`/article/${contentPath.replace(/^\/+/, '')}`);
}

/**
 * The `[...path]` route parameter for a Guardian content path.
 *
 * Astro rest parameters must not carry a leading slash, or the generated route
 * gains an empty segment.
 */
export function articleRouteParam(contentPath: string): string {
	return contentPath.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** An in-page anchor on the front page, e.g. `/the-optimist/#news`. */
export function frontAnchor(containerId: string): string {
	return `${withBase('/')}#${containerId}`;
}

/** Absolute URL for canonical links and social metadata. */
export function absoluteUrl(path: string, site: URL | undefined): string {
	const rel = withBase(path);
	return site ? new URL(rel, site).toString() : rel;
}
