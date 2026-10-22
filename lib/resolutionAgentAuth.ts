const MINIMUM_TOKEN_LENGTH = 32;

function constantTimeEqual(left: string, right: string): boolean {
  const maximumLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function authorizeResolutionAgent(request: Request): Response | null {
  const configured = process.env.RESOLUTION_AGENT_TOKEN || "";
  if (configured.length < MINIMUM_TOKEN_LENGTH) {
    console.error("[resolution-agent] RESOLUTION_AGENT_TOKEN is missing or shorter than 32 characters");
    return Response.json({ error: "Resolution Agent API is not configured" }, { status: 503 });
  }
  const authorization = request.headers.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!constantTimeEqual(configured, supplied)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  return null;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
