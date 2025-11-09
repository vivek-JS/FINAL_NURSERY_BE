import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import { generateSlotsForYear } from "../controllers/slots.controller.js";

const TARGET_YEARS = [2025, 2026];

const PLANT_DEFINITIONS = [
  {
    name: "Papaya",
    slotSize: 7,
    plantReadyDays: 40,
    sowingAllowed: true,
    subtypes: ["15 no", "Taiwan", "W-46"],
  },
  {
    name: "Watermelon",
    slotSize: 1,
    plantReadyDays: 18,
    sowingAllowed: true,
    subtypes: [
      "Bahubali Plus",
      "Candy",
      "Force-9",
      "Impact",
      "Maxx",
      "Prachand",
      "Redking",
      "Simbha",
      "Vijay",
    ],
  },
];

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeName = (value) =>
  (value ?? "").toString().trim();

const findSubtype = (plantDoc, targetName) => {
  const needle = normalizeName(targetName).toLowerCase();
  return (plantDoc.subtypes || []).find(
    (subtype) => normalizeName(subtype.name).toLowerCase() === needle
  );
};

const buildSlotTemplates = (year, slotSize, plantReadyDays) => {
  const baseSlots = generateSlotsForYear(year, slotSize);

  return baseSlots.map((slot) => ({
    ...slot,
    totalPlants: slot.totalPlants ?? 0,
    totalBookedPlants: slot.totalBookedPlants ?? 0,
    availablePlants: 0,
    buffer: slot.buffer ?? 0,
    effectiveBuffer: 0,
    bufferAdjustedCapacity: 0,
    bufferAmount: 0,
    originalTotalPlants: 0,
    isOverflow: slot.isOverflow ?? false,
    overflow: slot.overflow ?? false,
    status: true,
    plantReadyDays,
    plantsSowed: 0,
    officeSowed: 0,
    primarySowed: 0,
    sowingDate: null,
    plantReadyDate: null,
    reminderBeforePlantReadyDays: 0,
    orders: Array.isArray(slot.orders) ? slot.orders : [],
    allowedSalesmen: Array.isArray(slot.allowedSalesmen)
      ? slot.allowedSalesmen
      : [],
    restrictToSalesmen:
      typeof slot.restrictToSalesmen === "boolean"
        ? slot.restrictToSalesmen
        : false,
    isManual: false,
  }));
};

const connectDB = async () => {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGO_URL or MONGODB_URI environment variable is required."
    );
  }

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");
};

