import { NextRequest, NextResponse } from "next/server";
import { appOrigin, safeReturnTo } from "@/lib/consoleOidc";
import { readSession, SESSION_COOKIE } from "@/lib/consoleSession";

const publicPaths = ["/discover", "/sign-in", "/access-denied", "/api/auth", "/api/internal/v1/resolution", "/favicon", "/og.png", "/_next", "/__debug"];

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isApi = path.startsWith("/api/");
  if (publicPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) || (!isApi && /\.(?:png|jpe?g|svg|ico|css|js|woff2?|webp|avif)$/.test(path))) return NextResponse.next();
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    if (isApi) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("returnTo", safeReturnTo(path + request.nextUrl.search));
    return NextResponse.redirect(url);
  }
  if (!(["GET", "HEAD", "OPTIONS"].includes(request.method)) && isApi) {
    const origin = request.headers.get("origin");
    if (origin !== appOrigin(request.url)) return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/:path*"] };
