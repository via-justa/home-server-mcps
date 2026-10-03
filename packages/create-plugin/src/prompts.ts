import * as p from '@clack/prompts';
import {
  ARCHETYPES,
  AUTH_KINDS,
  camelCase,
  validateDescription,
  validateId,
  validateName,
  validateNamespace,
} from './scaffold.js';
import type { Archetype, AuthKind, NewPluginOptions } from './scaffold.js';

/** Flags shared by `create-plugin` and `synoikia-plugin new`. */
export const PLUGIN_FLAGS = {
  id: { type: 'string' },
  name: { type: 'string' },
  namespace: { type: 'string' },
  description: { type: 'string' },
  archetype: { type: 'string' },
  auth: { type: 'string' },
  'api-key-header': { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'skip-install': { type: 'boolean' },
} as const;

export interface PluginFlags {
  id?: string;
  name?: string;
  namespace?: string;
  description?: string;
  archetype?: string;
  auth?: string;
  'api-key-header'?: string;
  yes?: boolean;
}

const interactive = (flags: { yes?: boolean }) => !flags.yes && process.stdin.isTTY === true;

function done<T>(value: T): Exclude<T, symbol> {
  if (typeof value === 'symbol') {
    p.cancel('Cancelled');
    process.exit(1);
  }
  return value as Exclude<T, symbol>;
}

const titleCase = (id: string) =>
  id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** Fills in plugin options from flags, asking for what's missing when run in a terminal. */
export async function askPluginOptions(root: string, flags: PluginFlags): Promise<NewPluginOptions> {
  const ask = interactive(flags);
  const need = (what: string) => {
    throw new Error(`--${what} is required when not running interactively`);
  };
  const check = (problem: string | undefined) => {
    if (problem) throw new Error(problem);
  };

  let id = flags.id;
  if (id === undefined) {
    if (!ask) need('id');
    id = done(
      await p.text({
        message: 'Plugin id (lowercase, the directory name)',
        placeholder: 'acme',
        validate: (v) => validateId(v ?? '', root),
      }),
    );
  }
  check(validateId(id!, root));

  let name = flags.name;
  if (name === undefined) {
    name = ask
      ? done(
          await p.text({
            message: 'Display name',
            initialValue: titleCase(id!),
            validate: (v) => (v ? undefined : 'Required'),
          }),
        )
      : titleCase(id!);
  }

  check(validateName(name!));
  if (flags.description !== undefined) check(validateDescription(flags.description));

  let namespace = flags.namespace;
  if (namespace === undefined) {
    namespace = ask
      ? done(
          await p.text({
            message: 'Sandbox namespace (what code calls: <namespace>.call(...))',
            initialValue: camelCase(id!),
            validate: (v) => validateNamespace(v ?? ''),
          }),
        )
      : camelCase(id!);
  }
  const nsProblem = validateNamespace(namespace!);
  if (nsProblem) throw new Error(`Namespace "${namespace}": ${nsProblem} (pass --namespace)`);

  let archetype = flags.archetype as Archetype | undefined;
  if (archetype === undefined) {
    if (!ask) need('archetype');
    archetype = done(
      await p.select({
        message: 'What kind of upstream API?',
        options: Object.entries(ARCHETYPES).map(([value, hint]) => ({ value: value as Archetype, label: value, hint })),
      }),
    );
  }
  if (!(archetype! in ARCHETYPES)) throw new Error(`--archetype must be one of ${Object.keys(ARCHETYPES).join(', ')}`);

  let auth = flags.auth as AuthKind | undefined;
  if (auth === undefined) {
    if (!ask) need('auth');
    auth = done(
      await p.select({
        message: 'How does it authenticate?',
        options: Object.entries(AUTH_KINDS).map(([value, hint]) => ({ value: value as AuthKind, label: value, hint })),
      }),
    );
  }
  if (!(auth! in AUTH_KINDS)) throw new Error(`--auth must be one of ${Object.keys(AUTH_KINDS).join(', ')}`);

  let apiKeyHeader = flags['api-key-header'];
  if (auth === 'api-key' && apiKeyHeader === undefined && ask) {
    apiKeyHeader = done(await p.text({ message: 'API key header', initialValue: 'X-Api-Key' }));
  }

  return {
    root,
    id: id!,
    name: name!,
    namespace: namespace!,
    ...(flags.description ? { description: flags.description } : {}),
    archetype: archetype!,
    auth: auth!,
    ...(apiKeyHeader ? { apiKeyHeader } : {}),
  };
}

export { p as prompts };
