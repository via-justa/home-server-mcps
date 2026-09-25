<script setup lang="ts">
import { ref } from 'vue';

/** A list of strings edited as chips; Enter or comma adds, × removes. Optional suggestions. */
const props = defineProps<{
  placeholder?: string;
  suggestions?: { value: string; label: string }[];
  inputId?: string;
}>();
const model = defineModel<string[]>({ required: true });
const draft = ref('');
const listId = `chips-${Math.random().toString(36).slice(2)}`;

function add(raw = draft.value) {
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const next = [...model.value];
  for (const v of values) if (!next.includes(v)) next.push(v);
  model.value = next;
  draft.value = '';
}
function remove(v: string) {
  model.value = model.value.filter((x) => x !== v);
}
const labelOf = (v: string) => props.suggestions?.find((s) => s.value === v)?.label ?? v;
</script>

<template>
  <div class="chips">
    <span v-for="v in model" :key="v" class="chip">
      {{ labelOf(v) }}
      <button type="button" :aria-label="`Remove ${v}`" @click="remove(v)">×</button>
    </span>
    <input
      :id="inputId"
      v-model="draft"
      :placeholder="placeholder"
      :list="suggestions?.length ? listId : undefined"
      @keydown.enter.prevent="add()"
      @keydown.,.prevent="add()"
      @change="suggestions?.some((s) => s.value === draft) && add()"
      @blur="draft && add()"
    />
    <datalist v-if="suggestions?.length" :id="listId">
      <option v-for="s in suggestions" :key="s.value" :value="s.value">{{ s.label }}</option>
    </datalist>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: #fbfbf9;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  background: var(--info-bg);
  color: #1e40af;
  border-radius: 999px;
  padding: 2px 4px 2px 9px;
}
.chip button {
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  font-size: 14px;
  line-height: 1;
}
input {
  flex: 1;
  min-width: 120px;
  border: none !important;
  background: transparent !important;
  padding: 4px !important;
  font-size: 13px;
  outline: none;
}
</style>
