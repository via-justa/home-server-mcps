<script setup lang="ts">
import { useRouter } from 'vue-router';
import TotpEnrollment from '../components/TotpEnrollment.vue';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const router = useRouter();

async function enrolled() {
  await session.load();
  await router.replace('/');
}
async function logout() {
  await session.logout();
  await router.replace('/login');
}
</script>

<template>
  <main class="enroll">
    <div class="card">
      <h1>Two-factor authentication is required</h1>
      <p class="muted small">This server requires every account to use an authenticator app before continuing.</p>
      <TotpEnrollment @enrolled="enrolled" />
      <p class="small"><button class="btn-link" type="button" @click="logout">Log out</button></p>
    </div>
  </main>
</template>

<style scoped>
.enroll {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.card {
  width: 460px;
  max-width: 100%;
}
h1 {
  font-size: 18px;
  margin: 0 0 6px;
}
</style>
