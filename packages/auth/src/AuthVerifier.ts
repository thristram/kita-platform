export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email?: string;
  claims: Record<string, unknown>;
}

export interface AuthVerifier {
  verify(accessToken: string): Promise<VerifiedIdentity>;
}
