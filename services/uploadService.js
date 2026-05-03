import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * Upload PDF bytes to DigitalOcean Spaces (S3-compatible) or fallback mock URL.
 *
 * Required for Spaces (set all of these):
 * - DO_SPACES_KEY          — Spaces access key
 * - DO_SPACES_SECRET       — Spaces secret key
 * - DO_SPACES_BUCKET       — bucket name
 * - DO_SPACES_REGION       — e.g. blr1, nyc3
 *
 * Optional:
 * - DO_SPACES_ENDPOINT     — default https://{region}.digitaloceanspaces.com
 * - DO_SPACES_PUBLIC_BASE  — public URL prefix for objects (no trailing slash).
 *     Default: https://{bucket}.{region}.digitaloceanspaces.com
 *     Use if you use a custom CDN domain: https://cdn.example.com/bucket-path
 *
 * @param {Buffer} fileBuffer
 * @param {string} [filename]
 * @returns {Promise<string>} HTTPS URL WATI can GET
 */
export async function uploadToS3(fileBuffer, filename = "today-booking-report.pdf") {
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    throw new Error("uploadToS3: fileBuffer must be a Buffer");
  }

  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "report.pdf";
  const key = `booking-reports/${Date.now()}-${safeName}`;

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
    console.log(
      `[uploadService] Spaces upload OK (${(fileBuffer.length / 1024).toFixed(1)} KB) → ${url}`
    );
    return url;
  }

  // Dev / missing Spaces config — mock URL (WATI cannot fetch unless you point PUBLIC_REPORT_BASE_URL at a real host)
  const base =
    process.env.PUBLIC_REPORT_BASE_URL?.replace(/\/+$/, "") ||
    "https://mock-reports.example.com";
  const url = `${base}/${Date.now()}-${safeName}`;
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[uploadService] Spaces not configured (set DO_SPACES_*); mock URL: ${url}`
    );
  } else {
    console.warn(
      "[uploadService] Production without DO_SPACES_* — set DigitalOcean Spaces env vars for real PDF URLs."
    );
  }
  return url;
}
