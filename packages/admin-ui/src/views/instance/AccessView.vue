<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, errorText, http, qs } from '../../api';
import ModalDialog from '../../components/ModalDialog.vue';
import { REASON_LABELS } from '../../format';
import { useAppStore } from '../../stores/app';
import type { BulkPreview, GroupSummary, Instance, Level, Operation } from '../../types';

/**
 * Access page (design §5.2.1): one None | Read | Write control per group. Raising a group to Write
 * lists exactly the writes it exposes and acknowledges them; locked operations stay off until
 * individually allowed; new writes from later syncs wait in "pending review".
 */
const props = defineProps<{ instance: Instance }>();
const app = useAppStore();
const base = computed(() => `/api/instances/${props.instance.id}`);
const opLabel = computed(() => props.instance.plugin.labels?.operations ?? 'Operations');

const groups = ref<GroupSummary[]>([]);
const ops = ref<Operation[]>([]);
const expanded = ref<Set<string>>(new Set());
const search = ref('');
const reviewOnly = ref(false);
const error = ref<string>();

async function load() {
  try {
    [groups.value, ops.value] = await Promise.all([
      http.get<GroupSummary[]>(`${base.value}/groups`),
      http.get<Operation[]>(`${base.value}/operations`),
    ]);
  } catch (err) {
    error.value = errorText(err);
  }
}
onMounted(load);

const text = computed(() => search.value.trim().toLowerCase());
/** A write nobody has acknowledged yet: unreachable at any level until reviewed (same rule as the server). */
const isPending = (o: Operation) => o.classification === 'write' && !o.locked && !o.excluded && !o.writeAcknowledged;
const opsOf = (key: string) =>
  ops.value.filter(
    (o) =>
      o.group === key &&
      (!reviewOnly.value || isPending(o) || o.needsReview) &&
      (!text.value ||
        o.key.toLowerCase().includes(text.value) ||
        (o.displayName ?? '').toLowerCase().includes(text.value)),
  );
const visibleGroups = computed(() =>
  groups.value.filter(
    (g) =>
      (!reviewOnly.value || g.counts.pendingReview > 0) &&
      (!text.value ||
        g.key.includes(text.value) ||
        g.label.toLowerCase().includes(text.value) ||
        opsOf(g.key).length > 0),
  ),
);
const totals = computed(() => ({
  pending: groups.value.reduce((n, g) => n + g.counts.pendingReview, 0),
  write: groups.value.filter((g) => g.level === 'write').length,
}));

function toggle(key: string) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

async function act(fn: () => Promise<unknown>) {
  error.value = undefined;
  try {
    await fn();
    await load();
    void app.refresh();
  } catch (err) {
    error.value = errorText(err);
  }
}

// ── single-group level ──

const raising = ref<{ group: GroupSummary; exposes: { id: string; key: string }[]; note?: string }>();

function setLevel(group: GroupSummary, level: Level) {
  if (level === group.level) return;
  if (level !== 'write') {
    void act(() => http.patch(`${base.value}/groups/${encodeURIComponent(group.key)}`, { level }));
    return;
  }
  const exposes = ops.value.filter((o) => o.group === group.key && isPending(o)).map((o) => ({ id: o.id, key: o.key }));
  raising.value = { group, exposes };
}

async function confirmRaise() {
  const r = raising.value;
  if (!r) return;
  try {
    await http.patch(`${base.value}/groups/${encodeURIComponent(r.group.key)}`, {
      level: 'write',
      acknowledge: r.exposes.map((e) => e.id),
    });
    raising.value = undefined;
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'acknowledgement_mismatch') {
      const expected = (err.details as { expected: { id: string; key: string }[] }).expected;
      raising.value = { ...r, exposes: expected, note: 'The list changed since this page loaded. Review it again.' };
    } else {
      raising.value = { ...r, note: errorText(err) };
    }
  }
}

// ── bulk ──

