import fs from 'node:fs';
import { z } from 'zod';
import {
  getEnv,
  llmEnabled,
  questionKey,
  savedAnswerKeys,
  type Profile,
  type QaBank,
} from '@ja/shared';
import { structuredCall, type StructuredCall } from '../llm/client.js';
import { findCities } from '../pipeline/normalize.js';
import { checkClaims, type TechVocabulary } from '../tailor/claims.js';
import { profileForPrompt } from '../tailor/resume.js';
import { educationAnswer } from './education.js';
import { bestOption } from './match.js';
import type { Answer, AnswerValue, FillFiles, FormField } from './types.js';

export interface SavedAnswerLike {
  questionKey: string;
  question: string;
  value: unknown;
  kind?: string | null;
}

export interface AnswerContext {
  profile: Profile;
  qaBank: QaBank;
  saved: SavedAnswerLike[];
  job: { title: string; company: string; location: string; description: string };
  files: FillFiles;
  vocab: TechVocabulary;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DECLINE =
  /decline|prefer not|don'?t wish|do not wish|not to (say|disclose|answer)|rather not|choose not/i;
const PLACEHOLDER = /<[^>]+>/;

const words = (s: string) => new Set(questionKey(s).split(' ').filter(Boolean));
function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Match exact options first, then whole phrases; never match MALE inside FEMALE. */
export function pickOption(options: string[] | undefined, wanted: string): string | undefined {
  if (!options?.length || !wanted) return undefined;
  const w = wanted.toLowerCase().trim();
  const containsPhrase = (text: string, phrase: string) => {
    if (!phrase) return false;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}+#])${escaped}(?=$|[^\\p{L}\\p{N}+#])`, 'u').test(text);
  };
  return (
    options.find((o) => o.toLowerCase().trim() === w) ??
    options.find((o) => containsPhrase(o.toLowerCase(), w)) ??
    options.find((o) => o.trim().length > 1 && containsPhrase(w, o.toLowerCase().trim())) ??
    // Differently written names: "B.Tech" for "Bachelor of Technology".
    bestOption(wanted, options)
  );
}

const hasOptions = (f: FormField) =>
  ['select', 'combobox', 'radio', 'buttons', 'multiselect', 'checkboxes'].includes(f.kind);

interface Proposal {
  value: AnswerValue;
  source: string;
  needsReview?: boolean;
  note?: string;
  /** The form marks it required, but an answer elsewhere makes it unnecessary (e.g. "current role"). */
  notRequired?: boolean;
}

function qaAnswer(ctx: AnswerContext, key: string): string | undefined {
  const a = ctx.qaBank.answers.find((x) => x.key === key)?.answer;
  return a && !PLACEHOLDER.test(a) ? a : undefined;
}

