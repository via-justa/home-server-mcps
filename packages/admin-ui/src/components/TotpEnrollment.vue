<script setup lang="ts">
import { ref } from 'vue';
import { errorText, http } from '../api';

/** TOTP enrollment: show the secret/otpauth URI, confirm with a code, show recovery codes once. */
const emit = defineEmits<{ enrolled: [] }>();

const secret = ref<{ secret: string; uri: string }>();
const code = ref('');
const recovery = ref<string[]>();
const error = ref<string>();

async function begin() {
  error.value = undefined;
  try {
    secret.value = await http.post('/api/profile/totp/begin');
  } catch (err) {
    error.value = errorText(err);
  }
}

async function confirm() {
  error.value = undefined;
  try {
    const res = await http.post<{ recoveryCodes: string[] }>('/api/profile/totp/confirm', { code: code.value.trim() });
    recovery.value = res.recoveryCodes;
  } catch (err) {
    error.value = errorText(err);
  } finally {
    code.value = '';
  }
}
</script>

<template>
  <div class="stack">
    <template v-if="recovery">
      <div class="alert ok">Two-factor authentication is on.</div>
      <p class="small">
        Save these recovery codes somewhere safe. Each works once if you lose your authenticator. They are not shown
        again.
      </p>
      <pre class="code recovery">{{ recovery.join('\n') }}</pre>
      <div><button class="btn btn-primary" type="button" @click="emit('enrolled')">I saved them</button></div>
    </template>
    <template v-else-if="secret">
      <p class="small">
        Add this account to your authenticator app with the secret below (or open the link on a phone), then enter the
        6-digit code it shows.
      </p>
      <div class="field">
        <label>Secret</label>
        <code class="secret">{{ secret.secret }}</code>
      </div>
      <p class="small"><a :href="secret.uri">Open in authenticator app</a></p>
      <form class="row" @submit.prevent="confirm">
        <input
          v-model="code"
          aria-label="Code"
          class="code-input"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="123456"
        />
        <button class="btn btn-primary" type="submit" :disabled="!code.trim()">Confirm</button>
      </form>
    </template>
    <div v-else>
      <button class="btn btn-primary" type="button" @click="begin">Set up two-factor authentication</button>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.secret {
  font-family: ui-monospace, monospace;
  font-size: 14px;
  letter-spacing: 0.08em;
  word-break: break-all;
}
.code-input {
  width: 140px;
  padding: 9px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  font-size: 14px;
}
.recovery {
  columns: 2;
}
</style>
