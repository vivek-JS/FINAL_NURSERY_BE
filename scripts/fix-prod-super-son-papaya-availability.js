import dotenv from "dotenv";
import mongoose from "mongoose";

import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";

dotenv.config();

const args = process.argv.slice(2);
const hasArg = (name) => args.includes(name);

const dryRun = hasArg("--dry-run");
const execute = hasArg("--execute");
const yes = hasArg("--yes");
const prodDb = hasArg("--prod-db");

if (!dryRun && !execute) {
  console.error("Pass either `--dry-run` or (`--execute --yes --prod-db`).");
  process.exit(1);
}

if (execute && !yes) {
  console.error("Refusing to execute without `--yes`.");
  process.exit(1);
}

if (execute && !prodDb) {
  console.error("Refusing to execute without `--prod-db`.");
  process.exit(1);
}

const mongoUrl = prodDb ? process.env.PROD_MONGO_URL : process.env.MONGO_URL;
if (!mongoUrl) {
  console.error(`Missing ${prodDb ? "PROD_MONGO_URL" : "MONGO_URL"} in env.`);
  process.exit(1);
}

const plantPattern = /papaya/i;
const subtypePattern = /super\s*son/i;

function printHeader(label) {
  console.log(`\n=== ${label} ===`);
}

function describeDb() {
  const { name, host, port } = mongoose.connection;
  console.log(`DB: ${name}@${host}:${port}`);
}

async function resolvePapayaSubtype() {
  const plants = await PlantCms.find({ name: plantPattern })
    .select("_id name subtypes")
    .lean();

  for (const plant of plants) {
    const subtype = (plant.subtypes || []).find((item) => subtypePattern.test(item.name || ""));
    if (subtype) {
      return {
        plantId: plant._id,
        plantName: plant.name,
        subtypeId: subtype._id,
        subtypeName: subtype.name,
      };
    }
  }

  return null;
}

async function collectMatchingSlots({ plantId, subtypeId }) {
  const docs = await PlantSlot.find({
    plantId,
    "subtypeSlots.subtypeId": subtypeId,
  })
    .select("_id year subtypeSlots")
    .lean();

  const matches = [];

  for (const doc of docs) {
    const subtypeSlot = (doc.subtypeSlots || []).find(
      (item) => String(item.subtypeId) === String(subtypeId)
    );
    if (!subtypeSlot?.slots?.length) continue;

    for (const slot of subtypeSlot.slots) {
      if (Number(slot.availablePlants) === 1) {
        matches.push({
          plantSlotId: String(doc._id),
          year: doc.year,
          subtypeId: String(subtypeId),
          slotId: String(slot._id),
          startDay: slot.startDay,
          endDay: slot.endDay,
          beforeAvailablePlants: Number(slot.availablePlants) || 0,
          afterAvailablePlants: 0,
        });
      }
    }
  }

  return matches;
}

async function applyTargetedUpdate(matches) {
  const matchesByDoc = new Map();

  for (const match of matches) {
    if (!matchesByDoc.has(match.plantSlotId)) {
      matchesByDoc.set(match.plantSlotId, []);
    }
    matchesByDoc.get(match.plantSlotId).push(match.slotId);
  }

  let updatedSlots = 0;
  for (const [plantSlotId, slotIds] of matchesByDoc.entries()) {
    const plantSlotDoc = await PlantSlot.findById(plantSlotId);
    if (!plantSlotDoc) continue;

    let touched = 0;
    for (const subtypeSlot of plantSlotDoc.subtypeSlots || []) {
      for (const slot of subtypeSlot.slots || []) {
        if (slotIds.includes(String(slot._id)) && Number(slot.availablePlants) === 1) {
          slot.availablePlants = 0;
          touched += 1;
          updatedSlots += 1;
        }
      }
    }

    if (touched > 0) {
      plantSlotDoc.markModified("subtypeSlots");
      await plantSlotDoc.save();
    }
  }

  return updatedSlots;
}

async function verifyRemaining({ plantId, subtypeId }) {
  const remaining = await collectMatchingSlots({ plantId, subtypeId });
  return remaining;
}

async function main() {
  await mongoose.connect(mongoUrl, {
    serverSelectionTimeoutMS: 20000,
  });

  describeDb();
  printHeader(dryRun ? "DRY RUN" : "EXECUTE");

  const target = await resolvePapayaSubtype();
  if (!target) {
    throw new Error("Could not resolve Papaya + Super Son subtype in PlantCms.");
  }

  console.log(`Plant: ${target.plantName} (${target.plantId})`);
  console.log(`Subtype: ${target.subtypeName} (${target.subtypeId})`);

  const matches = await collectMatchingSlots(target);
  console.log(`\nMatched slots with availablePlants = 1: ${matches.length}`);

  if (matches.length > 0) {
    matches.forEach((match, index) => {
      console.log(
        `${index + 1}. year=${match.year} slotId=${match.slotId} ${match.startDay} -> ${match.endDay} availablePlants ${match.beforeAvailablePlants} -> ${match.afterAvailablePlants}`
      );
    });
  }

  if (dryRun) {
    console.log("\nDRY RUN: no data modified.");
    console.log("To execute on prod: node scripts/fix-prod-super-son-papaya-availability.js --prod-db --execute --yes");
    await mongoose.disconnect();
    return;
  }

  const updatedCount = await applyTargetedUpdate(matches);
  console.log(`\nUpdated slots: ${updatedCount}`);

  const remaining = await verifyRemaining(target);
  console.log(`Remaining matched slots after update: ${remaining.length}`);

  if (remaining.length > 0) {
    console.log("Remaining slots:");
    remaining.forEach((match) => {
      console.log(`- year=${match.year} slotId=${match.slotId} ${match.startDay} -> ${match.endDay}`);
    });
    throw new Error("Verification failed: some targeted slots still have availablePlants = 1");
  }

  console.log("\nVerification passed. No targeted slots remain at availablePlants = 1.");
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Script failed:", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect failure
  }
  process.exit(1);
});
