#!/usr/bin/env node
/**
 * CLI: create a complete local database backup (same logic as POST /api/v1/backup/create).
 * Usage: npm run backup
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { createCompleteBackup } from "../services/backup.service.js";

dotenv.config();

function resolveMongoUrl() {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    return (
      process.env.PROD_MONGO_URL ||
      process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      ""
    );
  }
  return (
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL ||
    process.env.MONGODB_URI ||
    ""
  );
}

async function main() {
  const mongoUrl = resolveMongoUrl();
  if (!mongoUrl) {
    console.error("Missing MongoDB URI in environment.");
    process.exit(1);
  }

  await mongoose.connect(mongoUrl);
  console.log("Connected to MongoDB. Creating backup…");

  const result = await createCompleteBackup();

  console.log("Backup complete:");
  console.log(`  File: ${result.filename}`);
  console.log(`  Size: ${result.sizeFormatted}`);
  console.log(`  Method: ${result.method}`);
  console.log(`  Path: ${result.path}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Backup failed:", err.message || err);
  process.exit(1);
});
