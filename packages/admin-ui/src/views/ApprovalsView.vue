<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { errorText, http, qs } from '../api';
import PageHeader from '../components/PageHeader.vue';
import { formatDate, pretty, until } from '../format';
import { useAppStore } from '../stores/app';
import type { Approval } from '../types';

const app = useAppStore();
const filter = ref<'pending' | 'all'>('pending');
const rows = ref<Approval[]>([]);
const error = ref<string>();
const confirms = ref<Record<string, string>>({});
const rowErrors = ref<Record<string, string>>({});
const busy = ref<string>();
const now = ref(Date.now());

async function load() {
  try {
    rows.value = await http.get<Approval[]>(`/api/approvals${qs({ status: filter.value })}`);
    error.value = undefined;
  } catch (err) {
    error.value = errorText(err);
  }
}

async function decide(a: Approval, approve: boolean) {
  busy.value = a.id;
  rowErrors.value = { ...rowErrors.value, [a.id]: '' };
  try {
    await http.post(
      `/api/approvals/${a.id}/${approve ? 'approve' : 'deny'}`,
      approve ? { confirm: confirms.value[a.id] } : {},
    );
    await load();
    void app.refresh();
  } catch (err) {
    rowErrors.value = { ...rowErrors.value, [a.id]: errorText(err) };
  } finally {
    busy.value = undefined;
  }
}

let off: (() => void) | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  off = app.on((event) => {
    if (event.startsWith('approval.')) void load();
  });
  tick = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  off?.();
  clearInterval(tick);
});

const STATUS_CLASS: Record<string, string> = { approved: 'ok', denied: 'danger', timed_out: 'warn', cancelled: '' };
</script>

<template>
  <div class="page">
    <PageHeader title="Pending Approvals" subtitle="Write calls paused until a person decides">
      <div class="segmented">
        <button type="button" :class="{ on: filter === 'pending' }" @click="((filter = 'pending'), load())">
          Pending
        </button>
        <button type="button" :class="{ on: filter === 'all' }" @click="((filter = 'all'), load())">History</button>
      </div>
    </PageHeader>

    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <div v-if="!rows.length && !error" class="card empty">
      {{ filter === 'pending' ? 'Nothing is waiting for approval.' : 'No approvals yet.' }}
    </div>

    <div class="stack">
      <article v-for="a in rows" :key="a.id" class="card approval" :data-approval="a.id">
        <header class="row">
          <span class="mono op">{{ a.operation.key }}</span>
          <span v-if="a.operation.classification === 'locked'" class="pill danger">locked</span>
          <RouterLink :to="`/endpoints/${a.instance.slug}/access`" class="mono small"
            >/{{ a.instance.slug }}</RouterLink
          >
          <span class="grow" />
          <span v-if="a.status === 'pending'" class="pill warn">expires in {{ until(a.expiresAt, now) }}</span>
          <span v-else class="pill" :class="STATUS_CLASS[a.status]">{{ a.status.replace('_', ' ') }}</span>
        </header>
        <p class="summary">{{ a.summary }}</p>
        <div class="small muted">
          Requested {{ formatDate(a.requestedAt) }} by {{ a.clientId ?? a.clientKind ?? 'unknown client' }}
          <template v-if="a.decidedBy"> · decided by {{ a.decidedBy }} via {{ a.decidedVia }}</template>
        </div>
        <details>
          <summary class="small">Parameters (secrets redacted)</summary>
          <pre class="code">{{ pretty(a.paramsDisplay ?? {}) }}</pre>
          <template v-if="a.resolvedTargets">
            <div class="small muted">Targets</div>
            <pre class="code">{{ pretty(a.resolvedTargets) }}</pre>
          </template>
          <template v-if="a.diff">
            <div class="small muted">Changes</div>
            <pre class="code">{{ pretty(a.diff) }}</pre>
          </template>
        </details>
        <form v-if="a.status === 'pending'" class="row decide" @submit.prevent="decide(a, true)">
          <template v-if="a.requiresConfirmation">
            <label class="small" :for="`c-${a.id}`"
              >Type <code>{{ a.confirmLiteral }}</code> to approve</label
            >
            <input
              :id="`c-${a.id}`"
              v-model="confirms[a.id]"
              class="confirm"
              autocomplete="off"
              :placeholder="a.confirmLiteral ?? ''"
            />
          </template>
          <span class="grow" />
          <button class="btn btn-danger" type="button" :disabled="busy === a.id" @click="decide(a, false)">Deny</button>
          <button
            class="btn btn-primary"
            type="submit"
            :disabled="busy === a.id || (a.requiresConfirmation && confirms[a.id] !== a.confirmLiteral)"
          >
            Approve
          </button>
        </form>
        <p v-if="rowErrors[a.id]" class="alert error" role="alert">{{ rowErrors[a.id] }}</p>
      </article>
    </div>
  </div>
</template>

<style scoped>
.approval {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.op {
  font-weight: 700;
}
.summary {
  margin: 0;
  font-size: 14px;
}
.confirm {
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  font-family: ui-monospace, monospace;
}
.decide {
  margin-top: 4px;
}
</style>