const bulk = ref<{ preview: BulkPreview; confirm: string; note?: string }>();
async function bulkLevel(level: Level) {
  if (level !== 'write') {
    if (!window.confirm(`Set every group on /${props.instance.slug} to ${level === 'none' ? 'None' : 'Read'}?`)) return;
    await act(() => http.post(`${base.value}/groups/bulk-level`, { level }));
    return;
  }
  try {
    const preview = await http.get<BulkPreview>(`${base.value}/groups/bulk-level/preview${qs({ level: 'write' })}`);
    bulk.value = { preview, confirm: '' };
  } catch (err) {
    error.value = errorText(err);
  }
}
async function confirmBulk() {
  const b = bulk.value;
  if (!b) return;
  try {
    await http.post(`${base.value}/groups/bulk-level`, {
      level: 'write',
      confirm: b.confirm,
      acknowledge: b.preview.acknowledge,
    });
    bulk.value = undefined;
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const preview = await http.get<BulkPreview>(`${base.value}/groups/bulk-level/preview${qs({ level: 'write' })}`);
      bulk.value = { preview, confirm: b.confirm, note: `${errorText(err)} The preview was refreshed.` };
    } else bulk.value = { ...b, note: errorText(err) };
  }
}
const bulkExposes = computed(
  () => bulk.value?.preview.groups.filter((g) => g.from !== 'write' || g.exposes.length) ?? [],
);

// ── regroup ──

const merging = ref<{ from: string[]; into: string; label: string; note?: string }>();
async function confirmMerge() {
  const m = merging.value;
  if (!m) return;
  try {
    await http.post(`${base.value}/groups/merge`, {
      from: m.from,
      into: m.into.trim(),
      label: m.label.trim() || undefined,
    });
    merging.value = undefined;
    await load();
  } catch (err) {
    merging.value = { ...m, note: errorText(err) };
  }
}
function rename(g: GroupSummary) {
  const label = window.prompt(`Label for ${g.key}`, g.label);
  if (label && label.trim() && label !== g.label) {
    void act(() => http.patch(`${base.value}/groups/${encodeURIComponent(g.key)}`, { label: label.trim() }));
  }
}

// ── per-operation ──

const patchOp = (op: Operation, body: Record<string, unknown>) =>
  act(() => http.patch(`${base.value}/operations/${op.id}`, body));

function allowLocked(op: Operation) {
  if (
    window.confirm(
      `${op.key} is locked (destructive or irreversible). Allowing it makes it callable, always with a typed confirmation, and it can never be pre-approved. Allow it?`,
    )
  ) {
    void patchOp(op, { lockedOptIn: true });
  }
}
const kindLabel = (op: Operation) => (op.locked ? 'locked' : op.classification);
</script>

