/** Noise tokens stripped when comparing medical provider names. */
const NOISE_TOKENS = new Set([
  'llc',
  'inc',
  'pa',
  'pc',
  'pllc',
  'ltd',
  'co',
  'company',
  'center',
  'centers',
  'clinic',
  'clinics',
  'group',
  'associates',
  'the',
  'and',
  'of',
  'at',
]);

/** Collapse common abbreviations so LOP filenames match full provider names. */
const TOKEN_ALIASES: Record<string, string> = {
  chiropractic: 'chiro',
  chiropractor: 'chiro',
  orthopedics: 'ortho',
  orthopaedics: 'ortho',
  orthopedic: 'ortho',
  orthopaedic: 'ortho',
  orthopedist: 'ortho',
};

export function canonicalizeProviderTokens(name: string): string[] {
  const normalized = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  return normalized
    .split(' ')
    .filter(Boolean)
    .map((token) => TOKEN_ALIASES[token] ?? token)
    .filter((token) => !NOISE_TOKENS.has(token));
}

/** True when two provider labels refer to the same facility (near-duplicate names). */
export function providerNamesMatch(a: string, b: string): boolean {
  const left = canonicalizeProviderTokens(a);
  const right = canonicalizeProviderTokens(b);
  if (!left.length || !right.length) return false;
  if (left.join(' ') === right.join(' ')) return true;

  const [smaller, larger] = left.length <= right.length ? [left, right] : [right, left];
  const isSubset = smaller.every((token) => larger.includes(token));
  if (!isSubset) return false;
  if (smaller.length >= 2) return true;
  // Single distinctive token (e.g. "Longhorn" vs "Longhorn Imaging")
  return smaller[0]!.length >= 8;
}

export function preferredProviderName(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (left.length !== right.length) return left.length > right.length ? left : right;
  return left.localeCompare(right) <= 0 ? left : right;
}