/** Deterministic answers taken straight from the profile, the Q&A bank or the generated files. */
export function ruleAnswer(f: FormField, ctx: AnswerContext): Proposal | undefined {
  const { profile } = ctx;
  const l = f.label.toLowerCase();
  const k = f.key.toLowerCase();
  const p = profile.personal;
  const names = p.name.trim().split(/\s+/);
  const current = profile.experience.find((e) => e.end === 'present') ?? profile.experience[0];
  const fromProfile = (value: AnswerValue | undefined): Proposal | undefined =>
    value === undefined || value === '' ? undefined : { value, source: 'profile' };

  if (f.kind === 'file') {
    if (/resume|cv\b|curriculum/.test(l) || /resume/.test(k))
      return ctx.files.resumePdf ? { value: ctx.files.resumePdf, source: 'file' } : undefined;
    if (/cover/.test(l))
      return ctx.files.coverLetterPdf
        ? { value: ctx.files.coverLetterPdf, source: 'file' }
        : undefined;
    return undefined;
  }
  if (f.kind === 'textarea' && /cover letter/.test(l) && ctx.files.coverLetterText)
    return { value: ctx.files.coverLetterText, source: 'file' };

  // X, XII and graduation questions come from their education entry, never the address.
  const education = educationAnswer(f, profile);
  if (education !== undefined) return education ?? undefined;

  // Country and city of residence, from "City, Country" in the profile (plain or from a list).
  const [city, ...rest] = p.location.split(',').map((s) => s.trim());
  const country = rest.at(-1);
  const place = (value: string | undefined): Proposal | undefined => {
    if (!value) return undefined;
    if (!hasOptions(f)) return fromProfile(value);
    const o = pickOption(f.options, value);
    if (o) return { value: o, source: 'profile' };
    return f.kind === 'combobox' ? fromProfile(value) : undefined; // typed, then picked
  };
  if (hasOptions(f) && /country|phone code|dial(l?ing)? code/.test(l) && p.phone?.startsWith('+')) {
    const digits = p.phone.replace(/\D/g, '');
    const matches = f.options?.filter((o) => {
      const code = o.match(/\+?(\d{1,4})\)?\s*$/)?.[1];
      return code && digits.startsWith(code) && digits.length > code.length + 4;
    });
    const match =
      matches?.find((o) => country && o.toLowerCase().includes(country.toLowerCase())) ??
      (matches?.length === 1 ? matches[0] : undefined);
    if (match) return fromProfile(match);
  }
  if (/^country( of residence| or region)?$/.test(l) || k === 'country') return place(country);
  if (/^(location \(city\)|city|current city|city of residence)$/.test(l)) return place(city);

  // Greenhouse employment section: company-name-0, title-0, start-date-month-0, …
  const emp = k.match(
    /^(company-name|title|start-date-month|start-date-year|end-date-month|end-date-year|current-role)-(\d+)/,
  );
  if (emp) {
    const e = profile.experience[Number(emp[2])];
    if (!e) return undefined;
    const [sy, sm] = e.start.split('-');
    const [ey, em] = e.end === 'present' ? [] : e.end.split('-');
    switch (emp[1]) {
      case 'company-name':
        return fromProfile(e.company);
      case 'title':
        return fromProfile(e.title);
      case 'start-date-month':
        return fromProfile(sm ? MONTHS[Number(sm) - 1] : undefined);
      case 'start-date-year':
        return fromProfile(sy);
      case 'end-date-month':
        return e.end === 'present'
          ? { value: '', source: 'profile', notRequired: true, note: 'current role: no end date' }
          : fromProfile(em ? MONTHS[Number(em) - 1] : undefined);
      case 'end-date-year':
        return e.end === 'present'
          ? { value: '', source: 'profile', notRequired: true, note: 'current role: no end date' }
          : fromProfile(ey);
      case 'current-role':
        return { value: e.end === 'present', source: 'profile' };
    }
  }

  if (/^first name|given name/.test(l) || k === 'first_name')
    return fromProfile(names.length > 1 ? names.slice(0, -1).join(' ') : names[0]);
  if (/^last name|surname|family name/.test(l) || k === 'last_name')
    return fromProfile(names.length > 1 ? names.at(-1) : '');
  if (/^(full |legal |your )?name$/.test(l) || k === 'name' || k === '_systemfield_name')
    return fromProfile(p.name);
  // Alternate contacts and device types are separate facts, absent from this profile.
  if (/alternate|secondary|emergency/.test(l) && /e-?mail|phone|mobile|contact number/.test(l))
    return undefined;
  if (/phone.*(device|type)|country.*(phone|code)|dial(l?ing)? code/.test(l)) return undefined;
  if (/e-?mail/.test(l) || f.kind === 'email') return fromProfile(p.email);
  if (/phone|mobile|contact number|whatsapp/.test(l) || f.kind === 'tel') {
    if (f.nationalPhone) {
      const national =
        p.phone?.match(/^\+\d{1,3}[-\s]+(.+)$/)?.[1] ??
        (country?.toLowerCase() === 'india' ? p.phone?.replace(/^\+91/, '') : undefined);
      return fromProfile(national?.replace(/\D/g, ''));
    }
    // Number boxes take digits only: the 10-digit number (the country code is a separate box).
    if (f.kind === 'number') return fromProfile(p.phone?.replace(/\D/g, '').slice(-10));
    return fromProfile(p.phone?.replace(/[-\s]/g, '').replace(/^(\+\d{2})(\d+)$/, '$1 $2'));
  }
  if (/linkedin/.test(l)) return fromProfile(p.links.linkedin);
  if (/github/.test(l)) return fromProfile(p.links.github);
  if (/leetcode/.test(l)) return fromProfile(p.links.leetcode);
  if (/portfolio|personal (web)?site|^website|other website/.test(l))
    return fromProfile(p.links.portfolio);
  if (/twitter|\bx profile/.test(l)) return { value: '', source: 'profile' };

  if (!hasOptions(f)) {
    if (/current (company|employer|organi[sz]ation)|^org$|^company$/.test(l) || k === 'org')
      return fromProfile(current?.company);
    if (/current (job )?(title|designation|role|position)/.test(l))
      return fromProfile(current?.title);
    if (
      /^(current )?location$|current city|where are you (based|located)|city of residence/.test(l)
    )
      return fromProfile(p.location);
    if (
      /years of (relevant |total |professional )?(work )?experience|total experience|experience in years/.test(
        l,
      )
    )
      return fromProfile(String(profile.totalExperienceYears));
  }

  if (/notice period|earliest (start|joining)|how soon can you (join|start)/.test(l))
    return {
      value: qaAnswer(ctx, 'notice_period') ?? `${profile.preferences.noticePeriodDays} days`,
      source: 'qa_bank',
    };
  if (
    /expected (ctc|salary|compensation)|salary expectation|desired (salary|compensation)/.test(l)
  ) {
    const a = qaAnswer(ctx, 'expected_ctc');
    return a ? { value: a, source: 'qa_bank' } : undefined;
  }
  if (/current (ctc|salary|compensation)/.test(l)) {
    const a = qaAnswer(ctx, 'current_ctc');
    return a ? { value: a, source: 'qa_bank' } : undefined;
  }

  // "Willing to work from office in Bengaluru?" follows your preferred locations, not the LLM.
  const cities = findCities(f.label);
  if (
    cities.length &&
    /willing|open to|comfortable|okay|ready to|able to|can you|are you/.test(l) &&
    /office|relocat|on-?site|work from|based|move|commute|location/.test(l)
  ) {
    const wanted = new Set(profile.preferences.locations.flatMap((x) => findCities(x)));
    const yes = cities.every((c) => wanted.has(c));
    return {
      value: yes ? 'Yes' : 'No',
      source: 'profile',
      note: `${cities.join('/')} ${yes ? 'is' : 'is not'} in your preferred locations`,
    };
  }

  if (
    /how did you (hear|find|learn|come across)|where did you (hear|find|see)|referral source|source of (application|hire)/.test(
      l,
    )
  ) {
    const qa = qaAnswer(ctx, 'source');
    if (qa) return { value: qa, source: 'qa_bank' };
    if (!profile.preferences.allowGeneratedApplicationAnswers) return undefined;
    if (hasOptions(f)) {
      const opt = ['company website', 'career', 'website', 'linkedin', 'job board', 'other']
        .map((w) => pickOption(f.options, w))
        .find(Boolean);
      return opt ? { value: opt, source: 'rule' } : undefined;
    }
    return { value: 'Company careers page', source: 'rule' };
  }

  // Voluntary self-identification: take the "decline" option when the form offers one.
  if (
    /gender|\bsex\b|race|ethnic|veteran|disabilit|sexual orientation|pronoun/.test(l) &&
    hasOptions(f)
  ) {
    const decline = f.options?.find((o) => DECLINE.test(o));
    if (decline) return { value: decline, source: 'rule', note: 'voluntary question: declined' };
  }

  // A B.Tech graduate is an adult; this needs no personal data.
  if (
    /(over|above|at least) (the age of )?18|18 years (of age|or older)|legal(ly)? (age|adult)/.test(
      l,
    )
  ) {
    if (!profile.preferences.allowGeneratedApplicationAnswers) return undefined;
    const yes = hasOptions(f) ? pickOption(f.options, 'yes') : 'Yes';
    if (f.kind === 'checkbox') return { value: true, source: 'profile', note: 'graduate, so 18+' };
    if (yes) return { value: yes, source: 'profile', note: 'graduate, so 18+' };
  }

  if (
    f.kind === 'checkbox' &&
    /agree|consent|privacy|terms|acknowledge|certify|confirm|accurate/.test(l)
  )
    return {
      value: true,
      source: 'rule',
      note: 'consent box: ticked because you approve the application',
    };

  return undefined;
}

