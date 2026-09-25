/** Top-level paths on the MCP listener that can never be used as an instance slug (design §2.2). */
export const RESERVED_SLUGS = ['oauth', 'a', 'healthz', '.well-known', 'api', 'auth', 'static'] as const;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !(RESERVED_SLUGS as readonly string[]).includes(slug);
}
