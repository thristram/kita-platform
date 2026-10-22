import * as oidc from "openid-client";
import { NextRequest, NextResponse } from "next/server";
import { callbackUrl, oidcConfiguration, safeReturnTo } from "@/lib/consoleOidc";
import { cookieOptions, createLoginTransaction, TRANSACTION_AGE, TRANSACTION_COOKIE } from "@/lib/consoleSession";

export async function GET(request: NextRequest) {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  try {
    const configuration = await oidcConfiguration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: callbackUrl(request.url), response_type: "code", scope: "openid profile email",
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: "S256", state, nonce,
    });
    const response = NextResponse.redirect(url);
    response.cookies.set(TRANSACTION_COOKIE, await createLoginTransaction({ state, nonce, codeVerifier, returnTo }), { ...cookieOptions(request.url), maxAge: TRANSACTION_AGE });
    return response;
  } catch (error) {
    console.error("[console-auth] sign-in failed", error);
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("error", "provider_unavailable");
    url.searchParams.set("returnTo", returnTo);
    return NextResponse.redirect(url);
  }
}
