import * as oidc from "openid-client";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

let cached: Promise<oidc.Configuration> | undefined;
export function oidcConfiguration() {
  const tokenAuthMethod = process.env.KITA_AUTH_TOKEN_AUTH_METHOD?.trim() || "client_secret_basic";
  if (tokenAuthMethod !== "client_secret_post" && tokenAuthMethod !== "client_secret_basic") {
    throw new Error("KITA_AUTH_TOKEN_AUTH_METHOD must be client_secret_post or client_secret_basic");
  }
  const secret = required("KITA_AUTH_CLIENT_SECRET");
  cached ??= oidc.discovery(
    new URL(required("KITA_AUTH_ISSUER")),
    required("KITA_AUTH_CLIENT_ID"),
    { token_endpoint_auth_method: tokenAuthMethod },
    tokenAuthMethod === "client_secret_basic" ? oidc.ClientSecretBasic(secret) : oidc.ClientSecretPost(secret),
  );
  return cached;
}

export function appOrigin(requestUrl: string) {
  const configured = process.env.KITA_APP_URL?.trim();
  if (configured) return new URL(configured).origin;
  if (process.env.NODE_ENV === "production") throw new Error("KITA_APP_URL is required in production");
  return new URL(requestUrl).origin;
}

export function callbackUrl(requestUrl: string) {
  return new URL("/api/auth/callback", appOrigin(requestUrl)).toString();
}

export function safeReturnTo(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/overview";
  return value;
}
