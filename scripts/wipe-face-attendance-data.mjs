/**
 * Wipes all face-attendance data (records, daily rollups, attempts, face profiles,
 * devices, legacy embeddings). Optionally clears selfie folders on disk.
 *
 * Usage:
 *   node scripts/wipe-face-attendance-data.mjs --confirm
 *   node scripts/wipe-face-attendance-data.mjs --prod-db --confirm
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const USE_PROD = process.argv.includes("--prod-db");
const CONFIRM = process.argv.includes("--confirm");
const CLEAR_UPLOADS = !process.argv.includes("--keep-uploads");
const RESET_FACE_STATUS = !process.argv.includes("--keep-face-status");

function resolveMongoUrl() {
  if (USE_PROD) {
    if (!process.env.PROD_MONGO_URL) throw new Error("PROD_MONGO_URL is not set");
    return process.env.PROD_MONGO_URL;
  }
  const url = process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI;
  if (!url) throw new Error("MONGO_URL (or STAGE_MONGO_URL / MONGODB_URI) is not set");
  return url;
}

function confirmProd() {
  if (!USE_PROD || CONFIRM) return Promise.resolve(CONFIRM);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("⚠️  --prod-db: type 'yes' to WIPE ALL face attendance on PRODUCTION: ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

function rmDirIfExists(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  removed ${dir}`);
  }
}

async function main() {
  if (!CONFIRM && !USE_PROD) {
    console.error("Pass --confirm to wipe attendance data (add --prod-db for production).");
    process.exit(1);
  }

  const ok = await confirmProd();
  if (!ok) {
    console.log("Aborted.");
    process.exit(0);
  }

  const mongoUrl = resolveMongoUrl();
  const label = USE_PROD ? "PRODUCTION" : "local/stage";
  console.log(`Connecting to ${label} MongoDB…`);
  await mongoose.connect(mongoUrl);

  const collections = [
    { name: "attendancerecords", label: "AttendanceRecord" },
    { name: "attendancedailies", label: "AttendanceDaily" },
    { name: "attendanceattempts", label: "AttendanceAttempt" },
    { name: "employeefaceprofiles", label: "EmployeeFaceProfile" },
    { name: "faceembeddings", label: "FaceEmbedding (legacy)" },
    { name: "employeedevices", label: "EmployeeDevice" },
    { name: "attendances", label: "Attendance (legacy ERP)" },
  ];

  console.log("Deleting collections…");
  for (const { name, label: colLabel } of collections) {
    try {
      const result = await mongoose.connection.db.collection(name).deleteMany({});
      console.log(`  ${colLabel}: ${result.deletedCount} docs`);
    } catch (err) {
      console.warn(`  ${colLabel}: skipped (${err.message})`);
    }
  }

  if (RESET_FACE_STATUS) {
    const { default: User } = await import("../models/user.model.js");
    const faceReset = await User.updateMany(
      { faceRegistrationStatus: { $exists: true } },
      { $set: { faceRegistrationStatus: "NOT_REGISTERED" }, $unset: { faceConsentAt: "" } }
    );
    console.log(`  User face status reset: ${faceReset.modifiedCount} users`);
  }

  if (CLEAR_UPLOADS) {
    const uploadsRoot = path.join(__dirname, "../uploads");
    console.log("Clearing attendance selfie folders…");
    rmDirIfExists(path.join(uploadsRoot, "attendance-selfies"));
    rmDirIfExists(path.join(uploadsRoot, "kiosk-attendance"));
    rmDirIfExists(path.join(uploadsRoot, "face-registrations"));
  }

  await mongoose.disconnect();
  console.log("Done — all face attendance data wiped.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
