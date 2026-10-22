import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("private Console redirects to OIDC sign-in without a session", async () => {
  const response = await render();
  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") ?? "", /^\/sign-in\?returnTo=/);
  const privateResponse = await render("/overview");
  assert.equal(privateResponse.status, 307);
  assert.match(privateResponse.headers.get("location") ?? "", /^\/sign-in\?returnTo=/);
  const apiResponse = await render("/api/candidates");
  assert.equal(apiResponse.status, 401);
  assert.equal((await apiResponse.json()).error, "AUTH_REQUIRED");
});

test("server-renders the public Console sign-in page", async () => {
  const response = await render("/sign-in");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /KitaCon Console/);
  assert.match(html, /Continue with identity provider/);
  assert.match(html, /og:image/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("server-renders the P1 consumer discovery surface", async () => {
  const response = await render("/discover");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Your fandoms are/);
  assert.match(html, /Database discovery/);
  assert.match(html, /canonical database/);
});

test("removes the disposable starter preview", async () => {
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
