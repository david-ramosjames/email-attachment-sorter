const PLACEHOLDER_RE =
  /^(not\s+specified|not\s+provided|n\/?a|none|unknown|unspecified|tbd|null|undefined|provider|facility|clinic|hospital|office)$/i;

/** Common city-only misreads from letterhead address lines. */
const CITY_ONLY = new Set(
  [
    'san antonio',
    'houston',
    'austin',
    'dallas',
    'fort worth',
    'el paso',
    'arlington',
    'corpus christi',
    'plano',
    'lubbock',
    'irving',
    'garland',
    'frisco',
    'mckinney',
    'amarillo',
    'grand prairie',
    'brownsville',
    'pasadena',
    'mesquite',
    'mcallen',
    'killeen',
    'waco',
    'denton',
    'midland',
    'abilene',
    'beaumont',
    'round rock',
    'richardson',
    'pearland',
    'college station',
    'sugar land',
    'the woodlands',
    'league city',
    'tyler',
    'new braunfels',
    'conroe',
    'san marcos',
    'georgetown',
    'cedar park',
    'pflugerville',
    'leander',
    'miami',
    'orlando',
    'tampa',
    'jacksonville',
    'atlanta',
    'chicago',
    'phoenix',
    'los angeles',
    'new york',
  ].map((c) => c.toLowerCase())
);

const MEDICAL_NAME_HINT =
  /\b(pain|ortho|orthoped|chiro|imaging|radiolog|clinic|center|hospital|surgery|physic|rehab|therapy|spine|neuro|medical|health|associates|group|institute|physicians?)\b/i;

/**
 * True when the extracted "provider" is junk we should not trust
 * (placeholders, city-only address lines, bare initials).
 */
export function isWeakProviderName(name: string | null | undefined): boolean {
  const raw = name?.trim() ?? '';
  if (raw.length < 3) return true;
  if (PLACEHOLDER_RE.test(raw)) return true;

  const normalized = raw.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (CITY_ONLY.has(normalized)) return true;

  // Single token with no medical facility signal — often a city fragment or form label.
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 1 && !MEDICAL_NAME_HINT.test(normalized) && tokens[0]!.length < 10) {
    return true;
  }

  return false;
}

/** Prefer a strong extracted name; otherwise use Dropbox Medical/ folder hint. */
export function resolveProviderName(
  extracted: string | null | undefined,
  folderHint: string | null | undefined
): string | null {
  const name = extracted?.trim() || '';
  if (name && !isWeakProviderName(name)) return name;
  const hint = folderHint?.trim() || '';
  if (hint && !isWeakProviderName(hint)) return hint;
  return name || hint || null;
}

/**
 * Provider folder under Medical/… for a Dropbox file path.
 * e.g. …/Medical/Quantum Pain & Orthopedics/file.pdf → Quantum Pain & Orthopedics
 */
export function providerFolderFromDropboxPath(filePath: string): string | null {
  const parts = filePath.split('/').filter(Boolean);
  const medicalIdx = parts.findIndex((p) => p.toLowerCase() === 'medical');
  if (medicalIdx < 0) return null;
  const after = parts[medicalIdx + 1];
  if (!after || /\.[a-z0-9]{2,5}$/i.test(after)) return null; // file directly under Medical/
  const folder = after.trim().replace(/\s+\([A-Za-z]\)$/i, '');
  const generic = new Set([
    'records request',
    'record requests',
    'medical records',
    'records',
    'billing',
    'bills',
    'pd',
  ]);
  if (!folder || generic.has(folder.toLowerCase())) return null;
  return folder;
}

/** @deprecated Prefer providerFolderFromDropboxPath */
export function providerFolderFromMedicalPath(filePath: string, _casePath: string): string | null {
  return providerFolderFromDropboxPath(filePath);
}
