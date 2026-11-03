import { describe, expect, it } from 'vitest';
import { educationLevelOf, ProfileSchema, savedAnswerKeys } from '@ja/shared';
import { educationAnswer } from './education.js';
import { dateShown, parseMonthYear } from './fill.js';
import { bestOption, expandAbbreviations, searchQueries } from './match.js';
import type { FormField } from './types.js';

const profile = ProfileSchema.parse({
  personal: { name: 'Test Candidate', email: 'a@example.com', location: 'Pune, India', links: {} },
  totalExperienceYears: 1,
  skills: {},
  experience: [],
  education: [
    {
      institution: 'University Institute of Technology, Sample University, Indore',
      degree: 'B.Tech',
      field: 'Computer Science and Engineering',
      state: 'Madhya Pradesh',
      start: '2021',
      end: '2025',
      grade: 'CGPA 8.1',
    },
    {
      institution: 'Example H. S. School, Singrauli (M.P.)',
      degree: 'Class 12th (MP Board)',
      start: '2018',
      end: '2019-05',
      grade: '81.4%',
    },
    {
      institution: 'Example H. S. School, Singrauli (M.P.)',
      degree: 'Class 10th (MP Board)',
      start: '2016',
      end: '2017',
      grade: '88.2%',
    },
  ],
  preferences: { roles: ['Developer'] },
});

const field = (over: Partial<FormField>): FormField => ({
  key: 'k',
  label: 'L',
  kind: 'text',
  required: true,
  selector: '#k',
  ...over,
});

describe('education levels', () => {
  it.each([
    ['X/SSLC/Junior/Equivalent', 'secondary'],
    ['Class 10th (MP Board)', 'secondary'],
    ['XII Standard', 'higher_secondary'],
    ['Class 12th (MP Board)', 'higher_secondary'],
    ['Higher Secondary School Certificate', 'higher_secondary'],
    ['Graduation', 'undergraduate'],
    ['Post Graduation (optional)', 'postgraduate'],
    ['Diploma', 'diploma'],
    ['Personal Details', undefined],
    ['Year 2010 onwards', undefined],
  ])('%s → %s', (text, level) => {
    expect(educationLevelOf(text)).toBe(level);
  });

  it('keeps remembered answers of education sections apart', () => {
    expect(savedAnswerKeys('Board', 'XII Standard')).toEqual(['xii standard board']);
    expect(savedAnswerKeys('Date of Birth', 'Personal Details')).toEqual([
      'personal details date birth',
      'date birth',
    ]);
    expect(savedAnswerKeys('Date of Birth')).toEqual(['date birth']);
  });
});

describe('educationAnswer', () => {
  it('answers X, XII and graduation questions from their own entries', () => {
    const x = (label: string, over: Partial<FormField> = {}) =>
      educationAnswer(field({ label, section: 'X/SSLC/Junior/Equivalent', ...over }), profile);
    const xii = (label: string, over: Partial<FormField> = {}) =>
      educationAnswer(field({ label, section: 'XII Standard', ...over }), profile);
    const ug = (label: string, over: Partial<FormField> = {}) =>
      educationAnswer(field({ label, section: 'Graduation', ...over }), profile);

    expect(x('Board', { kind: 'combobox', searchable: true })?.value).toBe('MP Board');
    expect(x('Simple Average percentage/CGPA/Grade for all semesters/years')?.value).toBe('88.2');
    expect(xii('Simple Average percentage/CGPA/Grade for all semesters/years')?.value).toBe('81.4');
    expect(ug('Simple Average percentage/CGPA/Grade for all semesters/years')?.value).toBe('8.1');
    expect(
      x('Degree', { kind: 'buttons', options: ['Secondary School Leaving Cert.', 'Others'] })
        ?.value,
    ).toBe('Secondary School Leaving Cert.');
    expect(
      xii('Degree', {
        kind: 'buttons',
        options: ['Pre-University Course', 'Higher Secondary School Certificate', 'Others'],
      })?.value,
    ).toBe('Higher Secondary School Certificate');
    expect(ug('Degree', { kind: 'combobox', searchable: true, options: [] })?.value).toBe(
      'Bachelor of Technology',
    );
    expect(ug('University', { kind: 'combobox', searchable: true })?.value).toBe(
      'Sample University',
    );
    expect(ug('Branch/Stream/Area of Specialization')?.value).toBe(
      'Computer Science and Engineering',
    );
    expect(ug('State')?.value).toBe('Madhya Pradesh');
    expect(ug('Country')?.value).toBe('India');
  });

  it('asks for a passing month the profile does not have, and uses one it has', () => {
    const date = { kind: 'date' as const, picker: true };
    expect(
      educationAnswer(field({ label: 'Passing month and year', section: 'Graduation', ...date }), profile),
    ).toBeNull();
    expect(
      educationAnswer(field({ label: 'Passing month and year', section: 'XII Standard', ...date }), profile)
        ?.value,
    ).toBe('2019-05');
    expect(
      educationAnswer(field({ label: 'Year of passing', section: 'Graduation' }), profile)?.value,
    ).toBe('2025');
  });

  it('leaves a section the profile has nothing for empty instead of reusing graduation', () => {
    const a = educationAnswer(
      field({ label: 'University (optional)', section: 'Post Graduation (optional)', required: false }),
      profile,
    );
    expect(a).toMatchObject({ value: '' });
  });

  it('does not answer a X stream the profile lacks, and leaves the residence address alone', () => {
    expect(educationAnswer(field({ label: 'Specialization', section: 'X/SSLC/Junior/Equivalent' }), profile)).toBeNull();
    expect(educationAnswer(field({ label: 'State' }), profile)).toBeUndefined();
    expect(educationAnswer(field({ label: 'City', section: 'Personal Details' }), profile)).toBeUndefined();
  });

  it('chooses the levels held when a question offers XII or Diploma', () => {
    const f = field({
      label: 'Please provide either Class XII or Diploma details.',
      kind: 'checkboxes',
      options: ['XII Standard', 'Diploma'],
    });
    expect(educationAnswer(f, profile)?.value).toEqual(['XII Standard']);
  });

  it('ignores numbers and long questions that are not about education', () => {
    expect(
      educationAnswer(
        field({ label: 'Notice period (months)', kind: 'select', options: ['10', '12'] }),
        profile,
      ),
    ).toBeUndefined();
    expect(
      educationAnswer(field({ label: 'Are you willing to work 12 hour shifts from the office?' }), profile),
    ).toBeUndefined();
  });

  it('answers clear highest-qualification questions without a section', () => {
    expect(educationAnswer(field({ label: 'CGPA' }), profile)?.value).toBe('8.1');
    expect(educationAnswer(field({ label: 'Year of passing' }), profile)?.value).toBe('2025');
    expect(educationAnswer(field({ label: 'College name' }), profile)?.value).toBe(
      'University Institute of Technology, Sample University, Indore',
    );
  });
});

