import fs from "fs/promises";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/** Fake / unreachable hosts that must never be treated as real PDF URLs. */
export function isUnusablePublicFileUrl(url) {
  const u = String(url || "").trim();
  if (!u) return true;
  if (!/^https?:\/\//i.test(u)) return true;
  return /mock-reports\.example\.com|example\.com|YOUR_DOMAIN|localhost|127\.0\.0\.1/i.test(u);
}

function publicApiBase() {
  return String(
    process.env.PUBLIC_REPORT_BASE_URL ||
      process.env.BASE_URL ||
      process.env.API_PUBLIC_URL ||
      ""
  )
    .trim()
    .replace(/\/+$/, "");
}

/**
 * Persist PDF on local disk under uploads/ and return a reachable API URL.
 * Used when DigitalOcean Spaces is not configured (prod currently has no DO_SPACES_*).
 */
async function uploadToLocalUploads(fileBuffer, key) {
  const base = publicApiBase();
  if (!base || isUnusablePublicFileUrl(`${base}/x`)) {
    throw new Error(
      "File storage not configured: set DO_SPACES_* or a valid BASE_URL (e.g. https://api1.rambiotechplants.com)"
    );
  }

  const uploadsRoot = path.join(process.cwd(), "uploads");
  const fullPath = path.join(uploadsRoot, key);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, fileBuffer);

  const encodedKey = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = `${base}/uploads/${encodedKey}`;
  console.log(
    `[uploadService] Local upload OK (${(fileBuffer.length / 1024).toFixed(1)} KB) → ${url}`
  );
  return url;
}

/**
 * Upload PDF bytes to DigitalOcean Spaces (S3-compatible) or local /uploads fallback.
 *
 * For dispatch DC / invoice PDFs, pass the third argument `{ folder: "dispatch-pdfs/<dispatchId>" }`
 * so objects are grouped under `dispatch-pdfs/…`.
 *
 * Spaces (preferred when set):
 * - DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET, DO_SPACES_REGION
 *
 * Fallback when Spaces missing:
 * - Writes under `uploads/<folder>/…` and returns `${BASE_URL}/uploads/...`
 *   (express serves `/uploads` statically).
 *
 * @param {Buffer} fileBuffer
 * @param {string} [filename]
 * @param {{ folder?: string }} [options]
 * @returns {Promise<string>} HTTPS URL
 */
export async function uploadToS3(
  fileBuffer,
  filename = "today-booking-report.pdf",
  options = {}
) {
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    throw new Error("uploadToS3: fileBuffer must be a Buffer");
  }

  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "report.pdf";
  const folderRaw =
    options && typeof options.folder === "string" && options.folder.trim() !== ""
      ? options.folder.trim().replace(/^\/+|\/+$/g, "")
      : "booking-reports";
  const folder = folderRaw || "booking-reports";
  const key = `${folder}/${Date.now()}-${safeName}`;

  const accessKey = process.env.DO_SPACES_KEY;
  const secretKey = process.env.DO_SPACES_SECRET;
  const bucket = process.env.DO_SPACES_BUCKET;
  const region = process.env.DO_SPACES_REGION;

  if (accessKey && secretKey && bucket && region) {
    const endpoint =
      process.env.DO_SPACES_ENDPOINT?.replace(/\/+$/, "") ||
      `https://${region}.digitaloceanspaces.com`;

    const client = new S3Client({
      region: "us-east-1",
      endpoint,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: false,
    });

    /** Object ACL; omit if your Space rejects ACLs (use bucket policy + CDN instead). */
    const putInput = {
      Bucket: bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: "application/pdf",
      CacheControl: "public, max-age=86400",
    };
    if (process.env.DO_SPACES_OBJECT_ACL !== "none") {
      putInput.ACL = "public-read";
    }

    await client.send(new PutObjectCommand(putInput));

    const publicBase =
      process.env.DO_SPACES_PUBLIC_BASE?.replace(/\/+$/, "") ||
      `https://${bucket}.${region}.digitaloceanspaces.com`;

    const url = `${publicBase}/${encodeURI(key)}`;
    if (isUnusablePublicFileUrl(url)) {
      throw new Error("Spaces returned an unusable public URL — check DO_SPACES_PUBLIC_BASE");
    }
    console.log(
      `[uploadService] Spaces upload OK (${(fileBuffer.length / 1024).toFixed(1)} KB) → ${url}`
    );
    return url;
  }

  // No Spaces — save under /uploads and expose via BASE_URL (never mock-reports.example.com)
  console.warn(
    "[uploadService] DO_SPACES_* not set — using local uploads/ + BASE_URL fallback"
  );
  return uploadToLocalUploads(fileBuffer, key);
}
