import dotenv from "dotenv";
import mongoose from "mongoose";
import moment from "moment";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";

dotenv.config();

const args = process.argv.slice(2);

const flag = (name) => args.includes(name);

const getOption = (name, fallback = null) => {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return fallback;
  }
  return args[index + 1];
};

const dryRun = flag("--dry-run");
const force = flag("--force");
const targetYear = getOption("--year");
const limit = Number(getOption("--limit")) || null;
const baseMin = Number(getOption("--min")) || 8000;
const baseMax = Number(getOption("--max")) || 60000;

const usage = `Usage:
  node scripts/populate-dummy-slot-bookings.js [--dry-run] [--force] [--year <YYYY>] [--limit <number>] [--min <plants>] [--max <plants>]

Options:
  --dry-run     Log intended changes without updating the database
  --force       Overwrite slots that already contain booking data
  --year        Restrict updates to a specific slot year (defaults to all years)
  --limit       Maximum number of slots to update (useful for sampling)
  --min         Minimum booked plants to assign (default 8,000)
  --max         Maximum booked plants to assign (default 60,000)
`;

const randomInt = (min, max) => Math.round(Math.random() * (max - min) + min);

const monthWeight = (month) => {
  const ranges = {
    peak: ["September", "October", "November", "December"],
    mid: ["June", "July", "August"],
  };
  if (ranges.peak.includes(month)) return 1.1;
  if (ranges.mid.includes(month)) return 0.9;
  return 0.75;
};

const normalizeName = (value) => (value || "").trim().toLowerCase();

const resolveBookedPlants = (plantName, subtypeName, month) => {
  const base = randomInt(baseMin, baseMax);
  const weight = monthWeight(month);
  const plantBoost =
    normalizeName(plantName) === "papaya"
      ? 1.25
      : normalizeName(plantName) === "watermelon"
        ? 1.1
        : 1;
  const subtypeBoost = normalizeName(subtypeName).includes("elite") ? 1.15 : 1;
  return Math.round(base * weight * plantBoost * subtypeBoost);
};

const computeSowed = (total, ratioRange = [0.25, 0.65]) => {
  const [minRatio, maxRatio] = ratioRange;
  const ratio = Math.random() * (maxRatio - minRatio) + minRatio;
  return Math.min(total - 200, Math.max(0, Math.round(total * ratio)));
};

const chunk = (array, size = 200) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

const summarize = (collection) => {
  const summary = {};
  collection.forEach((item) => {
    const key = item.plantName;
    if (!summary[key]) {
      summary[key] = { slots: 0, plants: 0, pending: 0 };
    }
    summary[key].slots += 1;
    summary[key].plants += item.totalBookedPlants;
    summary[key].pending += item.totalBookedPlants - item.primarySowed;
  });
  return summary;
};

const withObjectId = (value) => {
  try {
    return new mongoose.Types.ObjectId(value);
  } catch (error) {
    return null;
  }
};

