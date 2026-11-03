import type { SourceName } from '@ja/shared';
import { adzunaSource } from './adzuna.js';
import { ashbySource, greenhouseSource, leverSource } from './ats.js';
import { gmailSource } from './gmail.js';
import { naukriSource } from './naukri.js';
import { remotiveSource } from './remotive.js';
import type { JobSource } from './types.js';

export const SOURCES: Record<SourceName, JobSource> = {
  adzuna: adzunaSource,
  remotive: remotiveSource,
  greenhouse: greenhouseSource,
  lever: leverSource,
  ashby: ashbySource,
  gmail: gmailSource,
  naukri: naukriSource,
};

export type { JobSource, RawJob, SourceContext, SourceResult } from './types.js';