/** Q&A bank entries and answers you saved earlier, matched by wording. */
export function knownAnswer(f: FormField, ctx: AnswerContext): Proposal | undefined {
  const saved = savedAnswerKeys(f.label, f.section)
    .map((key) => ctx.saved.find((s) => s.questionKey === key))
    .find(Boolean);
  if (saved && saved.value !== '' && saved.value != null) {
    // A saved file must still exist, and file answers only fit file fields (and vice versa).
    const isFile = saved.kind === 'file';
    if (isFile === (f.kind === 'file') && (!isFile || fs.existsSync(String(saved.value)))) {
      // Written answers may name another company: worth a look before they are sent again.
      if (f.kind === 'textarea')
        return {
          value: saved.value as AnswerValue,
          source: 'saved',
          needsReview: true,
          note: 'your saved answer from an earlier form: check it fits this one',
        };
      return { value: saved.value as AnswerValue, source: 'saved' };
    }
  }
  let best: { answer: string; score: number } | undefined;
  for (const qa of ctx.qaBank.answers) {
    if (PLACEHOLDER.test(qa.answer)) continue;
    const l = f.label.toLowerCase();
    const alias = qa.aliases.some((a) => a.length > 3 && l.includes(a.toLowerCase()));
    const score = alias ? 1 : similarity(f.label, qa.question);
    if (score >= 0.5 && (!best || score > best.score)) best = { answer: qa.answer, score };
  }
  return best ? { value: best.answer, source: 'qa_bank' } : undefined;
}

