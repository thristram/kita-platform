# Console authentication and access runbook

## 1. Register the OIDC application

In `thristram-auth` (`/admin/oauth`), register KitaCon as a **Server-rendered web app** (confidential OIDC client). For local development, use exact redirect URI `http://localhost:3009/api/auth/callback`. Check `openid`, `profile`, and `email`. This admin form registers web apps with `client_secret_basic`. Copy the displayed client ID and secret immediately; the secret is shown only once. Obtain the issuer from the provider discovery document (usually `<BETTER_AUTH_URL>/api/auth/.well-known/openid-configuration`). Copy the `issuer` field exactly; do not guess it from the admin UI URL. A production provider uses its own issuer, client credentials and HTTPS callback.

## 2. Configure KitaCon

Set these in ignored `.env.local` for development and in the deployment's secret store for production:

```dotenv
KITA_AUTH_ISSUER=http://localhost:3000/api/auth
KITA_AUTH_CLIENT_ID=<registered client ID>
KITA_AUTH_CLIENT_SECRET=<registered client secret>
KITA_AUTH_TOKEN_AUTH_METHOD=client_secret_post
KITA_APP_URL=http://localhost:3009
KITA_SESSION_SECRET=<random string of at least 32 characters>
```

The example issuer is a placeholder: use the actual value from discovery. Use separate OIDC clients and secrets for local/staging/production. Normally, `KITA_AUTH_TOKEN_AUTH_METHOD` must match the client's registered method. The current `thristram-auth` 1.6.x server is an exception: its admin form registers `client_secret_basic`, but its Basic-header parser does not percent-decode the client secret. `openid-client` correctly form-encodes the underscores in the `thristram_cs_` prefix, so Basic fails with `invalid_client` even when the secret is correct. For this provider version, set `client_secret_post`; its token endpoint accepts POST authentication, and this exact KitaCon configuration was checked against its introspection endpoint. This is a compatibility workaround, not an OIDC-provider-independent default. Fix Basic decoding in `thristram-auth`, then restore the method matching the registration. Restart `npm run dev` after changing `.env.local`, and start a fresh login from `/sign-in` rather than retrying an old callback code. `KITA_APP_URL` is mandatory in production and determines the callback URL and CSRF origin. Do not reuse `RESOLUTION_AGENT_TOKEN` as the session secret.

Apply `infra/sql/0009_console_access_control.sql` through `npm run db:migrate` **only after confirming the selected database/branch**. The migration creates identity mappings, groups, grants and atomic audit-logged grant mutation. Do not run the migration casually against the production Neon branch while testing locally.

Start the site with `npm run dev`. Open `http://localhost:3009/overview`; the Console redirects to `/sign-in`. Sign in via the provider. The first successful login creates a principal without permissions and shows `/access-denied`.

## 3. Bootstrap the first Owner

After that login, use a trusted database session to verify the exact issuer, subject and email of the intended Owner:

```sql
SELECT p.id, i.auth_issuer, i.auth_subject, p.email
FROM admin.principal p JOIN admin.principal_identity i ON i.principal_id = p.id
ORDER BY p.last_seen_at DESC;
```

Then grant the Owner group to the **verified** principal. Substitute an actual UUID; do not target by email alone:

```sql
INSERT INTO admin.principal_group (principal_id, group_id)
SELECT '<verified-principal-uuid>'::uuid, id
FROM admin.permission_group WHERE key = 'owner'
ON CONFLICT DO NOTHING;
```

Reload `/settings/access`. This one-time bootstrap is the only manual grant; subsequent grants/revocations use the UI and are audited. Keep a second active Owner before removing access from the first.

## 4. Operate and test

- Owners: Settings → Access → search a signed-in identity → check/uncheck Owner, Editor, Reviewer, Operator or Viewer. Changes take effect on the next request.
- Unauthenticated Console page: redirects to `/sign-in`; unauthenticated private API: `401 AUTH_REQUIRED`.
- Signed-in user without required group: `/access-denied` or `403 PERMISSION_DENIED`.
- Mutating private API from a different origin: `403 INVALID_ORIGIN`.
- `/discover` stays public. `/api/internal/v1/resolution/*` continues to use `RESOLUTION_AGENT_TOKEN`; the agent does not need a human Console session.
- Local sign-out clears KitaCon's cookie only. If needed, sign out of the OIDC provider separately.

### Access API contract

Both endpoints require an active Console session with `access:manage`; mutating calls also require the same-origin `Origin` header.

- `GET /api/access` → `{ "groups": [{ "key", "name", "description", "permissions": [string] }], "principals": [{ "id", "email", "status", "last_seen_at", "groups": [string] }] }`.
- `POST /api/access/grants` with JSON `{ "principalId": "<uuid>", "groupKey": "owner|editor|reviewer|operator|viewer", "enabled": true|false }` → `{ "ok": true }`. Invalid input returns `400 INVALID_GRANT`; forbidden/unsafe grants return `409` with a specific error code such as `CANNOT_REMOVE_LAST_OWNER`.
- All private Console APIs return `401 AUTH_REQUIRED` without a session and `403 PERMISSION_DENIED` without the required permission. The UI calls these APIs; bypassing the UI does not bypass the checks.

## 5. Move to another OAuth/OIDC provider

Use a provider with standard OIDC discovery, ID tokens and confidential authorization-code + PKCE. Register the same callback path and set the new issuer/client settings. Before cutover, obtain each user's **verified new-provider `sub`** and link it to their existing principal; for example:

```sql
INSERT INTO admin.principal_identity (auth_issuer, auth_subject, principal_id)
VALUES ('<new issuer>', '<verified new subject>', '<existing principal UUID>'::uuid);
```

Never infer this link from matching email. Rotate `KITA_SESSION_SECRET` and deploy the issuer/client changes together. Old sessions are rejected because the session issuer no longer matches the configured issuer. Test login, access, revocation, public discovery and agent Bearer endpoints before switching traffic.