describe('option matching', () => {
  it.each([
    ['University Institute of Technology, Sample University, Indore', ['University Institute Of Technology', 'University Institute Of Technology, Sample University', 'University Institute Of Technology, Rgpv'], 'University Institute Of Technology, Sample University'],
    ['Computer Science and Engineering', ['Computer Science', 'Computer Science Engineering', 'Computer Science & Technology'], 'Computer Science Engineering'],
    ['MP Board', ['Madhya Pradesh Board', 'Madhya Pradesh Board Of Secondary Education'], 'Madhya Pradesh Board'],
    ['B.Tech', ['Bachelor of Technology', 'Bachelor of Engineering'], 'Bachelor of Technology'],
    ['MALE', ['MALE', 'FEMALE'], 'MALE'],
  ])('%s → %s', (wanted, options, expected) => {
    expect(bestOption(wanted, options)).toBe(expected);
  });

  it.each([
    ['Bachelor of Technology', ['Bachelor of Technology (Honours)']],
    ['Computer Science and Engineering', ['Computer Science', 'Computer Science & Technology']],
    ['FEMALE', ['MALE']],
  ])('does not pick a different option for %s', (wanted, options) => {
    expect(bestOption(wanted, options)).toBeUndefined();
  });

  it('writes out abbreviations and searches with narrower queries', () => {
    expect(expandAbbreviations('MP Board')).toBe('Madhya Pradesh Board');
    expect(expandAbbreviations('B.Tech')).toBe('Bachelor of Technology');
    expect(searchQueries('Computer Science and Engineering')).toEqual([
      'Computer Science and Engineering',
      'Computer Science Engineering',
      'Computer Science',
      'computer',
    ]);
    expect(searchQueries('MP Board').slice(0, 2)).toEqual(['MP Board', 'Madhya Pradesh Board']);
  });
});

describe('month-year dates', () => {
  it('parses month and year answers', () => {
    expect(parseMonthYear('2025-06')).toEqual({ y: 2025, m: 6 });
    expect(parseMonthYear('06/2025')).toEqual({ y: 2025, m: 6 });
    expect(parseMonthYear('June 2025')).toEqual({ y: 2025, m: 6 });
    expect(parseMonthYear('13/2025')).toBeNull();
  });

  it('rejects a month-year box that misread a day-first date', () => {
    expect(dateShown('01/2006', { y: 2019, m: 6, d: 1 })).toBe(false);
    expect(dateShown('01/2026', { y: 2019, m: 6 })).toBe(false);
    expect(dateShown('06/2019', { y: 2019, m: 6, d: 1 })).toBe(true);
    expect(dateShown('12/11/2002', { y: 2002, m: 11, d: 12 })).toBe(true);
    expect(dateShown('11/12/2002', { y: 2002, m: 11, d: 12 })).toBe(true);
  });
});
