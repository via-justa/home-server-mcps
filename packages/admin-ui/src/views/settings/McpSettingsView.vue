<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { errorText, http } from '../../api';
import { AUTH_MODE_LABELS } from '../../format';
import { AUTH_MODES } from '../../types';
import type { Settings } from '../../types';

const form = ref<Settings['mcp']>();
const publicMcpUrl = ref<string | null>(null);
const message = ref<{ kind: 'ok' | 'error'; text: string }>();
const endpointPattern = computed(() => `${publicMcpUrl.value ?? '<this server>'}/<slug>`);

onMounted(async () => {
  try {
    const s = await http.get<Settings>('/api/settings');
    form.value = structuredClone(s.mcp);
    publicMcpUrl.value = s.publicMcpUrl;
  } catch (err) {
    message.value = { kind: 'error', text: errorText(err) };
  }
});

async function save() {
  try {
    form.value = await http.put<Settings['mcp']>('/api/settings/mcp', form.value);
    message.value = { kind: 'ok', text: 'Saved.' };
  } catch (err) {
    message.value = { kind: 'error', text: errorText(err) };
  }
}

const MODE_HELP: Record<string, string> = {
  external: 'A reverse proxy (Cloudflare Access, Authelia, Authentik) authenticates clients. Only use behind one.',
  bearer: 'Clients send a token created under Clients & Tokens.',
  oauth: 'Clients sign in through this server (OAuth 2.1 with PKCE) — what claude.ai connectors expect.',
  'bearer+oauth': 'Either a bearer token or OAuth.',
};
</script>

<template>
  <form v-if="form" class="stack" @submit.prevent="save">
    <section class="card about">
      <h2>How MCP access works</h2>
      <ul class="small">
        <li>
          Each endpoint is its own MCP server at
          <span class="mono">{{ endpointPattern }}</span
          >. Add it to an MCP client from the endpoint's Connection tab.
        </li>
        <li>
          An endpoint exposes two tools: <code>search</code> to explore the service's API and <code>execute</code> to
          call it. Every call goes through the endpoint's Access levels, pre-approval rules, approvals and the audit
          log.
        </li>
        <li>
          The settings below only decide <em>who can connect</em>, not what a client may do. Endpoints use the default
          authentication unless they override it in their own Settings tab.
        </li>
        <li>
          Bearer tokens are created under <RouterLink to="/clients">Clients &amp; Tokens</RouterLink>. OAuth lets a
          client sign in through this server with a portal account. External mode leaves authentication to a reverse
          proxy in front of the server.
        </li>
      </ul>
    </section>

    <section class="card">
      <h2>Default client authentication</h2>
      <p class="small muted">Endpoints use this unless they override it in their own settings.</p>
      <div class="field">
        <select v-model="form.defaultAuthMode" aria-label="Default authentication mode">
          <option v-for="m in AUTH_MODES" :key="m" :value="m">{{ AUTH_MODE_LABELS[m] }}</option>
        </select>
        <p class="help">{{ MODE_HELP[form.defaultAuthMode] }}</p>
      </div>
      <p class="small">
        Public MCP URL: <span class="mono">{{ publicMcpUrl ?? 'not set — derived from each request' }}</span>
      </p>
    </section>

    <section class="card">
      <h2>OAuth</h2>
      <p class="small muted">Applies to endpoints using OAuth or Bearer or OAuth.</p>
      <div class="field check">
        <label
          ><input v-model="form.allowDynamicRegistration" type="checkbox" /> Let MCP clients register themselves
          (dynamic client registration)</label
        >
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="m-at">Access token lifetime (minutes)</label>
          <input id="m-at" v-model.number="form.accessTokenTtlMinutes" type="number" min="5" max="1440" />
        </div>
        <div class="field">
          <label for="m-rt">Refresh token lifetime (days)</label>
          <input id="m-rt" v-model.number="form.refreshTokenTtlDays" type="number" min="1" max="365" />
        </div>
      </div>
    </section>

    <section class="card">
      <h2>External mode</h2>
      <p class="small muted">
        Applies to endpoints using External. With Cloudflare Access, the server also verifies the Access JWT itself.
      </p>
      <div class="form-grid">
        <div class="field">
          <label for="m-cft">Cloudflare team domain</label>
          <input id="m-cft" v-model="form.cfAccess.teamDomain" placeholder="myteam.cloudflareaccess.com" />
        </div>
        <div class="field">
          <label for="m-cfa">Application audience (AUD)</label>
          <input id="m-cfa" v-model="form.cfAccess.aud" />
        </div>
        <div class="field">
          <label for="m-hdr">Trusted identity header</label>
          <input id="m-hdr" v-model="form.trustedIdentityHeader" placeholder="Remote-User" />
          <p class="help">Used only to attribute calls in the audit log.</p>
        </div>
      </div>
    </section>

    <p v-if="message" class="alert" :class="message.kind" role="status">{{ message.text }}</p>
    <div class="actions"><button class="btn btn-primary" type="submit">Save</button></div>
  </form>
  <p v-else-if="message" class="alert error">{{ message.text }}</p>
</template>

<style scoped>
.about ul {
  margin: 0;
  padding-left: 18px;
}
.about li + li {
  margin-top: 6px;
}
</style>