/** Makes a proposed value fit the field: options must match exactly, booleans for checkboxes. */
export function conform(f: FormField, value: AnswerValue): { value: AnswerValue; ok: boolean } {
  if (f.kind === 'checkbox')
    return { value: value === true || /^(yes|true|1)$/i.test(String(value)), ok: true };
  if (f.kind === 'checkboxes' || f.kind === 'multiselect') {
    const wanted = Array.isArray(value)
      ? value
      : String(value)
          .split(/;|\n/)
          .map((s) => s.trim())
          .filter(Boolean);
    const picked = wanted
      .map((w) => pickOption(f.options, w))
      .filter((x): x is string => Boolean(x));
    return { value: picked, ok: picked.length > 0 || !wanted.length };
  }
  if (hasOptions(f) && f.options?.length) {
    const v = String(value);
    if (!v) return { value: '', ok: true };
    const opt =
      f.kind === 'combobox' && f.searchable
        ? f.options.find((option) => option.trim().toLowerCase() === v.trim().toLowerCase())
        : pickOption(f.options, v);
    if (opt) return { value: opt, ok: true };
    // City search boxes list places only after you type: the typed city is picked when filling.
    if (f.kind === 'combobox' && (f.searchable || /city|location/i.test(f.label)))
      return { value: v, ok: true }; // the live dropdown must still resolve the exact option
    return { value: v, ok: false };
  }
  return { value: typeof value === 'string' ? value : String(value), ok: true };
}

const LlmAnswersSchema = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      value: z
        .string()
        .describe('The answer. For choice fields, the exact option text. Empty if unknown.'),
      needsUser: z
        .boolean()
        .describe('True when only the candidate can answer (personal facts not in the profile)'),
      note: z.string().describe('Very short reason or source'),
    }),
  ),
});

function llmSystemPrompt(ctx: AnswerContext): string {
  const qa = ctx.qaBank.answers
    .filter((a) => !PLACEHOLDER.test(a.answer))
    .map((a) => `- ${a.question} → ${a.answer}`)
    .join('\n');
  const saved = ctx.saved
    .filter((s) => s.kind !== 'file')
    .map((s) => `- ${s.question} → ${JSON.stringify(s.value).slice(0, 200)}`)
    .join('\n');
  return `You fill job application forms for one candidate. For each field you get, return an answer.

Rules:
- Facts must come from the candidate profile, the Q&A answers or the saved answers below. Never invent personal details (salary, gender, date of birth, nationality, visa status, addresses, phone numbers, references). If a required field needs such a detail and it isn't below, return value "" and needsUser true.
- Choice fields (select, combobox, radio, buttons, checkboxes): value must be one of the listed options, copied exactly. For checkboxes, separate several options with ";".
- Searchable comboboxes marked optionsArePartial list only currently rendered examples: you may supply the exact candidate fact from the profile or saved answers to search for it. Never pick a listed example unless it is that fact. Never invent a fact; the browser must resolve an actual matching result before proceeding.
- A field's section is the form heading it sits under (e.g. "X/SSLC", "XII Standard", "Graduation", "Post Graduation"): answer it about that part only. A section the profile has nothing for stays empty.
- Yes/No questions about willingness (relocation, working from office in a city, shifts) follow the candidate's preferences: locations ${ctx.profile.preferences.locations.join(', ')}; work modes ${ctx.profile.preferences.workModes.join(', ')}.
- "Current designation"-style choices: the candidate has ${ctx.profile.totalExperienceYears} year(s) of full-time experience after a B.Tech finished in ${ctx.profile.preferences.graduationYear ?? 'recently'}.
- Free-text questions (textarea): write 50-120 words in the first person, using only facts from the profile. No invented numbers, tools or outcomes.
- Optional fields you can't answer from the information below: value "" and needsUser false.

Candidate profile (YAML):
${profileForPrompt(ctx.profile)}
Contact: ${ctx.profile.personal.name}, ${ctx.profile.personal.email}, ${ctx.profile.personal.phone ?? ''}, ${ctx.profile.personal.location}

Q&A answers:
${qa || '(none)'}

Saved answers from earlier applications:
${saved || '(none)'}`;
}

