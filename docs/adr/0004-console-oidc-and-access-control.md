# ADR 0004: Console OIDC and KitaCon-owned access control

Status: implemented, pending deployment configuration and migration.

## Decision

- KitaCon consumes a standards-based OIDC provider. Initial provider: `thristram-auth`; production may use another provider by changing `KITA_AUTH_ISSUER`, client credentials, token-endpoint authentication method and registered callback. Application code does not call provider-specific endpoints.
- The browser uses authorization-code flow with PKCE, state and nonce. The callback validates the ID token through `openid-client`; the Console stores only an encrypted, HTTP-only, SameSite=Lax local session, not access/refresh tokens. Sessions expire after 8 hours. Sign-out clears the local session; global IdP logout is not implemented.
- The provider authenticates a person; it does **not** authorize KitaCon operations. `admin.principal_identity` maps `(issuer, subject)` to a stable `admin.principal`. Group grants live in `admin.principal_group`, not in OIDC claims or `admin.principal.role`. `permissionSet` queries the database at request time, so revocation takes effect on the next request.
- First login registers a principal without any grants. An existing Owner assigns a group in Settings → Access. The first Owner is bootstrapped once by an exact issuer/subject SQL statement after that person has signed in. No email-domain or provider-admin auto-grant.
- Access is checked in server-rendered Console pages and each private API route. The root `proxy.ts` adds early redirect/CSRF protection, but is not the sole authorization boundary. The customer `/discover` pages stay public. Internal Resolution Agent endpoints keep their independent Bearer-token authorization.

## Permission groups

| Group | Permissions |
| --- | --- |
| Owner | All including `access:manage`, `settings:write` |
| Editor | Console read, event write, candidate review, source write, job write |
| Reviewer | Console read, event write, candidate review |
| Operator | Console read, source write, job write |
| Viewer | Console read only |

The group table records explicit permission strings so future groups can be added without changing the session contract. Changing group definitions should be done via a reviewed migration. Grant/revoke is atomic with audit logging in `admin.set_permission_group`; an Owner cannot remove their own Owner group or the last active Owner.

## Provider switch

The issuer is part of every identity key. Switching `KITA_AUTH_ISSUER` invalidates old local sessions immediately. To preserve a principal's KitaCon grants, verify the new provider's subject for that person and pre-link it to the existing `admin.principal.id` in `admin.principal_identity` before cutover. Never match accounts by email alone. Rotate the OIDC client secret and `KITA_SESSION_SECRET` during cutover; register the exact production callback and origins in the replacement provider. The primary `admin.principal.auth_issuer/auth_subject` columns remain historical; active lookup uses the identity mapping table.

## Boundaries and follow-up

- Browser-origin validation protects mutating private API routes. Routes that need programmatic access should get a separate scoped service-token contract, not a bypass of the human session.
- Group assignment currently targets identities that have signed in once. Invitations/pre-provisioning are intentionally deferred.
- `thristram-auth` admin role, email domain and email address are not Console permissions.
- A production security review should confirm the deployment uses HTTPS, exact trusted `KITA_APP_URL`, separate secrets per environment, and appropriate session/audit retention.
