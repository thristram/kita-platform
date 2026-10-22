import Link from "next/link";
import { safeReturnTo } from "@/lib/consoleOidc";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ returnTo?: string; error?: string }> }) {
  const { returnTo, error } = await searchParams;
  const url = `/api/auth/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
  return <main className="auth-page"><section className="auth-card"><span className="eyebrow">KitaCon Console</span><h1>Sign in</h1><p>Use your organization account to access the operator Console. Permissions are managed separately inside KitaCon.</p>{error ? <p role="alert">Sign-in could not be completed ({error}). Please try again or contact an administrator.</p> : null}<Link className="primary-button" href={url}>Continue with identity provider →</Link><Link href="/discover">Explore public events</Link></section></main>;
}
