/**
 * Prod shade sync:
 * - Rename shaded polyhouses to "English (Marathi)" from stock sheet 18/8/26
 * - Add Primary 1–9 with is_primary: true
 * - Mark shaded rows is_primary: false
 *
 * Usage:
 *   node scripts/update-shaded-names-prod.mjs           # dry-run
 *   node scripts/update-shaded-names-prod.mjs --apply   # write PROD
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");

const MARATHI_DIGITS = ["०", "१", "२", "३", "४", "५", "६", "७", "८", "९"];

/** Shaded polyhouse number → display name. */
const SHADED_NAME_BY_NUMBER = {
  "1": "Sinhagad (सिंहगड)",
  "2": "Raigad (रायगड)",
  "4": "Pratapgad (प्रतापगड)",
  "5": "Torna (तोरणा)",
  "6": "Purandar (पुरंदर)",
  "7": "Rajgad (राजगड)",
  "8": "Devgiri (देवगिरी)",
  "12": "12 no (12 no)",
  "23": "23 no (विशाल गड)",
};

/** Primary shed rows P1–P9 (unique number keys). */
const PRIMARY_SHADES = Array.from({ length: 9 }, (_, i) => {
  const n = i + 1;
  const marathi = `प्राइमरी ${String(n)
    .split("")
    .map((d) => MARATHI_DIGITS[Number(d)])
    .join("")}`;
  return {
    number: `P${n}`,
    name: `Primary ${n} (${marathi})`,
    is_primary: true,
  };
});

function uri() {
  const url = process.env.PROD_MONGO_URL;
  if (!url) throw new Error("PROD_MONGO_URL missing in .env");
  return url;
}

async function main() {
  console.log(APPLY ? "=== APPLY mode (PROD) ===" : "=== DRY RUN (no writes) ===");
  await mongoose.connect(uri());
  const col = mongoose.connection.db.collection("shades");

  let shadedUpdates = 0;
  let shadedSkips = 0;
  let primaryCreates = 0;
  let primaryUpdates = 0;
  let primarySkips = 0;

  const shadedNumbers = Object.keys(SHADED_NAME_BY_NUMBER);
  const shadedDocs = await col.find({ number: { $in: shadedNumbers } }).sort({ number: 1 }).toArray();
  const foundShaded = new Set(shadedDocs.map((s) => String(s.number)));
  const missingShaded = shadedNumbers.filter((n) => !foundShaded.has(n));
  if (missingShaded.length) {
    console.warn("WARNING: shaded numbers not found:", missingShaded.join(", "));
  }

  console.log("\n--- Shaded name updates ---");
  for (const shade of shadedDocs) {
    const num = String(shade.number);
    const newName = SHADED_NAME_BY_NUMBER[num];
    const oldName = String(shade.name || "").trim();
    const needsName = oldName !== newName;
    const needsFlag = shade.is_primary !== false;

    if (!needsName && !needsFlag) {
      console.log(`[skip] #${num} "${newName}"`);
      shadedSkips++;
      continue;
    }

    const parts = [];
    if (needsName) parts.push(`name "${oldName}" → "${newName}"`);
    if (needsFlag) parts.push("is_primary → false");
    console.log(`[update] #${num}: ${parts.join(", ")}`);
    shadedUpdates++;

    if (APPLY) {
      await col.updateOne(
        { _id: shade._id },
        { $set: { name: newName, is_primary: false } }
      );
    }
  }

  console.log("\n--- Primary 1–9 ---");
  for (const primary of PRIMARY_SHADES) {
    const existing = await col.findOne({ number: primary.number });
    if (existing) {
      const needsName = String(existing.name || "").trim() !== primary.name;
      const needsFlag = existing.is_primary !== true;
      if (!needsName && !needsFlag) {
        console.log(`[skip] ${primary.number} "${primary.name}"`);
        primarySkips++;
        continue;
      }
      const parts = [];
      if (needsName) {
        parts.push(`name "${existing.name}" → "${primary.name}"`);
      }
      if (needsFlag) parts.push("is_primary → true");
      console.log(`[update] ${primary.number}: ${parts.join(", ")}`);
      primaryUpdates++;
      if (APPLY) {
        await col.updateOne(
          { _id: existing._id },
          { $set: { name: primary.name, is_primary: true, isActive: true } }
        );
      }
      continue;
    }

    console.log(`[create] ${primary.number}: "${primary.name}" (is_primary: true)`);
    primaryCreates++;
    if (APPLY) {
      await col.insertOne({
        name: primary.name,
        number: primary.number,
        is_primary: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Shaded: ${shadedUpdates} update(s), ${shadedSkips} unchanged`);
  console.log(`Primary: ${primaryCreates} create(s), ${primaryUpdates} update(s), ${primarySkips} unchanged`);
  if (!APPLY && (shadedUpdates > 0 || primaryCreates > 0)) {
    console.log("Re-run with --apply to write changes.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
