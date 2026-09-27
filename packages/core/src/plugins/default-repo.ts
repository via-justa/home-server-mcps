/**
 * The repository core ships pre-configured (design §4.1): the Synoikia plugins, signed with this key.
 * It is added once on first start; an admin who removes it keeps it removed.
 */
export const DEFAULT_PLUGIN_REPO = {
  url: 'https://github.com/via-justa/synoikia-core-plugins/releases/download/index/index.json',
  name: 'Synoikia plugins',
  publicKey: 'RWSDbQe7ylyyieEU0Yh/bxR53m+N/0VrVMru5WCzv1/Yvt5td92t/21e',
};