<template>
  <div class="stack">
    <div class="row toolbar">
      <input
        v-model="search"
        class="search grow"
        :placeholder="`Search groups and ${opLabel.toLowerCase()}`"
        aria-label="Search"
      />
      <label class="row small check"><input v-model="reviewOnly" type="checkbox" /> Pending review only</label>
      <span class="grow" />
      <button class="btn btn-sm" type="button" @click="bulkLevel('none')">All → None</button>
      <button class="btn btn-sm" type="button" @click="bulkLevel('read')">All → Read</button>
      <button class="btn btn-sm btn-danger" type="button" @click="bulkLevel('write')">All → Write…</button>
      <button class="btn btn-sm" type="button" @click="merging = { from: [], into: '', label: '' }">Regroup…</button>
    </div>
    <p v-if="totals.pending" class="alert warn">
      {{ totals.pending }} new write {{ totals.pending === 1 ? 'operation waits' : 'operations wait' }} for review. They
      stay unreachable until acknowledged, even in groups at Write.
    </p>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <div class="table-card">
      <div v-for="g in visibleGroups" :key="g.key" class="group" :data-group="g.key">
        <div class="group-row">
          <button class="caret" type="button" :aria-expanded="expanded.has(g.key)" @click="toggle(g.key)">
            {{ expanded.has(g.key) ? '▾' : '▸' }}
          </button>
          <div class="grow name" @click="toggle(g.key)">
            <strong>{{ g.label }}</strong>
            <span v-if="g.label !== g.key" class="mono small muted key">{{ g.key }}</span>
            <span v-if="g.stale" class="pill">stale</span>
            <div class="small muted">
              {{ g.counts.read }} read · {{ g.counts.write }} write · {{ g.counts.locked }} locked
              <span v-if="g.counts.pendingReview" class="pill warn">{{ g.counts.pendingReview }} pending review</span>
            </div>
          </div>
          <button class="btn-link small" type="button" @click="rename(g)">Rename</button>
          <div class="segmented" role="radiogroup" :aria-label="`Access for ${g.label}`">
            <button
              v-for="l in ['none', 'read', 'write'] as Level[]"
              :key="l"
              type="button"
              role="radio"
              :aria-checked="g.level === l"
              :class="{ on: g.level === l, write: l === 'write' }"
              @click="setLevel(g, l)"
            >
              {{ l[0]!.toUpperCase() + l.slice(1) }}
            </button>
          </div>
        </div>

        <table v-if="expanded.has(g.key)" class="table ops">
          <tbody>
            <tr v-for="op in opsOf(g.key)" :key="op.id" :data-op="op.key">
              <td>
                <span class="mono">{{ op.key }}</span>
                <div v-if="op.displayName" class="small muted">{{ op.displayName }}</div>
                <div v-if="op.inferredReason" class="small muted">{{ op.inferredReason }}</div>
              </td>
              <td>
                <span class="pill" :class="{ danger: op.locked, warn: !op.locked && op.classification === 'write' }">
                  {{ kindLabel(op) }}
                </span>
                <span v-if="op.classificationSource === 'override'" class="small muted"> (override)</span>
              </td>
              <td>
                <span v-if="op.reachable" class="pill ok">callable</span>
                <span v-else class="pill" :class="{ warn: op.reason === 'pending_review' }">
                  {{ REASON_LABELS[op.reason ?? ''] ?? op.reason }}
                </span>
              </td>
              <td class="right">
                <div class="controls">
                  <button
                    v-if="isPending(op)"
                    class="btn btn-sm btn-primary"
                    type="button"
                    @click="patchOp(op, { acknowledged: true })"
                  >
                    Acknowledge
                  </button>
                  <template v-if="op.locked">
                    <button
                      v-if="!op.lockedOptIn && g.level === 'write'"
                      class="btn btn-sm btn-danger"
                      type="button"
                      @click="allowLocked(op)"
                    >
                      Allow…
                    </button>
                    <button
                      v-else-if="op.lockedOptIn"
                      class="btn btn-sm"
                      type="button"
                      @click="patchOp(op, { lockedOptIn: false })"
                    >
                      Revoke
                    </button>
                  </template>
                  <select
                    v-else
                    class="cls"
                    :value="op.classification"
                    :aria-label="`Classification of ${op.key}`"
                    @change="patchOp(op, { classification: ($event.target as HTMLSelectElement).value })"
                  >
                    <option value="read">read</option>
                    <option value="write">write</option>
                  </select>
                  <label class="small check">
                    <input
                      type="checkbox"
                      :checked="op.excluded"
                      @change="patchOp(op, { excluded: ($event.target as HTMLInputElement).checked })"
                    />
                    Exclude
                  </label>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="expanded.has(g.key) && !opsOf(g.key).length" class="empty small">
          No matching {{ opLabel.toLowerCase() }}.
        </div>
      </div>
      <div v-if="!visibleGroups.length" class="empty">
        {{ groups.length ? 'Nothing matches.' : 'No catalog yet — sync the endpoint from the Connection tab.' }}
      </div>
    </div>

    <ModalDialog v-if="raising" :title="`Allow writes in ${raising.group.label}?`" @close="raising = undefined">
      <p v-if="raising.exposes.length" class="small">
        These write {{ opLabel.toLowerCase() }} become callable (each still asks for approval unless a pre-approval rule
        matches):
      </p>
      <p v-else class="small">No new writes are exposed; already-acknowledged writes in this group become callable.</p>
      <ul class="expose mono small">
        <li v-for="e in raising.exposes" :key="e.id">{{ e.key }}</li>
      </ul>
      <p v-if="raising.group.counts.locked" class="small muted">
        {{ raising.group.counts.locked }} locked operation(s) stay off; allow them one by one.
      </p>
      <p v-if="raising.note" class="alert warn">{{ raising.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="raising = undefined">Cancel</button>
        <button class="btn btn-danger-solid" type="button" @click="confirmRaise">Allow writes</button>
      </template>
    </ModalDialog>

    <ModalDialog v-if="bulk" :title="`Set every group on /${instance.slug} to Write?`" wide @close="bulk = undefined">
      <p class="small">
        This exposes <strong>{{ bulk.preview.acknowledge.length }}</strong> write operation(s) across
        {{ bulkExposes.length }} group(s). Locked operations stay off. Writes found by later syncs will still wait for
        review.
      </p>
      <div class="bulk-list">
        <div v-for="g in bulkExposes" :key="g.key" class="small">
          <strong>{{ g.label }}</strong> <span class="muted">({{ g.from }} → write)</span>
          <span v-if="g.exposes.length" class="mono muted"> {{ g.exposes.map((e) => e.key).join(', ') }}</span>
        </div>
      </div>
      <div class="field">
        <label for="bulk-confirm"
          >Type <code>{{ instance.slug }}</code> to confirm</label
        >
        <input id="bulk-confirm" v-model="bulk.confirm" autocomplete="off" />
      </div>
      <p v-if="bulk.note" class="alert warn">{{ bulk.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="bulk = undefined">Cancel</button>
        <button
          class="btn btn-danger-solid"
          type="button"
          :disabled="bulk.confirm !== instance.slug"
          @click="confirmBulk"
        >
          Set all to Write
        </button>
      </template>
    </ModalDialog>

    <ModalDialog v-if="merging" title="Regroup" @close="merging = undefined">
      <p class="small muted">
        Merge groups into one control. The merged group takes the lowest of their levels. The mapping survives future
        syncs.
      </p>
      <div class="merge-list">
        <label v-for="g in groups" :key="g.key" class="row small check">
          <input v-model="merging.from" type="checkbox" :value="g.key" />
          {{ g.label }} <span class="mono muted">{{ g.key }}</span>
        </label>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="m-into">Into group key</label>
          <input id="m-into" v-model="merging.into" list="group-keys" placeholder="app" />
          <datalist id="group-keys">
            <option v-for="g in groups" :key="g.key" :value="g.key" />
          </datalist>
        </div>
        <div class="field">
          <label for="m-label">Label</label>
          <input id="m-label" v-model="merging.label" placeholder="Apps" />
        </div>
      </div>
      <p v-if="merging.note" class="alert error">{{ merging.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="merging = undefined">Cancel</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!merging.from.length || !merging.into.trim()"
          @click="confirmMerge"
        >
          Merge
        </button>
      </template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.search {
  padding: 8px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  font-size: 13px;
  min-width: 200px;
}
.check {
  gap: 6px;
  display: inline-flex;
  align-items: center;
}
.group + .group {
  border-top: 1px solid var(--border);
}
.group-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
}
.name {
  cursor: pointer;
  min-width: 0;
}
.caret {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--muted);
  width: 18px;
}
.ops {
  border-top: 1px solid var(--border);
  background: var(--bg);
}
.ops td {
  background: var(--surface);
}
.key {
  margin-left: 6px;
}
.right {
  text-align: right;
}
.controls {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.cls {
  padding: 4px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 12px;
}
.expose,
.bulk-list,
.merge-list {
  max-height: 240px;
  overflow: auto;
  margin: 8px 0 12px;
}
.bulk-list > div + div,
.merge-list > label + label {
  margin-top: 6px;
}
@media (max-width: 720px) {
  .group-row {
    flex-wrap: wrap;
  }
}
</style>
