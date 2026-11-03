// Education questions answered from the profile's education entries. Forms repeat the same
// questions (Board, School, Percentage, Passing year) for X, XII, graduation and
// post-graduation; the section heading, or the question itself ("12th percentage"), says
// which entry is meant.
import {
  EDUCATION_LEVELS,
  educationLevelOf,
  type EducationLevel,
  type Profile,
} from '@ja/shared';
import { bestOption, expandAbbreviations } from './match.js';
import type { AnswerValue, FormField } from './types.js';

type Entry = Profile['education'][number];

export interface EducationProposal {
  value: AnswerValue;
  source: string;
  note?: string;
}

type Attr =
  | 'board'
  | 'university'
  | 'institution'
  | 'degree'
  | 'field'
  | 'grade'
  | 'end'
  | 'start'
  | 'country'
  | 'state'
  | 'city';

// First match wins: "Passing month and year" is a date, not a degree.
const ATTRS: Array<[Attr, RegExp]> = [
  ['grade', /percent|\bc?gpa\b|\bgrade\b|\bmarks?\b|\bscore\b|aggregate|\bdivision\b/],
  [
    'end',
    /passing|pass(ed)?[- ]?out|completion|year of (passing|completion)|graduation (year|date)|end (date|year|month)|\bto (date|year)\b|\bbatch\b/,
  ],
  ['start', /\bstart|joining|admission|enrol|commence|\bfrom (date|year)\b/],
  ['board', /\bboard\b/],
  ['university', /\buniversity\b|affiliat/],
  ['institution', /\b(school|college|institut(e|ion)|academy)\b/],
  ['field', /speciali[sz]ation|\bbranch\b|\bstream\b|discipline|\bmajor\b|\bsubjects?\b/],
  [
    'degree',
    /\b(degree|qualification|course|certificate|certification|examination|exam|programme|program)\b/,
  ],
  ['country', /\bcountry\b/],
  ['state', /\bstate\b|province/],
  ['city', /\bcity\b|district|\btown\b|location/],
];

// Questions about the highest qualification when the form has no level sections.
const HIGHEST: Array<[Attr, RegExp]> = [
  ['degree', /^(highest |latest )?(degree|qualification|education( level)?)( name)?$/],
  ['institution', /^(name of (the )?)?(college|institute|institution)( name)?$/],
  ['university', /^(name of (the )?)?university( name)?$/],
  ['field', /^(branch|stream|specialization|specialisation|major|discipline)$/],
  ['grade', /^(cgpa|gpa|percentage|aggregate( percentage)?|graduation (percentage|cgpa))$/],
  ['end', /^(year of passing|passing year|graduation year|year of graduation|pass ?out year|batch)$/],
];

// How certificates are named on forms, by level ("Secondary School Leaving Cert.").
const DEGREE_NAMES: Record<EducationLevel, string[]> = {
  secondary: [
    'Secondary School Leaving Certificate',
    'Secondary School Leaving Cert',
    'Secondary School Certificate',
    'SSLC',
    'SSC',
    'Class X',
    '10th',
    'Matriculation',
    'High School',
  ],
  higher_secondary: [
    'Higher Secondary School Certificate',
    'Higher Secondary Certificate',
    'Higher Secondary',
    'Senior Secondary',
    'HSC',
    'HSSC',
    'Intermediate',
    'Class XII',
    'XII Standard',
    '12th',
  ],
  diploma: ['Diploma'],
  undergraduate: [],
  postgraduate: [],
};

const LEVEL_NAMES: Record<EducationLevel, string> = {
  secondary: 'class X',
  higher_secondary: 'class XII',
  diploma: 'diploma',
  undergraduate: 'graduation',
  postgraduate: 'post-graduation',
};

const hasOptions = (f: FormField) =>
  ['select', 'combobox', 'radio', 'buttons', 'multiselect', 'checkboxes'].includes(f.kind);

export const entryLevel = (e: Entry): EducationLevel | undefined =>
  e.level ?? educationLevelOf(e.degree) ?? educationLevelOf(e.institution);

const optionsOf = (f: FormField) => (f.searchable ? [] : (f.options ?? []));

/** The option for one of several candidate names, in order of preference. */
function choose(f: FormField, names: string[]): string | undefined {
  const opts = optionsOf(f);
  for (const n of names) {
    const want = n.toLowerCase().replace(/\.$/, '');
    const hit =
      opts.find((o) => o.toLowerCase().replace(/\.$/, '') === want) ??
      opts.find((o) => o.toLowerCase().startsWith(want));
    if (hit) return hit;
  }
  return names[0] ? bestOption(names[0], opts) : undefined;
}

function boardOf(e: Entry): string | undefined {
  return e.board ?? e.degree.match(/\(([^)]*\bboard\b[^)]*)\)/i)?.[1]?.trim();
}

function universityOf(e: Entry): string | undefined {
  if (e.university) return e.university;
  const parts = e.institution.split(',').map((s) => s.trim());
  const named = parts.find((p) => /\b(university|vishwavidyalaya|vidyapeeth)$/i.test(p));
  return named;
}

/** "CGPA 8.1" → 8.1; "81.4%" → 81.4. Undefined when the question asks for the other scale. */
function gradeFor(f: FormField, e: Entry): string | undefined {
  const g = e.grade ?? '';
  const n = g.match(/\d+(?:\.\d+)?/)?.[0];
  if (!n) return undefined;
  const isCgpa = /c?gpa/i.test(g) || (!/%/.test(g) && Number(n) <= 10);
  const l = f.label.toLowerCase();
  const asksPercent = /percent|%/.test(l);
  const asksCgpa = /c?gpa|grade point/.test(l);
  if (asksPercent && !asksCgpa && isCgpa) return undefined;
  if (asksCgpa && !asksPercent && !isCgpa) return undefined;
  return n;
}

