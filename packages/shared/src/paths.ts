import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Monorepo root (packages/shared/src -> ../../..). */
export const ROOT_DIR = path.resolve(here, '../../..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');

/** Directory for tokens and browser profiles. Lives outside the repo on purpose. */
export function appHome(): string {
  const fromEnv = process.env.APP_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.job-autopilot');
}
