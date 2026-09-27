<script setup lang="ts">
// Primary lockup: mark + Fraunces wordmark, with the -oikia root ("house") in brand.
import BrandMark from './BrandMark.vue';

withDefaults(defineProps<{ size?: number; tag?: string }>(), { size: 32, tag: 'div' });
</script>

<template>
  <component :is="tag" class="brand-lockup" :style="{ '--mark': `${size}px` }">
    <BrandMark :size="size" />
    <span class="wordmark">Syn<span class="root">oikia</span></span>
  </component>
</template>

<style scoped>
.brand-lockup {
  display: flex;
  align-items: center;
  gap: calc(var(--mark) * 0.33);
  margin: 0;
}
.wordmark {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: calc(var(--mark) * 0.72);
  line-height: 1;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.root {
  color: var(--brand);
}
</style>
