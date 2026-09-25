/** Admin API response shapes (design §8.4), mirrored from packages/core. */

export type AuthMode = 'external' | 'bearer' | 'oauth' | 'bearer+oauth';
export const AUTH_MODES: AuthMode[] = ['external', 'bearer', 'oauth', 'bearer+oauth'];
export type Level = 'none' | 'read' | 'write';

export interface PublicUser {
  id: string;
  username: string;
  totpEnabled: boolean;
  oidcLinked: boolean;
  hasPassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  authenticated: boolean;
  setupRequired: boolean;
  localLoginEnabled: boolean;
  oidc: { enabled: boolean; label: string };
  user?: PublicUser;
  mustEnrollTotp?: boolean;
}

export interface InstanceSettings {
  approvalTimeoutMs: number;
  allowPortalOnlyApprovals: boolean;
  executePerMinute: number;
  writesPerMinute: number;
  sandbox: { timeoutMs: number; memoryMb: number; maxResultBytes: number };
  extraRedactKeys: string[];
  syncMaxAgeMs: number;
  memoryMb: number;
}

export interface Instance {
  id: string;
  slug: string;
  displayName: string;
  enabled: boolean;
  authMode: AuthMode | null;
  status: 'starting' | 'ready' | 'error' | 'stopped';
  statusError: string | null;
  upstreamVersion: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  settings: InstanceSettings;
  plugin: {
    id: string;
    pluginId: string;
    name: string;
    enabled: boolean;
    status: string;
    labels?: { operation: string; operations: string };
  };
  endpointUrl?: string;
  effectiveAuthMode?: AuthMode;
  pendingApprovals?: number;
}

export interface Overview {
  instances: Instance[];
  plugins: { id: string; pluginId: string; status: string; enabled: boolean }[];
  pendingApprovals: number;
  warnings: string[];
  publicMcpUrl: string | null;
}

export interface UiHint {
  widget?: string;
  help?: string;
  placeholder?: string;
  optionsSource?: string;
  showWhen?: { field: string; in: (string | number | boolean)[] };
}

export interface JsonSchemaProp {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  items?: { enum?: unknown[]; type?: string };
}

export interface ConnectionSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

export interface Connection {
  config: Record<string, unknown>;
  secrets: Record<string, { set: boolean; hint?: string }>;
  schema: ConnectionSchema;
  ui: Record<string, UiHint>;
  help?: string;
}

export interface MatchField {
  field: string;
  label: string;
  op?: 'eq' | 'in' | 'prefix' | 'range' | 'bool';
  widget: string;
  options?: Record<string, unknown>;
  optionsSource?: string;
}

export interface PluginRow {
  id: string;
  pluginId: string;
  version: string;
  source: 'core' | 'repo';
  repoId: string | null;
  sha256: string | null;
  signatureVerified: boolean;
  status: 'ok' | 'invalid' | 'incompatible';
  statusError: string | null;
  enabled: boolean;
  instances: number;
  manifest: {
    name?: string;
    description?: string;
    matchProfiles?: Record<string, MatchField[]>;
    network?: { hosts: string[] };
    connection?: { schema: ConnectionSchema; ui?: Record<string, UiHint>; help?: string };
    labels?: { operation: string; operations: string };
  };
}

export interface GroupSummary {
  key: string;
  label: string;
  level: Level;
  stale: boolean;
  counts: { read: number; write: number; locked: number; pendingReview: number };
}

export interface BulkPreview {
  level: Level;
  groups: { key: string; label: string; from: Level; exposes: { id: string; key: string }[] }[];
  acknowledge: string[];
}

export interface Operation {
  id: string;
  key: string;
  displayName: string | null;
  kind: string;
  tag: string | null;
  classification: 'read' | 'write';
  classificationSource: string | null;
  inferredClassification: string | null;
  inferredReason: string | null;
  locked: boolean;
  attestationRequired: boolean;
  excluded: boolean;
  lockedOptIn: boolean;
  writeAcknowledged: boolean;
  needsReview: boolean;
  matchProfile: string | null;
  group: string | null;
  reachable: boolean;
  reason: string | null;
}

export type MatchCondition =
  | { field: string; op: 'eq' | 'in' | 'prefix' | 'range' | 'bool'; value: unknown }
  | { field: '$targets'; areas?: string[]; entities?: string[]; domains?: string[] };

