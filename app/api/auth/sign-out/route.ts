import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, TRANSACTION_COOKIE } from "@/lib/consoleSession";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/sign-in", request.url), 303);
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(TRANSACTION_COOKIE);
  return response;
}
