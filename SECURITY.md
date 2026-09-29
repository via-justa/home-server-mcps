# Security Policy

Synoikia sits between MCP clients and your self-hosted services, and manages
a master encryption key plus per-plugin instance secrets. We take reports
about it, and about the credential handling around it, seriously.

## Supported Versions

Only the latest published release (npm packages `@synoikia/core` /
`@synoikia/plugin-sdk`, and the latest `ghcr.io/via-justa/synoikia-core`
image tag) receives security fixes. There is no long-term support branch —
upgrade to the latest release before reporting an issue that may already be
fixed.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Instead, report it privately through [GitHub private security
advisories](https://github.com/via-justa/synoikia-core/security/advisories/new)
for this repository — this lets us collaborate on a fix before disclosure.

Please include enough detail to reproduce the issue: affected version,
configuration, and, where relevant, the specific request/response or code
path involved.

We're especially interested in reports touching:

- The master key and per-instance secret encryption/handling
- The permission gate, access levels, and human-approval flow
- The `isolated-vm` sandbox boundary
- Authentication (admin login, TOTP, OIDC, MCP OAuth/bearer tokens)
- Secret redaction in logs, the audit trail, and approval pages

## Response

We aim to acknowledge new reports within a few business days and to keep you
updated as we investigate and work on a fix. There is no bug bounty program;
we credit reporters in the release notes unless you'd prefer to stay
anonymous.

## Disclosure

We ask that you give us a reasonable amount of time to address a report
before any public disclosure, and we'll agree on a disclosure timeline with
you as part of the fix.
