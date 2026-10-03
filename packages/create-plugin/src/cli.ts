#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildPlugin } from './build.js';
import { checkPlugin } from './check.js';
import { askPluginOptions, PLUGIN_FLAGS, prompts } from './prompts.js';
import { createRepoTool } from './repo.js';
import { findRepoRoot } from './repo-root.js';
import { install, newPlugin } from './scaffold.js';

const USAGE = `synoikia-plugin <command>

  new                       Add a plugin to this repository (asks for what flags don't give)
      --id <id> --name <name> --namespace <ns> --description <text>
      --archetype openapi-rest|static-rest|websocket-rpc|blank
      --auth bearer|api-key|basic|none [--api-key-header X-Api-Key]
      --yes (no prompts) --skip-install
  build [dir]               Bundle a plugin into dist/index.js (plugin.yaml and guides inlined)
      --conditions a,b      Extra export conditions
  check [dir...]            Check manifests, plugin.yaml and versions (default: this plugin, or all)
  repo pack|index|verify|publish
                            Build the signed plugin repository (release workflow steps)
      --repository owner/name --out .repo --current .repo-current/index.json
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'new': {
      const { values } = parseArgs({ args: rest, options: PLUGIN_FLAGS });
      const root = findRepoRoot();
      const opts = await askPluginOptions(root, values);
      const files = newPlugin(opts);
      prompts.log.success(`Created plugins/${opts.id} (${files.length} files)`);
      if (!values['skip-install']) install(root);
      prompts.outro(
        `Next: describe ${opts.name}'s operations in plugins/${opts.id}/plugin.yaml, then run pnpm --filter ./plugins/${opts.id} test`,
      );
      return 0;
    }
    case 'build': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { conditions: { type: 'string' } },
      });
      const dir = path.resolve(positionals[0] ?? '.');
      await buildPlugin({ dir, conditions: values.conditions?.split(',').filter(Boolean) });
      return 0;
    }
    case 'check': {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      let dirs = positionals.map((d) => path.resolve(d));
      if (!dirs.length) {
        if (existsSync('manifest.json')) dirs = [process.cwd()];
        else {
          const plugins = path.join(findRepoRoot(), 'plugins');
          dirs = readdirSync(plugins)
            .map((d) => path.join(plugins, d))
            .filter((d) => existsSync(path.join(d, 'manifest.json')));
        }
      }
      let failed = false;
      for (const dir of dirs) {
        const issues = checkPlugin(dir);
        for (const issue of issues) console.error(`${path.basename(dir)}: ${issue}`);
        failed ||= issues.length > 0;
      }
      if (!failed) console.log(`checked ${dirs.length} plugin(s)`);
      return failed ? 1 : 0;
    }
    case 'repo': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { repository: { type: 'string' }, out: { type: 'string' }, current: { type: 'string' } },
      });
      const tool = createRepoTool({ root: findRepoRoot(), ...values });
      const step = positionals[0];
      if (step === 'pack') tool.pack();
      else if (step === 'index') tool.index();
      else if (step === 'verify') await tool.verify();
      else if (step === 'publish') tool.publish();
      else {
        console.error(USAGE);
        return 2;
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return command === undefined || command === '--help' || command === 'help' ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
