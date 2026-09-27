<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') emit('close');
};
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="modal card" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
      <header>
        <h2>{{ title }}</h2>
        <button class="close" type="button" aria-label="Close" @click="emit('close')">×</button>
      </header>
      <div class="body"><slot /></div>
      <footer v-if="$slots.footer" class="actions"><slot name="footer" /></footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(36 27 18 / 45%);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 16px;
  z-index: 50;
  overflow: auto;
}
.modal {
  width: 100%;
  max-width: 520px;
}
.modal.wide {
  max-width: 760px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
header h2 {
  margin: 0;
}
.close {
  border: none;
  background: none;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: var(--ink-muted);
}
footer {
  justify-content: flex-end;
  margin-top: 18px;
}
</style>
