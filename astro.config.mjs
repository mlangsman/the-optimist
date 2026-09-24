// @ts-check
import { defineConfig } from 'astro/config';

/**
 * The Optimist — static newspaper-style site.
 *
 * `site` and `base` come from the environment so the same build can be served
 * from a project subpath (GitHub Pages) or from a domain root:
 *
 *   SITE_URL=https://example.com BASE_PATH=/ npm run build
 *
 * Defaults are deliberately inert (`https://example.invalid`) so an
 * unconfigured build never advertises a real origin.
 */
const SITE_URL = process.env.SITE_URL ?? 'https://example.invalid';
const BASE_PATH = process.env.BASE_PATH ?? '/the-optimist';

export default defineConfig({
	output: 'static',
	site: SITE_URL,
	base: BASE_PATH,
	trailingSlash: 'ignore',
	build: {
		// Emit `/article/foo/index.html` so hrefs stay extension-free.
		format: 'directory',
	},
});
