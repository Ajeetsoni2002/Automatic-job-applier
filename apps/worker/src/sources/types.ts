import type { Env, Logger, Profile, SalaryDto, SourceName, TargetCompany } from '@ja/shared';
import type { HttpClient } from '../http.js';

/** A job as returned by a source, before normalization. */
export interface RawJob {
  source: SourceName;
  sourceJobId: string;
  url: string;
  company: string;
  title: string;
  /** Free-text location as the source gives it. */
  location: string;
  /** Source explicitly says remote / hybrid / onsite. */
  workModeHint?: 'remote' | 'hybrid' | 'onsite';
  /** ISO country code when the source only lists one country (e.g. Adzuna's India endpoint). */
  countryHint?: string;
  description: string;
  /** Source only returns a snippet (e.g. Adzuna). */
  descriptionTruncated?: boolean;
  postedAt?: Date;
  salary?: SalaryDto;
}

export interface SourceContext {
  http: HttpClient;
  env: Env;
  profile: Profile;
  targets: TargetCompany[];
  logger: Logger;
}

export interface SourceResult {
  jobs: RawJob[];
  /** Non-fatal problems (e.g. one company slug 404'd). Reported in SourceRun.error. */
  warnings: string[];
  /** Called after the jobs are stored (e.g. to mark emails processed). Skipped on dry runs. */
  onCommitted?: () => Promise<void>;
}

export interface JobSource {
  name: SourceName;
  /** Minimum hours between successful runs (respects source rate guidance). 0 = no limit. */
  minIntervalHours: number;
  /** Returns a reason string when the source can't run (e.g. missing API key). */
  unavailableReason(ctx: SourceContext): string | undefined;
  fetch(ctx: SourceContext): Promise<SourceResult>;
}
