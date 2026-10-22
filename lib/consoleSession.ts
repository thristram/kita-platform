import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";

export const SESSION_COOKIE = "kita_console_session";
export const TRANSACTION_COOKIE = "kita_console_oidc";
export const SESSION_AGE = 8 * 60 * 60;
export const TRANSACTION_AGE = 10 * 60;

export type ConsoleSession = {
  principalId: string;
  issuer: string;
  subject: string;
  email: string;
  name: string;
};

export type LoginTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
};

function key() {
  const secret = process.env.KITA_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("KITA_SESSION_SECRET must have at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

async function seal(value: Record<string, string>, audience: string, age: number) {
  return new EncryptJWT(value)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer("kitacon-console")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + age)
    .encrypt(key());
}

async function unseal(value: string | undefined, audience: string) {
  if (!value) return null;
  try {
    const { payload } = await jwtDecrypt(value, key(), { issuer: "kitacon-console", audience });
    return payload;
  } catch {
    return null;
  }
}

function fields(payload: Record<string, unknown> | null, names: string[]) {
  if (!payload) return null;
  const values: Record<string, string> = {};
  for (const name of names) {
    if (typeof payload[name] !== "string" || !payload[name]) return null;
    values[name] = payload[name];
  }
  return values;
}

export const createSession = (session: ConsoleSession) => seal(session, "session", SESSION_AGE);
export async function readSession(value: string | undefined): Promise<ConsoleSession | null> {
  return fields(await unseal(value, "session"), ["principalId", "issuer", "subject", "email", "name"]) as ConsoleSession | null;
}
export const createLoginTransaction = (transaction: LoginTransaction) => seal(transaction, "oidc", TRANSACTION_AGE);
export async function readLoginTransaction(value: string | undefined): Promise<LoginTransaction | null> {
  return fields(await unseal(value, "oidc"), ["state", "nonce", "codeVerifier", "returnTo"]) as LoginTransaction | null;
}

export function cookieOptions(requestUrl: string) {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" || new URL(requestUrl).protocol === "https:", path: "/" };
}
