<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const submitting = ref(false);
const error = ref<string>();

const canSubmit = computed(() => username.value.trim() !== '' && password.value !== '' && !submitting.value);

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = undefined;
  try {
    await session.login(username.value.trim(), password.value);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/');
  } catch (err) {
    error.value =
      err instanceof ApiError && err.status === 401
        ? 'Invalid username or password.'
        : 'Sign-in is unavailable right now. Try again later.';
  } finally {
    password.value = '';
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login">
    <form class="card login-card" @submit.prevent="submit">
      <div class="brand">
        <div class="logo">M</div>
        <h1>MCP Admin</h1>
      </div>

      <div class="field">
        <label for="username">Username</label>
        <input id="username" v-model="username" name="username" autocomplete="username" autofocus />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" v-model="password" name="password" type="password" autocomplete="current-password" />
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <button class="btn btn-primary" type="submit" :disabled="!canSubmit">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>

      <template v-if="session.oidcEnabled">
        <div class="divider"><span>or</span></div>
        <a class="btn oidc" href="/auth/oidc/start">Sign in with {{ session.oidcLabel ?? 'SSO' }}</a>
      </template>
    </form>
  </main>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-card {
  width: 340px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.brand h1 {
  margin: 0;
  font-size: 17px;
}
.logo {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.error {
  margin: 0;
  font-size: 13px;
  color: var(--danger);
}
.divider {
  text-align: center;
  font-size: 12px;
  color: var(--subtle);
}
.oidc {
  text-align: center;
  text-decoration: none;
}
</style>
