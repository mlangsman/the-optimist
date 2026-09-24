/**
 * Byline pseudonymisation.
 *
 * Real journalists do not write The Optimist's rewrites, so every byline is
 * swapped for a near-miss of itself: a spoonerism where that reads cleanly
 * ("Marina Hyde" -> "Harina Myde"), and a deterministic stock name where it
 * does not. Pure and stable: the same input always maps to the same output.
 */

/** Agency and desk bylines that are not people — passed through untouched. */
const AGENCY = new RegExp(
  [
    '^guardian\\b',
    '^observer\\b',
    '^reuters$',
    '^associated press$',
    '^ap$',
    '^afp$',
    '^afp and reuters$',
    '^agence france[- ]presse$',
    '^pa media$',
    '^press association$',
    '^staff( and agencies)?$',
    '^agencies$',
  ].join('|'),
  'i',
);

/** "y" counts as a vowel everywhere except the first letter of a word ("Hyde" -> onset "H"). */
const VOWELS = 'aeiou';
const VOWELS_WITH_Y = 'aeiouy';

const FIRST_NAMES = [
  'Alice', 'Amara', 'Amelia', 'Andrew', 'Angus', 'Anita', 'Arthur', 'Ayesha', 'Beatrice', 'Bernard',
  'Bryony', 'Callum', 'Camilla', 'Cerys', 'Charlotte', 'Clara', 'Colin', 'Daniel', 'Daphne', 'Darren',
  'Declan', 'Dorothy', 'Douglas', 'Edith', 'Edward', 'Eileen', 'Eleanor', 'Elliot', 'Emrys', 'Esme',
  'Euan', 'Fenella', 'Fergus', 'Fiona', 'Florence', 'Frances', 'Gareth', 'Gemma', 'Geoffrey', 'Gillian',
  'Gordon', 'Graham', 'Gwen', 'Harriet', 'Hector', 'Helena', 'Hugh', 'Imogen', 'Iona', 'Isaac',
  'Jasmine', 'Jenny', 'Joan', 'Jonah', 'Joyce', 'Judith', 'Kamal', 'Kathleen', 'Keira', 'Kenneth',
  'Lachlan', 'Leonie', 'Lewis', 'Lorna', 'Lucian', 'Maeve', 'Malcolm', 'Margot', 'Martha', 'Maurice',
  'Meredith', 'Miriam', 'Monty', 'Nadia', 'Nerys', 'Nigel', 'Norah', 'Oliver', 'Orla', 'Oscar',
  'Patrick', 'Penelope', 'Percy', 'Priya', 'Rachel', 'Ralph', 'Rhiannon', 'Rosalind', 'Rowan', 'Rupert',
  'Sabine', 'Seren', 'Sidney', 'Sylvia', 'Tamsin', 'Theodore', 'Ursula', 'Vivian', 'Wilfred', 'Yasmin',
];

const LAST_NAMES = [
  'Ainsworth', 'Ashdown', 'Bagshaw', 'Barlow', 'Beckford', 'Bellamy', 'Birchall', 'Blackwood', 'Bramley', 'Brightwell',
  'Broadbent', 'Calloway', 'Carmichael', 'Cavendish', 'Chadwick', 'Chesterton', 'Clayton', 'Copeland', 'Cowley', 'Cresswell',
  'Dalrymple', 'Danforth', 'Deeley', 'Denholm', 'Dunmore', 'Eastwood', 'Ellery', 'Everleigh', 'Fairbanks', 'Fenwick',
  'Fernsby', 'Fitzgerald', 'Follett', 'Galbraith', 'Garrick', 'Goodwin', 'Granger', 'Greenhalgh', 'Hadley', 'Halliwell',
  'Hargreaves', 'Hathaway', 'Haverford', 'Hollins', 'Hornby', 'Huxley', 'Inglis', 'Kelsall', 'Kerrigan', 'Kingsley',
  'Langdon', 'Larkspur', 'Lavery', 'Linscott', 'Loxley', 'Marchetti', 'Marsden', 'Mattingly', 'Merriweather', 'Middleton',
  'Millbank', 'Netherton', 'Northcote', 'Oakhurst', 'Ollerton', 'Paxton', 'Pemberton', 'Penhaligon', 'Petrie', 'Pickering',
  'Quennell', 'Radcliffe', 'Ravensworth', 'Redmayne', 'Rennick', 'Ridley', 'Rothwell', 'Sackville', 'Selby', 'Sheridan',
  'Somerville', 'Stanbury', 'Sturridge', 'Tarleton', 'Thackeray', 'Thorne', 'Tremayne', 'Underhill', 'Vance', 'Wainwright',
  'Waverley', 'Wetherby', 'Whitlock', 'Wickham', 'Willoughby', 'Winstanley', 'Wolseley', 'Wyndham', 'Yardley', 'Ziegler',
];