const run = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }

    await mongoose.connect(uri);
    console.log("✅ Connected to database");

    const plants = await PlantCms.find({ sowingAllowed: true })
      .select({ name: 1, subtypes: 1 })
      .lean();

    if (!plants.length) {
      console.log("⚠️ No sowing-allowed plants found. Exiting.");
      return;
    }

    const plantMap = new Map(
      plants.map((plant) => [
        plant._id.toString(),
        {
          name: plant.name,
          subtypeLookup: new Map(
            plant.subtypes.map((subtype) => [subtype._id.toString(), subtype.name]),
          ),
        },
      ]),
    );

    const slotQuery = { plantId: { $in: plants.map((plant) => plant._id) } };
    if (targetYear) {
      slotQuery.year = Number(targetYear);
    }

    const slotDocs = await PlantSlot.find(slotQuery).lean();
    console.log(
      `📊 Loaded ${slotDocs.length} slot documents for ${
        plantMap.size
      } sowing-allowed plants${targetYear ? ` in ${targetYear}` : ""}.`,
    );

    const updates = [];
    const preview = [];

    slotDocs.forEach((doc) => {
      const plantInfo = plantMap.get(doc.plantId.toString());
      if (!plantInfo) {
        return;
      }

      (doc.subtypeSlots || []).forEach((subtypeGroup) => {
        const subtypeName =
          plantInfo.subtypeLookup.get(subtypeGroup.subtypeId.toString()) || "Unknown subtype";

        (subtypeGroup.slots || []).forEach((slot) => {
          if (!force && slot.totalBookedPlants && slot.totalBookedPlants > 0) {
            return;
          }
          if (limit && preview.length >= limit) {
            return;
          }

          const totalBookedPlants = resolveBookedPlants(
            plantInfo.name,
            subtypeName,
            slot.month || "January",
          );
          const primarySowed = computeSowed(totalBookedPlants);
          const officeSowed = Math.round(primarySowed * (Math.random() * 0.4));
          const plantsSowed = primarySowed + officeSowed;

          const update = {
            plantId: doc.plantId,
            plantName: plantInfo.name,
            subtypeId: subtypeGroup.subtypeId,
            subtypeName,
            slotId: slot._id,
            totalBookedPlants,
            primarySowed,
            officeSowed,
            plantsSowed,
            month: slot.month,
            year: doc.year,
            sowByDate: (() => {
              const startMoment = moment(slot.startDay, "DD-MM-YYYY");
              const readyDays = slot.plantReadyDays || 0;
              return readyDays > 0
                ? startMoment.clone().subtract(readyDays, "days").format("DD-MM-YYYY")
                : startMoment.format("DD-MM-YYYY");
            })(),
          };

          preview.push(update);

          updates.push({
            updateOne: {
              filter: { _id: doc._id },
              update: {
                $set: {
                  "subtypeSlots.$[st].slots.$[sl].totalBookedPlants": totalBookedPlants,
                  "subtypeSlots.$[st].slots.$[sl].primarySowed": primarySowed,
                  "subtypeSlots.$[st].slots.$[sl].officeSowed": officeSowed,
                  "subtypeSlots.$[st].slots.$[sl].plantsSowed": plantsSowed,
                },
              },
              arrayFilters: [
                { "st.subtypeId": subtypeGroup.subtypeId },
                { "sl._id": withObjectId(slot._id) || slot._id },
              ],
            },
          });
        });
      });
    });

    if (!updates.length) {
      console.log("ℹ️ No slots required dummy data. Nothing to do.");
      return;
    }

    console.log(
      `🧪 Prepared dummy data for ${preview.length} slots across ${new Set(
        preview.map((item) => item.plantId.toString()),
      ).size} plants.`,
    );

    const summary = summarize(preview);
    Object.entries(summary).forEach(([plantName, stats]) => {
      console.log(
        `   • ${plantName}: ${stats.slots} slot(s), ${stats.plants.toLocaleString()} booked, ${stats.pending.toLocaleString()} pending`,
      );
    });

    if (dryRun) {
      console.log("\n🔍 Dry run enabled — no changes were written to the database.");
      return;
    }

    console.log("\n✍️ Writing updates to database...");
    const chunks = chunk(updates, 250);
    for (const [index, batch] of chunks.entries()) {
      const result = await PlantSlot.bulkWrite(batch, { ordered: false });
      console.log(
        `   Batch ${index + 1}/${chunks.length}: ${result.modifiedCount} slot(s) updated.`,
      );
    }

    console.log("\n✅ Dummy slot bookings populated successfully.");
    console.log("   Re-run sowing alert APIs and UI to verify aggregated outputs.");
  } catch (error) {
    console.error("❌ Error populating dummy slot bookings:", error.message);
    console.error(error);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from database");
  }
};

if (flag("--help")) {
  console.log(usage);
} else {
  run();
}

