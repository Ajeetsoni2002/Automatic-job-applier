const STOPWORDS = new Set([
  'the',
  'you',
  'your',
  'are',
  'and',
  'for',
  'with',
  'what',
  'have',
  'this',
  'that',
  'please',
  'any',
  'our',
  'will',
  'can',
  'did',
  'does',
  'how',
  'who',
  'which',
  'from',
  'about',
]);

/**
 * Normalised form of a form question, used to recognise the same question across application
 * forms ("Are you willing to relocate?" and "Willing to relocate" share a key).
 */
export function questionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .join(' ');
}

export type EducationLevel =
  | 'secondary'
  | 'higher_secondary'
  | 'diploma'
  | 'undergraduate'
  | 'postgraduate';

export const EDUCATION_LEVELS: EducationLevel[] = [
  'secondary',
  'higher_secondary',
  'diploma',
  'undergraduate',
  'postgraduate',
];

// Checked in this order: "Higher Secondary" before "Secondary", "Post Graduation" before
// "Graduation".
const LEVEL_PATTERNS: Array<[EducationLevel, RegExp]> = [
  [
    'postgraduate',
    /\bpost[- ]?graduat|\bpg\b|\bmaster'?s?\b|\bm\.?\s?tech\b|\bmca\b|\bmba\b|\bm\.?\s?sc\b|\bm\.?\s?com\b/i,
  ],
  [
    'higher_secondary',
    /\bxii(th)?\b|\b12(th)?\b|\btwelfth\b|\bh\.?s\.?s?\.?c\b|higher secondary|senior secondary|\bintermediate\b|pre[- ]?university|\bpuc\b|plus two/i,
  ],
  ['diploma', /\bdiploma\b/i],
  [
    'secondary',
    /^x\b|\bx(th)?\s*(std|standard|class)\b|\bclass\s*x\b|\b10(th)?\b|\btenth\b|\bs\.?s\.?l\.?c\b|\bs\.?s\.?c\b|\bmatric|\bhigh school\b|\bsecondary\b/i,
  ],
  [
    'undergraduate',
    /\bgraduat|\bunder[- ]?graduat|\bug\b|\bbachelor|\bb\.?\s?tech\b|\bbca\b|\bb\.?\s?sc\b|\bb\.?\s?com\b|\bbba\b/i,
  ],
];

/**
 * The education level a heading or degree names: "X/SSLC/Junior/Equivalent" → secondary,
 * "Class 12th (MP Board)" → higher_secondary, "Post Graduation" → postgraduate.
 */
export function educationLevelOf(text: string | undefined): EducationLevel | undefined {
  if (!text) return undefined;
  return LEVEL_PATTERNS.find(([, re]) => re.test(text))?.[0];
}

/**
 * Keys a remembered answer is stored and looked up under. A question inside a section is keyed
 * with its section; outside education-level sections it is also keyed by its own label, so
 * "Date of Birth" is reused across forms while the X and XII "Board" stay separate.
 */
export function savedAnswerKeys(label: string, section?: string): string[] {
  const keys: string[] = [];
  if (section) keys.push(questionKey(`${section} ${label}`));
  if (!section || !educationLevelOf(section)) keys.push(questionKey(label));
  return [...new Set(keys.filter(Boolean))];
}
