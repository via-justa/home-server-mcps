/** A live, routable plugin instance. Filled in by the plugin host in phase 4/14. */
export interface Endpoint {
  instanceId: string;
  slug: string;
  pluginId: string;
  enabled: boolean;
}

/** Maps `/{slug}` on the MCP listener to a plugin instance. */
export class EndpointRegistry {
  private readonly bySlug = new Map<string, Endpoint>();

  get(slug: string): Endpoint | undefined {
    return this.bySlug.get(slug);
  }

  list(): Endpoint[] {
    return [...this.bySlug.values()];
  }
}
