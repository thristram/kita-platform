import * as oidc from "openid-client";
import { NextRequest, NextResponse } from "next/server";
import { registerConsoleIdentity } from "@/db/consoleAccess";
import { oidcConfiguration, safeReturnTo } from "@/lib/consoleOidc";
import { cookieOptions, createSession, readLoginTransaction, SESSION_AGE, SESSION_COOKIE, TRANSACTION_COOKIE } from "@/lib/consoleSession";

function failed(request: NextRequest, reason: string) {
  const url = new URL("/sign-in", request.url);
  url.searchParams.set("error", reason);
  const response = NextResponse.redirect(url);
  response.cookies.delete(TRANSACTION_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const transaction = await readLoginTransaction(request.cookies.get(TRANSACTION_COOKIE)?.value);
  if (!transaction) return failed(request, "expired");
  if (request.nextUrl.searchParams.has("error")) return failed(request, "denied");
  try {
    const configuration = await oidcConfiguration();
    const result = await oidc.authorizationCodeGrant(configuration, new URL(request.url), {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
    const claims = result.claims();
    const issuer = claims?.iss;
    const subject = claims?.sub;
    const email = typeof claims?.email === "string" ? claims.email : undefined;
    const name = typeof claims?.name === "string" && claims.name ? claims.name : email;
    if (!issuer || !subject || !email || !name || claims?.email_verified === false) return failed(request, "profile");
    const session = await registerConsoleIdentity({ issuer, subject, email, name });
    const response = NextResponse.redirect(new URL(safeReturnTo(transaction.returnTo), request.url));
    response.cookies.set(SESSION_COOKIE, await createSession(session), { ...cookieOptions(request.url), maxAge: SESSION_AGE });
    response.cookies.delete(TRANSACTION_COOKIE);
    return response;
  } catch (error) {
    console.error("[console-auth] callback failed", error);
    return failed(request, "callback");
  }
}