/** Year or year-month of a profile date ("2025" or "2025-06") as the question wants it. */
function dateFor(f: FormField, when: string): string | undefined {
  const m = when.match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!m) return undefined;
  const [, year, month] = m;
  const l = f.label.toLowerCase();
  const wantsMonth = /month/.test(l) || (f.kind === 'date' && !/\byear\b/.test(l));
  if (wantsMonth) {
    if (!month) return undefined;
    // A full date can't be made from a month.
    if (f.kind === 'date' && !/month/.test(l)) return undefined;
    return `${year}-${month.padStart(2, '0')}`;
  }
  if (hasOptions(f)) return optionsOf(f).find((o) => o.includes(year!)) ?? (f.searchable ? year : undefined);
  return year;
}

/**
 * The level a field is about, from its section heading or a short question naming it ("12th
 * percentage"). Long questions are skipped: "work 12-hour shifts" is not about class XII.
 */
function levelFor(f: FormField): EducationLevel | undefined {
  const short = f.label.trim().split(/\s+/).length <= 6;
  return educationLevelOf(f.section) ?? (short ? educationLevelOf(f.label) : undefined);
}

const ABOUT_LEVELS =
  /qualification|education|degree|class|standard|xii|\bx\b|diploma|graduat|course|stud(y|ies)/i;

/**
 * Answers an education question from the profile. Returns undefined for questions that aren't
 * about education, and null for education questions the profile can't answer (so no guess from
 * the residence address or a generic rule is used).
 */
export function educationAnswer(
  f: FormField,
  profile: Profile,
): EducationProposal | null | undefined {
  const entries = profile.education;
  const label = f.label
    .toLowerCase()
    .replace(/\(optional\)/g, '')
    .trim();

  // "Please provide either Class XII or Diploma details": options that are levels.
  if (hasOptions(f) && f.options?.length && ABOUT_LEVELS.test(`${f.section ?? ''} ${f.label}`)) {
    const levels = new Set(entries.map(entryLevel).filter(Boolean));
    const levelOptions = f.options.filter((o) => educationLevelOf(o));
    if (new Set(levelOptions.map((o) => educationLevelOf(o))).size >= 2) {
      const held = levelOptions.filter((o) => levels.has(educationLevelOf(o)));
      if (!held.length) return null;
      if (f.kind === 'checkboxes' || f.kind === 'multiselect')
        return { value: held, source: 'profile', note: 'the levels in your education' };
      const rank = (o: string) => EDUCATION_LEVELS.indexOf(educationLevelOf(o)!);
      const highest = [...held].sort((a, b) => rank(b) - rank(a))[0]!;
      return { value: highest, source: 'profile', note: 'your highest qualification' };
    }
  }

  const sectionLevel = educationLevelOf(f.section);
  let level = levelFor(f);
  let attr = ATTRS.find(([, re]) => re.test(label))?.[0];
  if (!level) {
    // No level named: only clear "highest qualification" questions are answered.
    attr = HIGHEST.find(([, re]) => re.test(label))?.[0];
    if (!attr) return undefined;
    level = entries
      .map(entryLevel)
      .filter((x): x is EducationLevel => Boolean(x))
      .sort((a, b) => EDUCATION_LEVELS.indexOf(b) - EDUCATION_LEVELS.indexOf(a))[0];
    if (!level) return null;
  }
  // Place questions only count as education inside an education section.
  if (!attr || (!sectionLevel && ['country', 'state', 'city'].includes(attr))) return undefined;

  const entry = entries.find((e) => entryLevel(e) === level);
  if (!entry) {
    return {
      value: f.kind === 'checkboxes' || f.kind === 'multiselect' ? [] : '',
      source: 'profile',
      note: `no ${LEVEL_NAMES[level]} in your profile`,
    };
  }

  const fact = (value: string | undefined, note?: string): EducationProposal | null =>
    value ? { value, source: 'profile', ...(note && { note }) } : null;

  switch (attr) {
    case 'board':
      return fact(boardOf(entry));
    case 'university':
      return fact(universityOf(entry));
    case 'institution':
      return fact(entry.institution);
    case 'degree': {
      if (!hasOptions(f)) return fact(entry.degree);
      const names = [entry.degree, expandAbbreviations(entry.degree), ...DEGREE_NAMES[level]];
      const picked = choose(f, names);
      if (picked) return fact(picked);
      // Searchable lists show only part of their options: search for the full degree name.
      return f.searchable ? fact(expandAbbreviations(entry.degree)) : null;
    }
    case 'field':
      return fact(entry.field);
    case 'grade':
      return fact(gradeFor(f, entry));
    case 'end':
      return fact(
        dateFor(f, entry.end),
        /^\d{4}$/.test(entry.end) ? undefined : 'passing month from your profile',
      );
    case 'start':
      return fact(dateFor(f, entry.start));
    case 'country': {
      const residence = profile.personal.location.split(',').map((s) => s.trim()).at(-1);
      return entry.country
        ? fact(entry.country)
        : fact(residence, 'assumed the same country as your address');
    }
    case 'state':
      return fact(entry.state);
    default:
      return null;
  }
}
