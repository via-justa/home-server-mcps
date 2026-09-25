import { readFileSync } from 'node:fs';

/** The core's own version, from package.json (src/ and dist/ both sit one level below it). */
export const CORE_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
