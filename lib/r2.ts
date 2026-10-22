import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const r2Client = () => {
  const endpoint = process.env.R2_ENDPOINT_URL || process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 signed downloads require R2_ENDPOINT (or R2_ENDPOINT_URL), R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY");
  }
  return new S3Client({ region: "auto", endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
};

export async function createArtifactUrl(bucket: string, key: string, ttlSeconds = 900) {
  const allowedBuckets = new Set([process.env.R2_RAW_BUCKET || "kita-raw", process.env.R2_MEDIA_BUCKET || "kita-media"]);
  if (!allowedBuckets.has(bucket)) throw new Error("Artifact is outside the configured evidence buckets");
  return getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: Math.max(60, Math.min(ttlSeconds, 900)) });
}

export const createRawArtifactUrl = createArtifactUrl;