export interface Rule {
  id: string;
  operationId: string;
  match: MatchCondition[];
  rateLimit: number | null;
  windowSeconds: number | null;
  expiresAt: string | null;
  reason: string;
  enabled: boolean;
  createdAt: string;
  operation: { id: string; key: string; locked: boolean; matchProfile: string | null };
  inert: string | null;
}

export interface RegistryEntry {
  kind: string;
  id: string;
  name: string | null;
  parentId: string | null;
  domain: string | null;
}

export interface Approval {
  id: string;
  instanceId: string;
  operationId: string;
  paramsDisplay: unknown;
  resolvedTargets: unknown;
  summary: string;
  confirmLiteral: string | null;
  diff: unknown;
  clientKind: string | null;
  clientId: string | null;
  requestedAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'denied' | 'timed_out' | 'cancelled';
  decidedBy: string | null;
  decidedVia: string | null;
  decidedAt: string | null;
  requiresConfirmation: boolean;
  operation: { key: string; classification: string };
  instance: { id: string; slug: string; displayName: string };
}

export interface AuditRow {
  id: number;
  at: string;
  kind: 'call' | 'search' | 'config' | 'auth' | 'plugin';
  instanceId: string | null;
  operationKey: string | null;
  classification: string | null;
  decision: string | null;
  actorKind: string;
  actorId: string | null;
  decidedBy: string | null;
  decidedVia: string | null;
  params: unknown;
  resolvedTargets: unknown;
  resultStatus: string | null;
  durationMs: number | null;
  detail: unknown;
}

export interface Token {
  id: string;
  name: string;
  scope: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface OAuthClient {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  registeredVia: 'dcr' | 'admin';
  createdAt: string;
  revokedAt: string | null;
  confidential: boolean;
}

export interface Grant {
  id: string;
  resources: string[];
  createdAt: string;
  revokedAt: string | null;
  client: { id: string; clientId: string; name: string };
  user: { id: string; username: string };
}

export interface Repo {
  id: string;
  url: string;
  name: string | null;
  signingMode: 'signed' | 'unsigned';
  publicKey: string | null;
  keyId: string | null;
  keyStatus: 'ok' | 'key_changed';
  offeredKey: { publicKey: string; keyId: string } | null;
  pluginCount: number;
  lastFetchedAt: string | null;
  lastFetchError: string | null;
}

export interface AvailablePlugin {
  repoId: string;
  repoName: string | null;
  signingMode: 'signed' | 'unsigned';
  pluginId: string;
  name: string;
  description: string | null;
  versions: { version: string; compatible: boolean }[];
  latest: string | null;
  installed: { version: string; fromThisRepo: boolean; source: string } | null;
  updateAvailable: boolean;
  blocked: string | null;
}

export type NotifyEvent =
  | 'approval.pending'
  | 'approval.decided'
  | 'approval.timed_out'
  | 'instance.error'
  | 'instance.recovered'
  | 'plugin.crashed'
  | 'sync.failed'
  | 'sync.pending_review'
  | 'auth.lockout';

export const NOTIFY_EVENTS: NotifyEvent[] = [
  'approval.pending',
  'approval.decided',
  'approval.timed_out',
  'instance.error',
  'instance.recovered',
  'plugin.crashed',
  'sync.failed',
  'sync.pending_review',
  'auth.lockout',
];

export interface Notifier {
  id: string;
  kind: 'ntfy' | 'webhook';
  name: string;
  config: { server?: string; topic?: string; url?: string };
  secrets: Record<string, { set: boolean }>;
  events: NotifyEvent[];
  instanceFilter: string[] | null;
  enabled: boolean;
  lastSentAt: string | null;
  lastError: string | null;
}

export interface Settings {
  security: {
    requireTotp: boolean;
    disableLocalLogin: boolean;
    sessionIdleMinutes: number;
    sessionAbsoluteHours: number;
  };
  mcp: {
    defaultAuthMode: AuthMode;
    allowDynamicRegistration: boolean;
    cfAccess: { teamDomain: string; aud: string };
    trustedIdentityHeader: string;
    accessTokenTtlMinutes: number;
    refreshTokenTtlDays: number;
  };
  audit: { retentionDays: number | null };
  oidc: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    scopes: string;
    label: string;
    allowPolicy: { emails: string[]; subjects: string[]; group: string; groupsClaim: string };
    autoProvision: boolean;
    clientSecretSet: boolean;
  } | null;
  forceLocalLogin: boolean;
  publicMcpUrl: string | null;
  publicAdminUrl: string | null;
}
