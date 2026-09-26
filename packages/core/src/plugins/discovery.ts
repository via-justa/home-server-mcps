import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isSdkCompatible, parseManifest, SDK_VERSION } from '@home-server-mcps/plugin-sdk';
import type { Manifest } from '@home-server-mcps/plugin-sdk';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { plugins } from '../db/schema.js';

/** Plugin discovery (design §4.1): core plugins from the image, installed ones from `DATA_DIR/plugins`. */

export type PluginSource = 'core' | 'repo';

export type DiscoveredPlugin =
  | { status: 'ok'; source: PluginSource; dir: string; manifest: Manifest }
  | {
      status: 'invalid' | 'incompatible';
      source: PluginSource;
      dir: string;
      manifest?: Manifest;
      pluginId: string;
      error: string;
    };

function explain(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return err instanceof Error ? err.message : String(err);
}

export function inspectPluginDir(dir: string, source: PluginSource): DiscoveredPlugin {
  const fallbackId = path.basename(dir);
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
  } catch (err) {
    return { status: 'invalid', source, dir, pluginId: fallbackId, error: `manifest.json: ${explain(err)}` };
  }
  const entry = path.join(dir, manifest.entry);
  if (!existsSync(entry)) {
    return {
      status: 'invalid',
      source,
      dir,
      manifest,
      pluginId: manifest.id,
      error: `entry ${manifest.entry} not found (not built?)`,
    };
  }
  // The child may only read its own directory (design §4.4), so the entry must not escape it via symlinks.
  const realDir = realpathSync(dir);
  if (!realpathSync(entry).startsWith(realDir + path.sep)) {
    return {
      status: 'invalid',
      source,
      dir,
      manifest,
      pluginId: manifest.id,
      error: 'entry resolves outside the plugin directory',
    };
  }
  if (!isSdkCompatible(manifest)) {
    return {
      status: 'incompatible',
      source,
      dir,
      manifest,
      pluginId: manifest.id,
      error: `requires plugin SDK ${manifest.sdk}; core implements ${SDK_VERSION}`,
    };
  }
  return { status: 'ok', source, dir, manifest };
}

/** Scans each root's immediate subdirectories that contain a manifest.json. */
export function discoverPlugins(roots: { dir: string; source: PluginSource }[]): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const name of readdirSync(root.dir).sort()) {
      const dir = path.join(root.dir, name);
      if (statSync(dir).isDirectory() && existsSync(path.join(dir, 'manifest.json'))) {
        found.push(inspectPluginDir(dir, root.source));
      }
    }
  }
  return found;
}

export const pluginIdOf = (p: DiscoveredPlugin) => (p.status === 'ok' ? p.manifest.id : p.pluginId);

/**
 * Upserts discovery results into `plugins`. New core plugins start disabled unless `autoEnableCore`.
 * A repository plugin may not shadow a core plugin id; a core plugin that arrives later with a repo
 * plugin's id doesn't take its row over either (that row is marked invalid until an admin resolves it). Plugins no longer on disk are marked invalid,
 * never deleted, so their instances and history remain.
 */
export function syncPluginRegistry(
  db: Db,
  discovered: DiscoveredPlugin[],
  opts: { autoEnableCore: boolean; now?: Date },
): { added: string[]; updated: string[]; missing: string[]; rejected: string[] } {
  const now = opts.now ?? new Date();
  const out = { added: [] as string[], updated: [] as string[], missing: [] as string[], rejected: [] as string[] };
  const coreIds = new Set(discovered.filter((p) => p.source === 'core').map(pluginIdOf));

  db.transaction((tx) => {
    const existing = new Map(
      tx
        .select()
        .from(plugins)
        .all()
        .map((p) => [p.pluginId, p]),
    );
    const seen = new Set<string>();
    for (const p of discovered) {
      const pluginId = pluginIdOf(p);
      if (p.source === 'repo' && coreIds.has(pluginId)) {
        out.rejected.push(pluginId);
        continue;
      }
      if (seen.has(pluginId)) {
        out.rejected.push(pluginId);
        continue;
      }
      seen.add(pluginId);
      const fields = {
        version: p.manifest?.version ?? '0.0.0',
        source: p.source,
        path: p.dir,
        manifest: p.manifest ?? {},
        status: p.status,
        statusError: p.status === 'ok' ? null : p.error,
      };
      const prev = existing.get(pluginId);
      if (prev?.source === 'repo' && p.source === 'core') {
        // A core release now ships this id. Its instances must not silently switch to different code
        // with the same secrets: the repo row stays as it was, unusable, until an admin resolves it.
        const statusError = `A core plugin now uses the id "${pluginId}". Uninstall this repository plugin (after moving its endpoints) to use the core one.`;
        if (prev.status !== 'invalid' || prev.statusError !== statusError) {
          tx.update(plugins).set({ status: 'invalid', statusError }).where(eq(plugins.id, prev.id)).run();
          writeAudit(
            tx,
            {
              kind: 'plugin',
              decision: 'plugin_id_conflict',
              actorKind: 'system',
              detail: { pluginId, repoVersion: prev.version, coreVersion: fields.version },
            },
            now,
          );
        }
        out.rejected.push(pluginId);
        continue;
      }
      if (!prev) {
        const enabled = p.status === 'ok' && p.source === 'core' && opts.autoEnableCore;
        tx.insert(plugins)
          .values({ id: randomUUID(), pluginId, ...fields, enabled, installedAt: now })
          .run();
        out.added.push(pluginId);
        writeAudit(
          tx,
          {
            kind: 'plugin',
            decision: 'plugin_discovered',
            actorKind: 'system',
            detail: { pluginId, ...fields, manifest: undefined, enabled },
          },
          now,
        );
      } else {
        tx.update(plugins).set(fields).where(eq(plugins.id, prev.id)).run();
        out.updated.push(pluginId);
      }
    }
    for (const prev of existing.values()) {
      if (!seen.has(prev.pluginId) && prev.status !== 'invalid') {
        tx.update(plugins)
          .set({ status: 'invalid', statusError: 'plugin directory not found' })
          .where(eq(plugins.id, prev.id))
          .run();
        out.missing.push(prev.pluginId);
      }
    }
  });
  return out;
}
