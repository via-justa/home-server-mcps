import { randomUUID } from 'node:crypto';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { pluginInstances, plugins } from '../src/db/schema.js';

export function seedInstance(db: Db = openDatabase(':memory:'), slug = 'truenas') {
  const pluginRowId = randomUUID();
  db.insert(plugins)
    .values({
      id: pluginRowId,
      pluginId: `p-${slug}`,
      version: '0.1.0',
      source: 'core',
      path: '/tmp',
      manifest: {},
      status: 'ok',
      enabled: true,
    })
    .run();
  const instanceId = randomUUID();
  db.insert(pluginInstances).values({ id: instanceId, pluginId: pluginRowId, slug, displayName: slug }).run();
  return { db, instanceId };
}

export const op = (key: string, extra: Partial<OperationDescriptor> = {}): OperationDescriptor => {
  const isRead = /\.(query|get_instance|config)$/.test(key);
  return {
    key,
    kind: 'method',
    group: key.split('.').slice(0, -1).join('.') || key,
    classification: isRead ? 'read' : 'write',
    classificationReason: isRead ? 'naming:read' : 'naming:write',
    ...extra,
  };
};

export const catalog = (...operations: OperationDescriptor[]) => ({ upstreamVersion: '25.10.7', operations });
