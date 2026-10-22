import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { Providers } from "../components/Providers";
import { THEME_STORAGE_KEY } from "@/lib/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3001";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const socialImage = `${protocol}://${host}/og.png`;
  const title = "KitaCon | Fandom intelligence, going places";
  const description = "Discover and manage real-world anime and Japanese pop-culture events through a trustworthy canonical data platform.";
  return {
    title,
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title, description, images: [{ url: socialImage, width: 1200, height: 630, alt: "KitaCon: Your fandoms are going places." }] },
    twitter: { card: "summary_large_image", title, description, images: [socialImage] },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const themeCookie = (await cookies()).get(THEME_STORAGE_KEY)?.value;
  const initialTheme = themeCookie === "dark" || themeCookie === "light" ? themeCookie : undefined;
  return (
    <html lang="en" suppressHydrationWarning data-theme={initialTheme} className={initialTheme === "dark" ? "dark" : undefined}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: `html,body{background:#fff}@media(prefers-color-scheme:dark){html:not([data-theme="light"]),html:not([data-theme="light"]) body{background:#0d0e12}}html[data-theme="dark"],html[data-theme="dark"] body{background:#0d0e12}` }}/>
        <script
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{if(location.pathname.startsWith("/discover"))return;const s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});const c=${JSON.stringify(initialTheme ?? "")};const t=s==="dark"||s==="light"?s:(c==="dark"||c==="light"?c:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"));document.documentElement.dataset.theme=t;document.documentElement.classList.toggle("dark",t==="dark");document.cookie=${JSON.stringify(`${THEME_STORAGE_KEY}=`)}+t+"; Path=/; Max-Age=31536000; SameSite=Lax"}catch{}})();`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
