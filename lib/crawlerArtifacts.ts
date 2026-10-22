const allowedBuckets = () => new Set([process.env.R2_RAW_BUCKET || "kita-raw", process.env.R2_MEDIA_BUCKET || "kita-media"]);

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const hmac = async (key: ArrayBuffer, value: string): Promise<ArrayBuffer> => {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
};

async function readR2Artifact(bucket: string, key: string): Promise<Uint8Array> {
  const endpoint = process.env.R2_ENDPOINT_URL || process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("R2 credentials are not configured");
  const base = endpoint.replace(/\/+$/, "");
  const encodedKey = key.split("/").map((part) => encodeURIComponent(part)).join("/");
  const url = new URL(`${base}/${encodeURIComponent(bucket)}/${encodedKey}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = "UNSIGNED-PAYLOAD";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = ["GET", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256(canonicalRequest)].join("\n");
  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer, date);
  const regionKey = await hmac(dateKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(url, { cache: "no-store", headers: { Authorization: authorization, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate } });
  if (!response.ok) throw new Error(`Artifact download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function readCrawlerArtifact(bucket: string, key: string): Promise<Uint8Array> {
  if (!allowedBuckets().has(bucket)) throw new Error("Artifact is outside the configured evidence buckets");
  const mode = process.env.CRAWLER_ARTIFACT_MODE || ((process.env.R2_ENDPOINT_URL || process.env.R2_ENDPOINT) && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY ? "r2" : "local");
  if (mode !== "local") return readR2Artifact(bucket, key);
  const [{ readFile }, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  const root = path.resolve(process.cwd(), process.env.CRAWLER_ARTIFACT_ROOT || "var/crawler/artifacts");
  const storeRoot = path.resolve(root, bucket === (process.env.R2_MEDIA_BUCKET || "kita-media") ? "media" : "raw");
  const target = path.resolve(storeRoot, key);
  if (target !== storeRoot && !target.startsWith(`${storeRoot}${path.sep}`)) throw new Error("Artifact key escapes the configured root");
  return readFile(target);
}
