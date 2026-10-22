import Link from "next/link";
export default function AccessDeniedPage() {
  return <main className="auth-page"><section className="auth-card"><span className="eyebrow">KitaCon Console</span><h1>Access pending</h1><p>Your identity is signed in, but an Owner has not granted the permission group needed for this page. Ask a KitaCon Owner to grant access in Settings → Access.</p><form action="/api/auth/sign-out" method="post"><button className="secondary-button" type="submit">Sign out</button></form><Link href="/discover">Explore public events</Link></section></main>;
}
