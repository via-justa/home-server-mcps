import { runPlugin } from '@home-server-mcps/plugin-sdk';
import { createHomeAssistantPlugin } from './plugin.js';

// Behavior follows docs/reference/homeassistant-mcp-design.md, mapped onto the plugin hooks in
// docs/design/unified-mcp-server.md §3.3–§3.4.
runPlugin(createHomeAssistantPlugin());