const ensurePlantDefinition = async (definition) => {
  const summary = {
    plantName: definition.name,
    createdPlant: false,
    updatedSlotSize: false,
    updatedSowingAllowed: false,
    addedSubtypes: [],
    updatedSubtypeReadyDays: [],
    createdSlotYears: [],
    addedSubtypeSlots: [],
    resetSubtypeSlots: [],
    updatedSlotMetadata: [],
    refreshedSlotYears: new Set(),
  };

  const nameRegex = new RegExp(`^${escapeRegExp(definition.name)}$`, "i");

  let plant = await PlantCms.findOne({ name: nameRegex });

  if (!plant) {
    const subtypes = definition.subtypes
      .map((subtype) => normalizeName(subtype))
      .filter(Boolean)
      .map((name) => ({
        name,
        plantReadyDays: definition.plantReadyDays,
      }));

    plant = new PlantCms({
      name: definition.name,
      slotSize: definition.slotSize,
      sowingAllowed: definition.sowingAllowed,
      subtypes,
    });

    await plant.save();
    summary.createdPlant = true;
  } else {
    let plantDirty = false;

    if (plant.slotSize !== definition.slotSize) {
      plant.slotSize = definition.slotSize;
      summary.updatedSlotSize = true;
      plantDirty = true;
    }

    if (definition.sowingAllowed && !plant.sowingAllowed) {
      plant.sowingAllowed = true;
      summary.updatedSowingAllowed = true;
      plantDirty = true;
    }

    for (const subtypeName of definition.subtypes) {
      const normalizedName = normalizeName(subtypeName);
      if (!normalizedName) continue;

      const existingSubtype = findSubtype(plant, normalizedName);
      if (!existingSubtype) {
        plant.subtypes.push({
          name: normalizedName,
          plantReadyDays: definition.plantReadyDays,
        });
        summary.addedSubtypes.push(normalizedName);
        plantDirty = true;
      } else if (
        existingSubtype.plantReadyDays !== definition.plantReadyDays
      ) {
        existingSubtype.plantReadyDays = definition.plantReadyDays;
        summary.updatedSubtypeReadyDays.push(normalizedName);
        plantDirty = true;
      }
    }

    if (plantDirty) {
      await plant.save();
    }
  }

  plant = await PlantCms.findById(plant._id);

  for (const year of TARGET_YEARS) {
    let slotDoc = await PlantSlot.findOne({
      plantId: plant._id,
      year,
    });

    if (!slotDoc) {
      const subtypeSlots = (plant.subtypes || []).map((subtype) => ({
        subtypeId: subtype._id,
        slots: buildSlotTemplates(
          year,
          definition.slotSize,
          definition.plantReadyDays
        ),
      }));

      await PlantSlot.create({
        plantId: plant._id,
        year,
        subtypeSlots,
      });

      summary.createdSlotYears.push(year);
      continue;
    }

    let slotDocDirty = false;

    for (const subtype of plant.subtypes || []) {
      const subtypeId = subtype._id?.toString();
      if (!subtypeId) continue;

      let subtypeSlotEntry = slotDoc.subtypeSlots.find(
        (entry) => entry.subtypeId?.toString() === subtypeId
      );

      if (!subtypeSlotEntry) {
        slotDoc.subtypeSlots.push({
          subtypeId: subtype._id,
          slots: buildSlotTemplates(
            year,
            definition.slotSize,
            definition.plantReadyDays
          ),
        });
        slotDocDirty = true;
        summary.addedSubtypeSlots.push(`${subtype.name} (${year})`);
        continue;
      }

      if (!Array.isArray(subtypeSlotEntry.slots)) {
        subtypeSlotEntry.slots = [];
      }

      if (subtypeSlotEntry.slots.length === 0) {
        subtypeSlotEntry.slots = buildSlotTemplates(
          year,
          definition.slotSize,
          definition.plantReadyDays
        );
        slotDocDirty = true;
        summary.resetSubtypeSlots.push(`${subtype.name} (${year})`);
        continue;
      }

      let slotsAdjusted = false;

      for (const slot of subtypeSlotEntry.slots) {
        if (slot.plantReadyDays !== definition.plantReadyDays) {
          slot.plantReadyDays = definition.plantReadyDays;
          slotsAdjusted = true;
        }

        if (slot.availablePlants == null) {
          slot.availablePlants = 0;
          slotsAdjusted = true;
        }

        if (slot.effectiveBuffer == null) {
          slot.effectiveBuffer = 0;
          slotsAdjusted = true;
        }

        if (slot.bufferAdjustedCapacity == null) {
          slot.bufferAdjustedCapacity = 0;
          slotsAdjusted = true;
        }

        if (slot.bufferAmount == null) {
          slot.bufferAmount = 0;
          slotsAdjusted = true;
        }

        if (slot.originalTotalPlants == null) {
          slot.originalTotalPlants = 0;
          slotsAdjusted = true;
        }

        if (slot.isOverflow == null) {
          slot.isOverflow = false;
          slotsAdjusted = true;
        }

        if (!Array.isArray(slot.orders)) {
          slot.orders = [];
          slotsAdjusted = true;
        }

        if (!Array.isArray(slot.allowedSalesmen)) {
          slot.allowedSalesmen = [];
          slotsAdjusted = true;
        }

        if (typeof slot.restrictToSalesmen !== "boolean") {
          slot.restrictToSalesmen = false;
          slotsAdjusted = true;
        }

        if (slot.status == null) {
          slot.status = true;
          slotsAdjusted = true;
        }

        if (slot.plantsSowed == null) {
          slot.plantsSowed = 0;
          slotsAdjusted = true;
        }

        if (slot.officeSowed == null) {
          slot.officeSowed = 0;
          slotsAdjusted = true;
        }

        if (slot.primarySowed == null) {
          slot.primarySowed = 0;
          slotsAdjusted = true;
        }

        if (slot.sowingDate === undefined) {
          slot.sowingDate = null;
          slotsAdjusted = true;
        }

        if (slot.plantReadyDate === undefined) {
          slot.plantReadyDate = null;
          slotsAdjusted = true;
        }

        if (slot.reminderBeforePlantReadyDays == null) {
          slot.reminderBeforePlantReadyDays = 0;
          slotsAdjusted = true;
        }

        if (slot.isManual == null) {
          slot.isManual = false;
          slotsAdjusted = true;
        }
      }

      if (slotsAdjusted) {
        slotDocDirty = true;
        summary.updatedSlotMetadata.push(`${subtype.name} (${year})`);
      }
    }

    if (slotDocDirty) {
      slotDoc.markModified("subtypeSlots");
      await slotDoc.save();
      summary.refreshedSlotYears.add(year);
    }
  }

  return summary;
};