/** FNV-1a (32-bit). Stable across runs and machines. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic stock name for a real name that cannot be spoonerised cleanly. */
export function stockName(name: string): string {
  const hash = fnv1a(name.toLowerCase());
  const first = FIRST_NAMES[hash % FIRST_NAMES.length] as string;
  const last = LAST_NAMES[Math.floor(hash / FIRST_NAMES.length) % LAST_NAMES.length] as string;
  return `${first} ${last}`;
}

function capitalise(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Leading consonant cluster of a word, e.g. "Crerar" -> "Cr", "Hyde" -> "H", "Ana" -> "". */
export function onset(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length === 0 || VOWELS.includes(lower.charAt(0))) return '';
  let i = 1;
  while (i < lower.length && !VOWELS_WITH_Y.includes(lower.charAt(i))) i++;
  // No vowel at all: there is no rime to keep, so treat the word as unswappable.
  if (i >= lower.length) return '';
  return word.slice(0, i);
}

/** Three or more consonants in a row at the start of a word reads as a typo, not a joke. */
function hasHarshOnset(word: string): boolean {
  return onset(word).length >= 3;
}

function isNameToken(token: string): boolean {
  return /^[A-Z][\p{L}'’-]*$/u.test(token) || /^(Mc|Mac|O'|O’)[\p{L}'’-]+$/u.test(token);
}

function isInitial(token: string): boolean {
  const letters = token.replace(/[^\p{L}]/gu, '');
  return letters.length <= 1;
}

/**
 * Put `cluster` in front of `word`'s rime and re-capitalise.
 * When the word had no onset of its own its first letter is now mid-word, so it
 * is lower-cased: graft('M', 'Ed', 0) -> 'Med'.
 */
function graft(cluster: string, word: string, ownOnsetLength: number): string {
  const rime = word.slice(ownOnsetLength);
  const body = ownOnsetLength === 0 ? rime.charAt(0).toLowerCase() + rime.slice(1) : rime;
  return capitalise(cluster.toLowerCase() + body);
}

/** Swap the initial consonant clusters of two names. Returns undefined when the swap is no good. */
function spoonerise(first: string, last: string): [string, string] | undefined {
  if (isInitial(first) || isInitial(last)) return undefined;
  if (first.charAt(0).toLowerCase() === last.charAt(0).toLowerCase()) return undefined;

  const firstOnset = onset(first);
  const lastOnset = onset(last);

  // Exchange the clusters. When one name is vowel-initial its onset is empty, so
  // the other's cluster simply moves across: "Ed Miliband" -> "Med Iliband".
  const newFirst = graft(lastOnset, first, firstOnset.length);
  const newLast = graft(firstOnset, last, lastOnset.length);

  if (newFirst === first && newLast === last) return undefined;
  if (hasHarshOnset(newFirst) || hasHarshOnset(newLast)) return undefined;

  return [newFirst, newLast];
}

/** Replace the person's name in one byline segment, keeping any role or "in <place>" suffix. */
function pseudonymiseSegment(segment: string): string {
  const trimmed = segment.trim();
  if (trimmed.length === 0 || AGENCY.test(trimmed)) return segment;

  // "Jane Doe in Paris" — the location suffix is preserved verbatim.
  const locationMatch = /^(.*?)(\s+in\s+.+)$/i.exec(trimmed);
  const namePart = locationMatch ? (locationMatch[1] as string) : trimmed;
  const locationSuffix = locationMatch ? (locationMatch[2] as string) : '';

  const tokens = namePart.split(/\s+/).filter((t) => t.length > 0);
  // A name is the first two capitalised tokens; anything after is a role and is kept.
  if (tokens.length < 2) return segment;
  const first = tokens[0] as string;
  const last = tokens[1] as string;
  if (!isNameToken(first) || !isNameToken(last)) return segment;

  const rest = tokens.slice(2).join(' ');
  const swapped = spoonerise(first, last);
  const replacement = swapped ? `${swapped[0]} ${swapped[1]}` : stockName(`${first} ${last}`);

  const rebuilt = [replacement, rest].filter((part) => part.length > 0).join(' ') + locationSuffix;
  // Re-apply the original leading/trailing whitespace of the segment.
  const leading = /^\s*/.exec(segment)?.[0] ?? '';
  const trailing = /\s*$/.exec(segment)?.[0] ?? '';
  return leading + rebuilt + trailing;
}

/**
 * Pseudonymise a Guardian byline.
 * Multi-author bylines ("A and B", "A, B and C") are split on their separators,
 * which are preserved exactly. Agency bylines are returned unchanged.
 */
export function pseudonymiseByline(byline: string | undefined): string | undefined {
  if (byline === undefined) return undefined;
  const trimmed = byline.trim();
  if (trimmed.length === 0) return undefined;
  if (AGENCY.test(trimmed)) return byline;

  // Split on "," and " and ", keeping the separators so they can be re-joined verbatim.
  const parts = byline.split(/(,|\s+and\s+)/i);
  return parts
    .map((part, index) => (index % 2 === 0 ? pseudonymiseSegment(part) : part))
    .join('');
}
