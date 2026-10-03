// Writes plugin-settings.schema.json, the JSON Schema of plugin.yaml, next to the build output so
// editors can validate and complete plugin.yaml (`# yaml-language-server: $schema=…`).
import { writeFileSync } from 'node:fs';
import { pluginSettingsJsonSchema } from '../dist/index.js';

writeFileSync(
  new URL('../plugin-settings.schema.json', import.meta.url),
  `${JSON.stringify(pluginSettingsJsonSchema(), null, 2)}\n`,
);
