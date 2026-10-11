"use strict";

// S3-compatible private object storage for schematic files.
// Credentials are read only from the hosting environment; never expose them to Discord or the browser.
const crypto = require("node:crypto");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const MAX_SCHEMATIC_BYTES = 25 * 1024 * 1024;

function getConfig() {
  const endpoint = process.env.R2_ENDPOINT;
  const region = process.env.R2_REGION;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const missing = [
    ["R2_ENDPOINT", endpoint],
    ["R2_REGION", region],
    ["R2_BUCKET_NAME", bucket],
    ["R2_ACCESS_KEY_ID", accessKeyId],
    ["R2_SECRET_ACCESS_KEY", secretAccessKey]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error("S3 storage is not configured; missing: " + missing.join(", "));
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("R2_ENDPOINT must be a valid HTTPS URL without embedded credentials.");
  }
  return { endpoint: parsed.origin, region, bucket, accessKeyId, secretAccessKey };
}

function client() {
  const c = getConfig();
  return {
    bucket: c.bucket,
    s3: new S3Client({
      endpoint: c.endpoint,
      region: c.region,
      forcePathStyle: true,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
    })
  };
}

function safeFileName(name) {
  const cleaned = String(name || "schematic.litematic")
    .replace(/[\\/\\0-\\x1f\\x7f]/g, "_")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim()
    .slice(0, 150);
  return cleaned.toLowerCase().endsWith(".litematic") ? cleaned : cleaned + ".litematic";
}

async function testConnection() {
  const { s3, bucket } = client();
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  return { ok: true, bucket };
}

async function uploadSchematic(buffer, originalName) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("Schematic upload must be a Buffer.");
  if (!buffer.length || buffer.length > MAX_SCHEMATIC_BYTES) {
    throw new Error("Schematic file must be between 1 byte and 25 MB.");
  }
  if (!String(originalName || "").toLowerCase().endsWith(".litematic")) {
    throw new Error("Only .litematic files are accepted.");
  }
  const { s3, bucket } = client();
  const key = "schematics/" + new Date().toISOString().slice(0, 10) + "/" + crypto.randomUUID() + ".litematic";
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentLength: buffer.length,
    ContentType: "application/octet-stream",
    Metadata: { originalfilename: safeFileName(originalName) }
  }));
  return { key, fileName: safeFileName(originalName), size: buffer.length };
}

async function createDownloadUrl(key, fileName) {
  if (typeof key !== "string" || !/^schematics\\/[a-zA-Z0-9/_-]+\\.litematic$/.test(key)) {
    throw new Error("Invalid schematic storage key.");
  }
  const { s3, bucket } = client();
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: 'attachment; filename="' + safeFileName(fileName).replace(/"/g, "") + '"',
    ResponseContentType: "application/octet-stream"
  }), { expiresIn: 300 });
}

async function deleteSchematic(key) {
  if (typeof key !== "string" || !/^schematics\\/[a-zA-Z0-9/_-]+\\.litematic$/.test(key)) {
    throw new Error("Invalid schematic storage key.");
  }
  const { s3, bucket } = client();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = { MAX_SCHEMATIC_BYTES, testConnection, uploadSchematic, createDownloadUrl, deleteSchematic };
