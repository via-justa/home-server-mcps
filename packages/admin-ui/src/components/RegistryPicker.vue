<script setup lang="ts">
import { ref, watch } from 'vue';
import { http, qs } from '../api';
import type { RegistryEntry } from '../types';
import ChipsInput from './ChipsInput.vue';

/**
 * `$targets` selector (design §8.3 `registry-picker`): areas and entities come from the instance's
 * synced registry, so rules name real things; domains are free text with suggestions.
 */
const props = defineProps<{ instanceId: string }>();
const model = defineModel<{ areas: string[]; entities: string[]; domains: string[] }>({ required: true });

const areaOptions = ref<{ value: string; label: string }[]>([]);
const entityOptions = ref<{ value: string; label: string }[]>([]);
const entityQuery = ref('');

const toOption = (e: RegistryEntry) => ({ value: e.id, label: e.name ? `${e.name} (${e.id})` : e.id });

async function loadAreas() {
  const rows = await http
    .get<RegistryEntry[]>(`/api/instances/${props.instanceId}/registry${qs({ kind: 'area', limit: 500 })}`)
    .catch(() => []);
  areaOptions.value = rows.map(toOption);
}
async function searchEntities(text: string) {
  const rows = await http
    .get<RegistryEntry[]>(`/api/instances/${props.instanceId}/registry${qs({ kind: 'entity', text, limit: 50 })}`)
    .catch(() => []);
  entityOptions.value = rows.map(toOption);
}
void loadAreas();
void searchEntities('');
let t: ReturnType<typeof setTimeout> | undefined;
watch(entityQuery, (q) => {
  clearTimeout(t);
  t = setTimeout(() => void searchEntities(q), 200);
});
</script>

<template>
  <div class="picker">
    <div class="field">
      <label>Areas</label>
      <ChipsInput v-model="model.areas" :suggestions="areaOptions" placeholder="Pick an area" />
    </div>
    <div class="field">
      <label>Entities</label>
      <input v-model="entityQuery" class="search" placeholder="Search entities…" aria-label="Search entities" />
      <ChipsInput v-model="model.entities" :suggestions="entityOptions" placeholder="widget.one" />
    </div>
    <div class="field">
      <label>Domains</label>
      <ChipsInput v-model="model.domains" placeholder="light, switch" />
    </div>
    <p class="help">Every resolved target must fall inside all the filters you set.</p>
  </div>
</template>

<style scoped>
.picker {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  padding: 10px 12px 2px;
}
.search {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  margin-bottom: 6px;
  font-size: 13px;
}
.help {
  font-size: 12px;
  color: var(--ink-muted);
}
</style>
