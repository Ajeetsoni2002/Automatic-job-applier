import type { ApplicationAnswerDto, FieldKind } from '@ja/shared';

/** One form control (or radio/checkbox/button group) as read from an application page. */
export interface FormField {
  /** Stable id: element id, input name, or Greenhouse question field name. */
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
  /** CSS selector for the control (for groups: any member, with `name` for the rest). */
  selector: string;
  /** For radio/checkbox groups: the shared input name. */
  name?: string;
  /** A date box that opens a calendar (often read-only): typed into after unlocking it. */
  picker?: boolean;
  /** An upload done by clicking a button that opens the file picker. */
  upload?: 'chooser';
  /** The site has a separate country-code control and requests a national phone number. */
  nationalPhone?: boolean;
  /** Options may be virtualized or loaded by a search inside the dropdown panel. */
  searchable?: boolean;
  /** Heading of the section holding the field ("X/SSLC/Junior/Equivalent", "Graduation"). */
  section?: string;
}

export type AnswerValue = string | string[] | boolean;

export type Answer = ApplicationAnswerDto;

export interface FillFiles {
  resumePdf?: string;
  coverLetterPdf?: string;
  coverLetterText?: string;
}
