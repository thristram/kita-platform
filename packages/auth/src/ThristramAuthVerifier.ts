import type { AuthVerifier, VerifiedIdentity } from "./AuthVerifier";

export interface ThristramAuthConfig {
  issuer: string;
  audience: string;
  introspectionUrl: string;
  fetchImpl?: typeof fetch;
}

export class ThristramAuthVerifier implements AuthVerifier {
  constructor(private readonly config: ThristramAuthConfig) {}

  async verify(accessToken: string): Promise<VerifiedIdentity> {
    const request = this.config.fetchImpl ?? fetch;
    const response = await request(this.config.introspectionUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken, audience: this.config.audience }),
    });
    if (!response.ok) throw new Error("Authentication service rejected the token");
    const claims = await response.json() as Record<string, unknown>;
    if (claims.active !== true || claims.iss !== this.config.issuer || typeof claims.sub !== "string") {
      throw new Error("Invalid access token claims");
    }
    return { issuer: this.config.issuer, subject: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined, claims };
  }
}
