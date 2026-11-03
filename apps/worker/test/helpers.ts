import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv, logger, ProfileSchema, type Profile, type TargetCompany } from '@ja/shared';
import type { HttpClient } from '../src/http.js';
import type { SourceContext } from '../src/sources/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
export const jsonFixture = <T = unknown>(name: string) => JSON.parse(fixture(name)) as T;

/** Fixed profile so tests don't depend on the user's real data/profile.yaml. */
export const testProfile: Profile = ProfileSchema.parse({
  personal: { name: 'Test User', email: 'test@example.com', location: 'Bengaluru' },
  totalExperienceYears: 1,
  skills: {
    languages: ['JavaScript', 'TypeScript'],
    frontend: ['React', 'Vite'],
    backend: ['Node.js', 'Express', 'REST APIs', 'JWT'],
    databases: ['MongoDB'],
    devops: ['GitHub Actions', 'Nginx', 'PM2'],
  },
  experience: [
    {
      id: 'exp1',
      company: 'Acme',
      title: 'MERN Stack Developer',
      start: '2025-12',
      end: 'present',
      bullets: [
        {
          id: 'b1',
          text: 'Built REST APIs with Express and MongoDB',
          skills: ['Express', 'MongoDB'],
        },
      ],
    },
  ],
  preferences: {
    roles: ['MERN Stack Developer', 'Full Stack Developer', 'Backend Developer Node.js'],
    locations: ['Bengaluru', 'Pune', 'Noida', 'Gurugram', 'Hyderabad'],
    countries: ['IN'],
    acceptGlobalRemote: true,
    maxExperienceYears: 3,
    graduationYear: 2025,
    excludeCompanies: ['Bad Corp Pvt Ltd'],
    excludeKeywords: ['Java', '.NET', 'PHP', 'QA'],
  },
});

/** HttpClient that serves canned responses by URL substring. */
export function fakeHttp(routes: Record<string, unknown>): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getJson<T>(url: string): Promise<T> {
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) throw new Error(`no fake route for ${url}`);
      const value = routes[key];
      if (value instanceof Error) throw value;
      return value as T;
    },
  };
}

export function testCtx(
  http: HttpClient,
  targets: TargetCompany[] = [],
  envOverrides: Partial<ReturnType<typeof getEnv>> = {},
): SourceContext {
  return { http, env: { ...getEnv(), ...envOverrides }, profile: testProfile, targets, logger };
}
