/**
 * Write papaya / melon ceilings onto the four sowing sheds.
 * The fort name wins over the shade number, same as the smart-shed API.
 *
 *   node scripts/seed-smart-shed-capacity.mjs           # dry-run
 *   node scripts/seed-smart-shed-capacity.mjs --apply   # write
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import Shade from "../models/shadeSchema.model.js";
import { ceilingsFor, fortForShade } from "../utility/smartShedSpace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");

function uri() {
  const isProd = process.env.NODE_ENV === "production";
  const url = isProd
    ? process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI
    : process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI;
  if (!url) throw new Error("Set MONGO_URL or STAGE_MONGO_URL (or PROD_MONGO_URL in production)");
  return url;
}

async function main() {
  console.log(APPLY ? "=== APPLY — smart shed ceilings ===" : "=== DRY RUN — smart shed ceilings ===");
  await mongoose.connect(uri());
  const shades = await Shade.find().select("name number smartCapacity").lean();
  let writes = 0;
  for (const shade of shades) {
    const fort = fortForShade(shade);
    if (!fort) continue;
    const next = ceilingsFor(fort, null);
    const currentPapaya = Number(shade.smartCapacity?.papaya) || 0;
    const currentMelon = Number(shade.smartCapacity?.melon) || 0;
    const same = currentPapaya === next.papayaMax && currentMelon === next.melonMax;
    console.log(
      `${same ? "[keep]" : "[set]"} #${shade.number} "${shade.name}" → ${fort.label} papaya ${next.papayaMax} melon ${next.melonMax}`
    );
    if (same || !APPLY) continue;
    await Shade.updateOne(
      { _id: shade._id },
      { $set: { "smartCapacity.papaya": next.papayaMax, "smartCapacity.melon": next.melonMax } }
    );
    writes += 1;
  }
  console.log(APPLY ? `Updated ${writes} shade(s).` : "Dry run only. Pass --apply to write.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