const run = async () => {
  try {
    await connectDB();

    const summaries = [];
    for (const definition of PLANT_DEFINITIONS) {
      const summary = await ensurePlantDefinition(definition);
      summaries.push(summary);
    }

    console.log("\n📋 Summary:");
    for (const summary of summaries) {
      console.log(`\n🌱 ${summary.plantName}`);
      if (summary.createdPlant) {
        console.log("   • Plant created");
      }
      if (summary.updatedSlotSize) {
        console.log("   • Slot size updated");
      }
      if (summary.updatedSowingAllowed) {
        console.log("   • Sowing allowed enabled");
      }
      if (summary.addedSubtypes.length) {
        console.log(`   • Added subtypes: ${summary.addedSubtypes.join(", ")}`);
      }
      if (summary.updatedSubtypeReadyDays.length) {
        console.log(
          `   • Updated plant ready days for: ${summary.updatedSubtypeReadyDays.join(
            ", "
          )}`
        );
      }
      if (summary.createdSlotYears.length) {
        console.log(
          `   • Slot years created: ${summary.createdSlotYears.join(", ")}`
        );
      }
      if (summary.addedSubtypeSlots.length) {
        console.log(
          `   • Added subtype slots: ${summary.addedSubtypeSlots.join(", ")}`
        );
      }
      if (summary.resetSubtypeSlots.length) {
        console.log(
          `   • Reset subtype slots: ${summary.resetSubtypeSlots.join(", ")}`
        );
      }
      if (summary.updatedSlotMetadata.length) {
        console.log(
          `   • Normalized slot metadata: ${summary.updatedSlotMetadata.join(
            ", "
          )}`
        );
      }
      if (summary.refreshedSlotYears.size) {
        console.log(
          `   • Refreshed slot documents for years: ${[
            ...summary.refreshedSlotYears,
          ].join(", ")}`
        );
      }
      if (
        !summary.createdPlant &&
        !summary.updatedSlotSize &&
        !summary.updatedSowingAllowed &&
        !summary.addedSubtypes.length &&
        !summary.updatedSubtypeReadyDays.length &&
        !summary.createdSlotYears.length &&
        !summary.addedSubtypeSlots.length &&
        !summary.resetSubtypeSlots.length &&
        !summary.updatedSlotMetadata.length &&
        !summary.refreshedSlotYears.size
      ) {
        console.log("   • No changes required (already up to date)");
      }
    }

    console.log("\n✅ Completed plant subtype and slot setup.");
  } catch (error) {
    console.error("❌ Failed to ensure plant subtypes and slots:", error);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 MongoDB connection closed.");
  }
};

run();


