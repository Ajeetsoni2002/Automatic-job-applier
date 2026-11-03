// Matching an answer to the wording a site uses for its options: "B.Tech" is listed as
// "Bachelor of Technology", "MP Board" as "Madhya Pradesh Board", and a college may be listed
// without its city ("University Institute Of Technology, Sample University").

// Abbreviations written in capitals (state names, degrees). Applied before lower-casing so
// ordinary words ("up", "be") are left alone.
const CASED_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bM\.?\s?P\.?(?=$|[\s,)/-])/g, 'Madhya Pradesh'],
  [/\bU\.?\s?P\.?(?=$|[\s,)/-])/g, 'Uttar Pradesh'],
  [/\bH\.?\s?P\.?(?=$|[\s,)/-])/g, 'Himachal Pradesh'],
  [/\bA\.?\s?P\.?(?=$|[\s,)/-])/g, 'Andhra Pradesh'],
  [/\bT\.?\s?N\.?(?=$|[\s,)/-])/g, 'Tamil Nadu'],
  [/\bW\.?\s?B\.?(?=$|[\s,)/-])/g, 'West Bengal'],
  [/\bJ\s?&\s?K\b/g, 'Jammu and Kashmir'],
  [/\bB\.?\s?E\.?(?=$|[\s,)/-])/g, 'Bachelor of Engineering'],
  [/\bM\.?\s?E\.?(?=$|[\s,)/-])/g, 'Master of Engineering'],
  [/\bCSE\b/g, 'Computer Science and Engineering'],
  [/\bECE\b/g, 'Electronics and Communication Engineering'],
  [/\bEEE\b/g, 'Electrical and Electronics Engineering'],
  [/\bIT\b/g, 'Information Technology'],
];

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bb\.?\s?tech\b\.?/gi, 'Bachelor of Technology'],
  [/\bm\.?\s?tech\b\.?/gi, 'Master of Technology'],
  [/\bb\.?\s?sc\b\.?/gi, 'Bachelor of Science'],
  [/\bm\.?\s?sc\b\.?/gi, 'Master of Science'],
  [/\bb\.?\s?com\b\.?/gi, 'Bachelor of Commerce'],
  [/\bm\.?\s?com\b\.?/gi, 'Master of Commerce'],
  [/\bbca\b/gi, 'Bachelor of Computer Applications'],
  [/\bmca\b/gi, 'Master of Computer Applications'],
  [/\bbba\b/gi, 'Bachelor of Business Administration'],
  [/\bmba\b/gi, 'Master of Business Administration'],
];

/** Writes out abbreviations: "B.Tech" → "Bachelor of Technology", "MP Board" → "Madhya Pradesh Board". */
export function expandAbbreviations(text: string): string {
  let out = text;
  for (const [re, full] of CASED_ABBREVIATIONS) out = out.replace(re, full);
  for (const [re, full] of ABBREVIATIONS) out = out.replace(re, full);
  return out.replace(/\s+/g, ' ').trim();
}

// Words that differ only in spelling or shortening.
const SYNONYMS: Record<string, string> = {
  engg: 'engineering',
  engineerng: 'engineering',
  tech: 'technology',
  comp: 'computer',
  sci: 'science',
  govt: 'government',
  vishwavidyalaya: 'university',
  vishwavidyalay: 'university',
  vishwavidhyalaya: 'university',
  univ: 'university',
  inst: 'institute',
  institution: 'institute',
  cert: 'certificate',
  std: 'standard',
  honours: 'honors',
  hons: 'honors',
};
const FILLER = new Set(['of', 'the', 'and', 'in', 'for', 'at', 'a', 'an', 'to']);

/** The words of an option, normalised for comparison. */
export function optionTokens(text: string): string[] {
  return expandAbbreviations(text)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .map((w) => SYNONYMS[w] ?? w);
}

/**
 * How well an option names the wanted value, from 0 to 1. 1 = the same words; an option that is
 * the wanted value without its city or campus ("…, Indore") still scores high.
 */
export function optionScore(wanted: string, option: string): number {
  const W = new Set(optionTokens(wanted));
  const O = new Set(optionTokens(option));
  if (!W.size || !O.size) return 0;
  let inter = 0;
  for (const w of W) if (O.has(w)) inter++;
  if (inter === W.size && inter === O.size) return 1;
  const jaccard = inter / (W.size + O.size - inter);
  // Every word of the option is in the wanted value: the site lists a shorter name.
  const shorter = inter === O.size ? inter / W.size : 0;
  return Math.max(jaccard, shorter);
}

/**
 * The option that clearly names the wanted value, or undefined when none is close enough or two
 * are about as close (then you choose).
 */
export function bestOption(wanted: string, options: string[]): string | undefined {
  const scored = [...new Set(options)]
    .map((o) => ({ o, s: optionScore(wanted, o) }))
    .sort((a, b) => b.s - a.s);
  const [top, second] = scored;
  if (!top || top.s < 0.75) return undefined;
  if (top.s < 1 && second && second.s > top.s - 0.15) return undefined;
  return top.o;
}

/** Options closest to the wanted value, to show you when none matched clearly. */
export function closestOptions(wanted: string, options: string[], n = 4): string[] {
  return [...new Set(options)]
    .map((o) => ({ o, s: optionScore(wanted, o) }))
    .filter((x) => x.s > 0.2)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.o);
}

// Words too common in institution and board names to narrow a search.
const COMMON = new Set([
  'university',
  'institute',
  'technology',
  'college',
  'school',
  'engineering',
  'science',
  'sciences',
  'board',
  'government',
  'national',
  'education',
  'secondary',
  'higher',
  'state',
  'management',
  'research',
  'studies',
  'india',
  'indian',
  'bachelor',
  'master',
  'excellence',
]);

/**
 * What to type into a dropdown's search box, best first: the value, its abbreviations written
 * out, the value without trailing place names, and its most distinctive word.
 */
export function searchQueries(value: string): string[] {
  const v = value.trim();
  const out = [v, expandAbbreviations(v)];
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (let n = parts.length - 1; n >= 1; n--) out.push(parts.slice(0, n).join(', '));
  // Lists often drop "and"/"of" ("Computer Science Engineering"); a long list shows only its
  // first matches, so its first words narrow it better than one common word.
  const words = expandAbbreviations(parts[0] ?? v)
    .split(/[\s&/-]+/)
    .filter((w) => w && !FILLER.has(w.toLowerCase()));
  if (words.length > 1) out.push(words.join(' '));
  if (words.length > 2) out.push(words.slice(0, 2).join(' '));
  const distinctive = optionTokens(v)
    .filter((w) => w.length >= 5 && !COMMON.has(w) && !/^\d+$/.test(w))
    .sort((a, b) => b.length - a.length)[0];
  if (distinctive) out.push(distinctive);
  const unique: string[] = [];
  for (const q of out)
    if (q.length >= 2 && !unique.some((u) => u.toLowerCase() === q.toLowerCase())) unique.push(q);
  return unique.slice(0, 6);
}
