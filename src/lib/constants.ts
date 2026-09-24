/** Site-wide strings that appear in more than one place. */

export const SITE_NAME = 'The Optimist';

/** The site-wide disclaimer. Shown in the footer and on every article. */
export const DISCLAIMER =
	'The Optimist is an AI-rewritten experiment. Not affiliated with Guardian News & Media. Facts unchanged, framing changed.';

/** Placeholder until the repository is public. */
export const REPO_URL = 'REPO_URL';

/** Shown instead of a body when a rewrite was skipped or failed the fact check. */
export const HEADLINE_ONLY_NOTICE = 'This story was not rewritten today';

/** Pillar navigation. `id` is the front-page container it anchors to. */
export const PILLAR_NAV = [
	{ id: 'news', label: 'News' },
	{ id: 'opinion', label: 'Opinion' },
	{ id: 'sport', label: 'Sport' },
	{ id: 'culture', label: 'Culture' },
	{ id: 'lifestyle', label: 'Lifestyle' },
] as const;

/** Format an ISO 8601 timestamp as the Guardian does: "Wed 24 Sep 2026 07.30 BST". */
export function formatDateTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;

	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/London',
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZoneName: 'short',
	}).formatToParts(date);

	const get = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';

	return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')} ${get('hour')}.${get('minute')} ${get('timeZoneName')}`;
}

/** Format a YYYY-MM-DD date as "Thursday 24 September 2026". */
export function formatDate(ymd: string): string {
	const date = new Date(`${ymd}T12:00:00Z`);
	if (Number.isNaN(date.getTime())) return ymd;

	return new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/London',
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
	}).format(date);
}
