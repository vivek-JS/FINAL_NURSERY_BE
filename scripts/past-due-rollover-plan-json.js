/** stdout JSON plan only — used by past-due-rollover-report.js */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const flag = process.argv[2];
const mongoUrl =
  flag === "--prod"
    ? process.env.PROD_MONGO_URL
    : flag === "--stage"
      ? process.env.STAGE_MONGO_URL
      : process.env.MONGO_URL;

if (!mongoUrl) process.exit(2);

await mongoose.connect(mongoUrl, {
  serverSelectionTimeoutMS: 60_000,
  socketTimeoutMS: 300_000,
});
const { planPastDueSlotRollover } = await import(
  "../services/pastDueSlotRollover.service.js"
);
const plan = await planPastDueSlotRollover({ onProgress: () => {} });
await mongoose.disconnect();
process.stdout.write(JSON.stringify(plan));
