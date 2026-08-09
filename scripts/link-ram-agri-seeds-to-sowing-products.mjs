/**
 * Create inventory Product (seeds) linked to Plant CMS + Ram Agri variety,
 * then mirror Ram Agri lots into classic Batches for sowing.
 *
 * Run: node scripts/link-ram-agri-seeds-to-sowing-products.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const DRY = process.argv.includes("--dry");
const DEFAULT_CF = 1000; // plants per packet (override per variety below)

const CF_BY_VARIETY = {
  // adjust if known; else DEFAULT_CF
};

const NAME_ALIASES = {
  lyallpur: "layalpur",
  max: "maxx",
  simbha: "simmba",
  simmba: "simbha",
};

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();

async function main() {
  await mongoose.connect(process.env.PROD_MONGO_URL, {
    serverSelectionTimeoutMS: 25000,
  });
  console.log(DRY ? "=== DRY RUN ===" : "=== LINK ON PROD ===");

  const User = (await import("../models/user.model.js")).default;
  const Product = (await import("../models/product.model.js")).default;
  const PlantCms = (await import("../models/plantCms.model.js")).default;
  const RamAgriInputsProduct = (await import("../models/ramAgriInputsProduct.model.js"))
    .default;
  await import("../models/measurementUnit.model.js");
  const { syncLinkedInventoryFromRamAgri } = await import(
    "../services/ramAgriLinkedProductSync.service.js"
  );

  const user =
    (await User.findOne({ jobTitle: /ADMIN|SUPER/i }).select("_id")) ||
    (await User.findOne().select("_id"));
  if (!user) throw new Error("No user");

  const packetUnit = await mongoose.connection
    .collection("measurementunits")
    .findOne({ name: /packet/i });
  if (!packetUnit) throw new Error("Packet unit not found");

  const plants = await PlantCms.find({ sowingAllowed: true }).lean();
  const cmsIndex = [];
  for (const p of plants) {
    for (const st of p.subtypes || []) {
      cmsIndex.push({
        plantId: p._id,
        plantName: p.name,
        subtypeId: st._id,
        subtypeName: st.name,
        n: norm(st.name),
        plantN: norm(p.name),
      });
    }
  }

  function pickCms(cropName, varietyName) {
    const n = norm(varietyName);
    const alt = NAME_ALIASES[n] || n;
    const cropN = norm(cropName);
    const hits = cmsIndex.filter(
      (c) => c.n === n || c.n === alt || n === NAME_ALIASES[c.n]
    );
    if (!hits.length) return null;
    const sameCrop = hits.find((c) => c.plantN === cropN);
    return sameCrop || hits[0];
  }

  const crops = await RamAgriInputsProduct.find({
    productType: "seed",
    isActive: { $ne: false },
  }).lean();

  let created = 0;
  let updated = 0;
  let synced = 0;

  for (const crop of crops) {
    for (const v of crop.varieties || []) {
      if (v.isActive === false) continue;
      const cms = pickCms(crop.cropName, v.name);
      if (!cms) continue;

      const codeBase = `RAG-${norm(crop.cropName)}-${norm(v.name)}`.slice(0, 40).toUpperCase();
      const name = `${cms.subtypeName}`.trim();
      const cf = CF_BY_VARIETY[norm(v.name)] || DEFAULT_CF;

      let product = await Product.findOne({
        $or: [
          { ramAgriCropId: crop._id, ramAgriVarietyId: v._id },
          { plantId: cms.plantId, subtypeId: cms.subtypeId, category: /^seeds$/i },
        ],
      });

      if (!product) {
        // unique code
        let code = codeBase;
        let i = 1;
        while (await Product.findOne({ code }).select("_id").lean()) {
          code = `${codeBase}-${i++}`;
        }
        console.log(
          `CREATE Product ${name} → ${cms.plantName}/${cms.subtypeName} ← Ram Agri ${crop.cropName}/${v.name} stock=${v.currentStock || 0} cf=${cf}`
        );
        if (!DRY) {
          product = await Product.create({
            code,
            name,
            description: `Linked Ram Agri ${crop.cropName} / ${v.name} for sowing`,
            category: "seeds",
            purpose: "production",
            plantId: cms.plantId,
            subtypeId: cms.subtypeId,
            primaryUnit: packetUnit._id,
            conversionFactor: cf,
            currentStock: Number(v.currentStock) || 0,
            isActive: true,
            isRamAgriSales: true,
            ramAgriCropId: crop._id,
            ramAgriVarietyId: v._id,
            createdBy: user._id,
          });
          created++;
        }
      } else {
        console.log(
          `UPDATE Product ${product.code || product.name} → plant/subtype + Ram Agri flags`
        );
        if (!DRY) {
          product.plantId = cms.plantId;
          product.subtypeId = cms.subtypeId;
          product.category = "seeds";
          product.isActive = true;
          product.isRamAgriSales = true;
          product.ramAgriCropId = crop._id;
          product.ramAgriVarietyId = v._id;
          if (!product.primaryUnit) product.primaryUnit = packetUnit._id;
          if (!product.conversionFactor) product.conversionFactor = cf;
          product.updatedBy = user._id;
          await product.save({ validateBeforeSave: false });
          updated++;
        }
      }

      if (!DRY && product) {
        const r = await syncLinkedInventoryFromRamAgri(crop._id, v._id, user._id);
        synced += r.batches || 0;
        console.log(`  synced mirrors batches≈${r.batches} stock→${Number(v.currentStock) || 0}`);
      }
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log({ created, updated, syncedBatchWrites: synced });
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