/**
 * Answers every field: rules first (profile facts, files), then the Q&A bank and saved answers,
 * then one LLM call for the rest. Required fields left without an answer are marked needsInput.
 */
export async function answerFields(
  fields: FormField[],
  ctx: AnswerContext,
  call?: StructuredCall,
): Promise<Answer[]> {
  const answers = new Map<string, Answer>();
  const base = (f: FormField): Answer => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    required: f.required,
    options: f.options,
    ...(f.section && { section: f.section }),
    value:
      f.kind === 'checkbox' ? false : f.kind === 'checkboxes' || f.kind === 'multiselect' ? [] : '',
    source: '',
    needsInput: false,
    needsReview: false,
  });

  const pending: FormField[] = [];
  for (const f of fields) {
    const proposal = ruleAnswer(f, ctx) ?? knownAnswer(f, ctx);
    if (proposal) {
      const c = conform(f, proposal.value);
      if (c.ok) {
        answers.set(f.key, {
          ...base(f),
          value: c.value,
          source: proposal.source,
          note: proposal.note,
          needsReview: Boolean(proposal.needsReview),
          ...(proposal.notRequired && { required: false }),
        });
        continue;
      }
    }
    pending.push(f);
  }

  // Facts-only filling never delegates unknown answers to a model, including injected calls.
  const llm = ctx.profile.preferences.allowGeneratedApplicationAnswers
    ? call ?? (llmEnabled() ? structuredCall : undefined)
    : undefined;
  if (pending.length && llm) {
    const fieldList = pending.map((f) => ({
      key: f.key,
      label: f.label,
      ...(f.section && { section: f.section }),
      kind: f.kind,
      required: f.required,
      ...(f.searchable && { searchable: true, optionsArePartial: true }),
      options:
        f.options && f.options.length <= 60
          ? f.options
          : f.options
            ? `${f.options.length} options, e.g. ${f.options.slice(0, 8).join(' | ')}`
            : undefined,
    }));
    const out = await llm({
      purpose: 'apply_answers',
      model: getEnv().LLM_MODEL_FAST,
      system: llmSystemPrompt(ctx),
      user: `Job: ${ctx.job.title} at ${ctx.job.company} (${ctx.job.location || 'location not stated'})\n${ctx.job.description.slice(0, 2500)}\n\nFields to answer (JSON):\n${JSON.stringify(fieldList, null, 1)}`,
      schema: LlmAnswersSchema,
      maxTokens: 4096,
    });
    const byKey = new Map(out.answers.map((a) => [a.key, a]));
    for (const f of pending) {
      const a = byKey.get(f.key);
      if (!a || a.needsUser || !a.value.trim()) continue;
      const c = conform(f, a.value);
      if (!c.ok) continue;
      const essay = f.kind === 'textarea';
      let note = a.note;
      if (essay) {
        const check = checkClaims(ctx.vocab, String(c.value), profileForPrompt(ctx.profile));
        if (!check.ok)
          note = `Check this: mentions ${[...check.newTech, ...check.newNumbers].join(', ')}, not in your profile`;
      }
      // Written answers are always worth a read before submitting.
      answers.set(f.key, { ...base(f), value: c.value, source: 'llm', needsReview: essay, note });
    }
  }

  return fields.map((f) => {
    const a = answers.get(f.key) ?? { ...base(f), source: '' };
    const empty =
      a.value === '' ||
      (Array.isArray(a.value) && !a.value.length) ||
      (f.kind === 'checkbox' && a.value === false && a.required);
    return { ...a, needsInput: a.required && empty };
  });
}
