/**
 * Prod: zero Ram Agri seed+chem stock, add missing varieties/CMS subtypes,
 * merchants, seed PO+GRN batches from sheet, set chemical currentStock.
 *
 * Run: node scripts/apply-sheet-ram-agri-stock.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const DRY = process.argv.includes("--dry");

const PACKET_UNIT_FALLBACK = "69da85fe39cf080b4b5f1d2e"; // Packet

const SEED_VARIETIES_TO_ADD = [
  { crop: "Okra", name: "Virtus" },
  { crop: "Cucumber", name: "Belle" },
  { crop: "Muskmelon", name: "Honey" },
  { crop: "Watermelon", name: "Magnus" },
  { crop: "Watermelon", name: "Karlgil Plus" },
  { crop: "Watermelon", name: "Shivaji" },
  /** Sheet: Aurdour Watermelon Vijay (Muskmelon/Vijay already exists separately) */
  { crop: "Watermelon", name: "Vijay" },
];

const CMS_SUBTYPES_TO_ADD = [
  { plant: "Muskmelon", name: "Honey" },
  { plant: "Watermelon", name: "Karlgil Plus" },
  { plant: "Watermelon", name: "Shivaji" },
];

const MERCHANTS = [
  "Nunhems Company",
  "Shah Agro Agency",
  "Gahtule Agro Service Pvt Ltd",
  "Bhumivikas Agro Agency",
  "Dharati Dhan Agro Sales Jalgaon",
  "Kaveri seed Company Limited",
  "Kamalshindhu Krushi Kendra",
  "Sagar Biotech Pvt Ltd",
  "Kesarinandana Agro Genetic",
];

/** Sheet seed lots → Ram Agri names. Melody raising 10 pkt skipped. */
const SEED_LOTS = [
  { crop: "Okra", variety: "Samiksha", lot: "36629203003", exp: "2027-01-02", qty: 80, merchant: "Nunhems Company" },
  { crop: "Watermelon", variety: "Max", lot: "41404860001", exp: "2026-08-09", qty: 25, merchant: "Nunhems Company" },
  { crop: "Gourd", variety: "Micromight", lot: "35782101004", exp: "2026-10-13", qty: 60, merchant: "Nunhems Company" },
  { crop: "Gourd", variety: "Micromight", lot: "36521501004", exp: "2026-10-02", qty: 219, merchant: "Nunhems Company" },
  { crop: "Gourd", variety: "Micromight", lot: "36507201004", exp: "2026-09-30", qty: 65, merchant: "Nunhems Company" },
  { crop: "Cucumber", variety: "Belle", lot: "36337301003", exp: "2026-11-10", qty: 70, merchant: "Nunhems Company" },
  { crop: "Muskmelon", variety: "Lyallpur", lot: "35865701003", exp: "2026-02-16", qty: 50, merchant: "Nunhems Company" },
  { crop: "Muskmelon", variety: "Lyallpur", lot: "3185701003", exp: "2026-06-10", qty: 55, merchant: "Nunhems Company" },
  { crop: "Muskmelon", variety: "Lyallpur", lot: "36283601003", exp: "2026-07-18", qty: 4, merchant: "Nunhems Company" },
  { crop: "Gourd", variety: "Robusta", lot: "4163119003", exp: "2027-01-12", qty: 215, merchant: "Nunhems Company" },
  { crop: "Gourd", variety: "Robusta", lot: "36637001004", exp: "2026-10-03", qty: 37, merchant: "Nunhems Company" },
  { crop: "Gourd", variety: "Robusta", lot: "41704630003", exp: "2027-02-08", qty: 29, merchant: "Nunhems Company" },
  { crop: "Gourd", variety: "Robusta", lot: "41704630003-B", exp: "2027-02-24", qty: 35, merchant: "Nunhems Company" },
  { crop: "Okra", variety: "Saransh", lot: "41251880002", exp: "2027-02-01", qty: 38, merchant: "Nunhems Company" },
  { crop: "Watermelon", variety: "Impact", lot: "37438001004", exp: "2027-03-10", qty: 74, merchant: "Nunhems Company" },
  { crop: "Okra", variety: "Virtus", lot: "374513031003", exp: "2027-03-06", qty: 240, merchant: "Nunhems Company" },
  { crop: "Watermelon", variety: "Simmba", lot: "0021092374", exp: "2026-10-22", qty: 10, merchant: "Shah Agro Agency" },
  { crop: "Watermelon", variety: "Simmba", lot: "0021046327", exp: "2026-09-26", qty: 24, merchant: "Gahtule Agro Service Pvt Ltd" },
  { crop: "Watermelon", variety: "Simmba", lot: "0021039884", exp: "2026-09-26", qty: 10, merchant: "Gahtule Agro Service Pvt Ltd" },
  { crop: "Watermelon", variety: "Simmba", lot: "0021399648", exp: "2027-02-27", qty: 13, merchant: "Bhumivikas Agro Agency" },
  { crop: "Watermelon", variety: "Melody", lot: "2602569", exp: "2027-03-21", qty: 98, merchant: "Dharati Dhan Agro Sales Jalgaon" },
  // Melody 10 pkt raising — SKIPPED
  { crop: "Muskmelon", variety: "Honey", lot: "LMJ210714N", exp: "2026-07-05", qty: 1, merchant: "Kaveri seed Company Limited" },
  { crop: "Watermelon", variety: "Magnus", lot: "24710-24", exp: "2027-03-08", qty: 1, merchant: "Kamalshindhu Krushi Kendra" },
  { crop: "Watermelon", variety: "Singham", lot: "R50270522/1/2", exp: "2027-03-25", qty: 58, merchant: "Sagar Biotech Pvt Ltd" },
  { crop: "Watermelon", variety: "Vijay", lot: "A02731", exp: "2027-02-23", qty: 76, merchant: "Dharati Dhan Agro Sales Jalgaon" },
  { crop: "Watermelon", variety: "Karlgil Plus", lot: "25221", exp: "2027-04-08", qty: 130, merchant: "Kesarinandana Agro Genetic" },
  { crop: "Watermelon", variety: "Shivaji", lot: "25227", exp: "2027-04-08", qty: 80, merchant: "Kesarinandana Agro Genetic" },
];

/** Chemical targets after zero — Stock column only */
const CHEM_STOCK = [
  { crop: "SEVEN", variety: "SEVEN 1000 ml", stock: 167 },
  { crop: "Keoline", variety: "Keoline 1 kg", stock: 17 },
  { crop: "BOOMER", variety: "BOOMER 500 gm", stock: 31 },
  { crop: "Phosphoric Acid", variety: "PA 35 Ltr", stock: 8 },
  { crop: "Phosphoric Acid", variety: "PA 7 Ltr", stock: 5 },
  { crop: "PATTI MAKER 5L", variety: "PATTI MAKER 5L 5000 ml", stock: 6 },
  { crop: "PATTI MAKER 20L", variety: "PATTI MAKER 20L 20000 ml", stock: 2 },
  { crop: "Dextros", variety: "Dextros", stock: 21 },
  { crop: "SOIL RICH", variety: "SOIL RICH 500 gm", stock: 8 },
  { crop: "PICK UP", variety: "PICK UP 500 gm", stock: 1 },
];

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();

function parseExp(iso) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function main() {
  const uri = process.env.PROD_MONGO_URL;
  if (!uri) {
    console.error("PROD_MONGO_URL missing");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 25000 });
  console.log(DRY ? "=== DRY RUN (no writes) ===" : "=== EXECUTING ON PROD ===");

  const User = (await import("../models/user.model.js")).default;
  const RamAgriInputsProduct = (await import("../models/ramAgriInputsProduct.model.js")).default;
  const RamAgriBatch = (await import("../models/ramAgriBatch.model.js")).default;
  const Merchant = (await import("../models/merchant.model.js")).default;
  const PlantCms = (await import("../models/plantCms.model.js")).default;
  const PurchaseOrder = (await import("../models/purchaseOrder.model.js")).default;
  const GRN = (await import("../models/grn.model.js")).default;
  await import("../models/measurementUnit.model.js"); // register for populate
  const { createInboundBatch, applyManualStockAdjustment } = await import(
    "../services/ramAgriBatchInventory.service.js"
  );

  const user =
    (await User.findOne({ jobTitle: /ADMIN|SUPER/i }).select("_id name")) ||
    (await User.findOne().select("_id name"));
  if (!user) throw new Error("No user found for createdBy");
  console.log("Actor:", user.name || user._id);

  let packetUnit = await mongoose.connection.collection("measurementunits").findOne({
    name: /packet/i,
  });
  if (!packetUnit) packetUnit = { _id: new mongoose.Types.ObjectId(PACKET_UNIT_FALLBACK) };
  const packetUnitId = packetUnit._id;
  console.log("Packet unit:", packetUnitId.toString());

  // ——— 1) ZERO ALL STOCK (native update — many varieties lack primaryUnit) ———
  if (!DRY) {
    const zeroRes = await RamAgriInputsProduct.collection.updateMany(
      {},
      {
        $set: {
          "varieties.$[].currentStock": 0,
          "varieties.$[].stockValue": 0,
          "varieties.$[].averagePrice": 0,
          "varieties.$[].stockUpdatedAt": new Date(),
        },
      }
    );
    // Backfill missing primaryUnit so later mongoose saves succeed
    const cropsNeedingUnit = await RamAgriInputsProduct.collection
      .find({ "varieties.primaryUnit": { $exists: false } })
      .project({ varieties: 1 })
      .toArray();
    for (const c of cropsNeedingUnit) {
      const varieties = (c.varieties || []).map((v) => ({
        ...v,
        primaryUnit: v.primaryUnit || packetUnitId,
      }));
      await RamAgriInputsProduct.collection.updateOne(
        { _id: c._id },
        { $set: { varieties } }
      );
    }
    const batchRes = await RamAgriBatch.updateMany(
      {},
      { $set: { remainingQuantity: 0, status: "exhausted" } }
    );
    console.log(
      `Zeroed crops matched=${zeroRes.matchedCount}, unit-backfill crops=${cropsNeedingUnit.length}, batches exhausted=${batchRes.modifiedCount}`
    );
  } else {
    const nz = await RamAgriInputsProduct.collection.countDocuments({
      "varieties.currentStock": { $gt: 0 },
    });
    const nb = await RamAgriBatch.countDocuments({ remainingQuantity: { $gt: 0 } });
    console.log(`Would zero crops-with-stock≈${nz}, batches≈${nb}`);
  }

  // ——— 2) ADD MISSING SEED VARIETIES ———
  for (const row of SEED_VARIETIES_TO_ADD) {
    const crop = await RamAgriInputsProduct.findOne({
      cropName: new RegExp(`^${row.crop}$`, "i"),
      productType: "seed",
    });
    if (!crop) {
      console.error(`MISSING CROP ${row.crop} — skip variety ${row.name}`);
      continue;
    }
    const exists = (crop.varieties || []).some((v) => norm(v.name) === norm(row.name));
    if (exists) {
      console.log(`Variety exists: ${row.crop} / ${row.name}`);
      continue;
    }
    console.log(`ADD variety: ${row.crop} / ${row.name}`);
    if (!DRY) {
      // Native push avoids validating sibling varieties without required fields
      await RamAgriInputsProduct.collection.updateOne(
        { _id: crop._id },
        {
          $push: {
            varieties: {
              _id: new mongoose.Types.ObjectId(),
              name: row.name,
              description: "Added from stock sheet 2026-07-25",
              isActive: true,
              primaryUnit: packetUnitId,
              currentStock: 0,
              stockValue: 0,
              averagePrice: 0,
              rates: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        }
      );
    }
  }

  // ——— 3) PLANT CMS SUBTYPES (no Okra/Cucumber) ———
  for (const row of CMS_SUBTYPES_TO_ADD) {
    const plant = await PlantCms.findOne({ name: new RegExp(`^${row.plant}$`, "i") });
    if (!plant) {
      console.error(`CMS plant missing: ${row.plant}`);
      continue;
    }
    const exists = (plant.subtypes || []).some((s) => norm(s.name) === norm(row.name));
    if (exists) {
      console.log(`CMS subtype exists: ${row.plant} / ${row.name}`);
      continue;
    }
    const template =
      (plant.subtypes || []).find((s) => norm(s.name) === "magnus") ||
      (plant.subtypes || []).find((s) => norm(s.name) === "impact") ||
      (plant.subtypes || []).find((s) => norm(s.name) === "melody") ||
      (plant.subtypes || [])[0];
    if (!template) {
      console.error(`No template subtype on ${row.plant}`);
      continue;
    }
    console.log(`ADD CMS subtype: ${row.plant} / ${row.name} (clone slot fields from ${template.name})`);
    if (!DRY) {
      plant.subtypes.push({
        name: row.name,
        description: "Added from stock sheet 2026-07-25",
        rates: template.rates?.length ? [...template.rates] : [0],
        monthlyRates: [],
        dailyDispatch: template.dailyDispatch || 0,
        buffer: template.buffer || 0,
        plantReadyDays: template.plantReadyDays || 0,
        slotDays: template.slotDays,
        slotStartDate: template.slotStartDate,
        slotEndDate: template.slotEndDate,
        slotCapacity: template.slotCapacity,
      });
      await plant.save();
    }
  }

  // ——— 4) MERCHANTS ———
  const merchantByName = new Map();
  for (const name of MERCHANTS) {
    let m = await Merchant.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (!m) {
      console.log(`ADD merchant: ${name}`);
      if (!DRY) {
        const code = await Merchant.generateCode();
        m = await Merchant.create({
          code,
          name,
          category: "supplier",
          phone: "0000000000",
          isActive: true,
          notes: "Created from seed stock sheet 2026-07-25",
          createdBy: user._id,
        });
      } else {
        m = { _id: new mongoose.Types.ObjectId(), name };
      }
    } else {
      console.log(`Merchant exists: ${name}`);
    }
    merchantByName.set(name, m);
  }

  // Fresh crop lookup after variety adds (no stale cache)
  async function getCropVariety(cropName, varietyName) {
    const crop = await RamAgriInputsProduct.findOne({
      cropName: new RegExp(`^${cropName}$`, "i"),
    });
    if (!crop) return { crop: null, variety: null };
    const variety = (crop.varieties || []).find((v) => norm(v.name) === norm(varietyName));
    return { crop, variety };
  }

  // ——— 5) SEED PO + GRN + batches (per merchant) ———
  const byMerchant = new Map();
  for (const lot of SEED_LOTS) {
    if (!byMerchant.has(lot.merchant)) byMerchant.set(lot.merchant, []);
    byMerchant.get(lot.merchant).push(lot);
  }

  let seedPktTotal = 0;
  let batchCreated = 0;

  for (const [merchantName, lots] of byMerchant) {
    const merchant = merchantByName.get(merchantName);
    if (!merchant?._id) {
      console.error(`No merchant id for ${merchantName}`);
      continue;
    }

    const poItems = [];
    for (const lot of lots) {
      const { crop, variety } = await getCropVariety(lot.crop, lot.variety);
      if (!crop || !variety) {
        console.error(`RESOLVE FAIL ${lot.crop}/${lot.variety} lot ${lot.lot}`);
        continue;
      }
      const amount = lot.qty * 0;
      poItems.push({
        quantity: lot.qty,
        unit: packetUnitId,
        rate: 0,
        gst: 0,
        discount: 0,
        amount,
        batchNumber: lot.lot,
        expiryDate: parseExp(lot.exp),
        isRamAgriProduct: true,
        ramAgriCropId: crop._id,
        ramAgriVarietyId: variety._id,
        ramAgriCropName: crop.cropName,
        ramAgriVarietyName: variety.name,
        selectedUnitType: "primary",
        conversionFactor: 1,
        _lot: lot,
        _crop: crop,
        _variety: variety,
      });
      seedPktTotal += lot.qty;
    }

    if (!poItems.length) continue;

    console.log(
      `\nPO merchant=${merchantName} lines=${poItems.length} pkt=${poItems.reduce((s, i) => s + i.quantity, 0)}`
    );

    if (DRY) continue;

    const poNumber = await PurchaseOrder.generatePONumber();
    const po = await PurchaseOrder.create({
      poNumber,
      supplier: merchant._id,
      poDate: new Date(),
      expectedDeliveryDate: new Date(),
      items: poItems.map(({ _lot, _crop, _variety, ...rest }) => rest),
      subtotal: 0,
      gstAmount: 0,
      discountAmount: 0,
      otherCharges: 0,
      totalAmount: 0,
      status: "received",
      paymentStatus: "pending",
      autoGRN: true,
      notes: "Auto from seed stock sheet 2026-07-25 (skip raising Melody 10)",
      createdBy: user._id,
      approvedBy: user._id,
      approvedDate: new Date(),
    });

    const grnNumber = await GRN.generateGRNNumber();
    const grnItems = poItems.map((it) => ({
      quantity: it.quantity,
      unit: packetUnitId,
      rate: 0,
      acceptedQuantity: it.quantity,
      rejectedQuantity: 0,
      damageQuantity: 0,
      amount: 0,
      expiryDate: it.expiryDate,
      batchNumber: it.batchNumber,
      isRamAgriProduct: true,
      ramAgriCropId: it.ramAgriCropId,
      ramAgriVarietyId: it.ramAgriVarietyId,
      ramAgriCropName: it.ramAgriCropName,
      ramAgriVarietyName: it.ramAgriVarietyName,
      selectedUnitType: "primary",
      conversionFactor: 1,
    }));

    const grn = await GRN.create({
      grnNumber,
      supplier: merchant._id,
      purchaseOrder: po._id,
      grnDate: new Date(),
      items: grnItems,
      subtotal: 0,
      gstAmount: 0,
      freightCharges: 0,
      otherCharges: 0,
      totalAmount: 0,
      status: "approved",
      notes: `Auto-GRN from ${poNumber} · sheet stock load`,
      createdBy: user._id,
      approvedBy: user._id,
      approvedDate: new Date(),
    });

    for (const it of poItems) {
      const batch = await createInboundBatch({
        cropId: it.ramAgriCropId,
        varietyId: it.ramAgriVarietyId,
        quantityPrimary: it.quantity,
        batchNumber: it.batchNumber,
        expiryDate: it.expiryDate,
        purchasePrice: 0,
        unitId: packetUnitId,
        supplier: merchant._id,
        source: "GRN",
        referenceType: "GRN",
        referenceId: grn._id,
        referenceNumber: grn.grnNumber,
        grnId: grn._id,
        purchaseOrderId: po._id,
        receivedDate: new Date(),
        userId: user._id,
        cropName: it.ramAgriCropName,
        varietyName: it.ramAgriVarietyName,
      });
      batchCreated++;
      console.log(
        `  + batch ${batch.batchNumber} ${it.ramAgriCropName}/${it.ramAgriVarietyName} qty=${it.quantity}`
      );
    }
    console.log(`  PO ${poNumber} · GRN ${grnNumber}`);
  }

  // ——— 6) CHEMICAL STOCK ———
  console.log("\n--- Chemical stock targets ---");
  for (const row of CHEM_STOCK) {
    const { crop, variety } = await getCropVariety(row.crop, row.variety);
    if (!crop || !variety) {
      // try looser crop match
      const cropDoc = await RamAgriInputsProduct.findOne({
        productType: "chemical",
        cropName: new RegExp(row.crop.replace(/\s+/g, ".*"), "i"),
      });
      const v = cropDoc
        ? (cropDoc.varieties || []).find((x) => norm(x.name) === norm(row.variety))
        : null;
      if (!cropDoc || !v) {
        console.error(`CHEM MISS ${row.crop} / ${row.variety}`);
        continue;
      }
      console.log(`SET chem ${cropDoc.cropName}/${v.name} → ${row.stock}`);
      if (!DRY) {
        if (!v.primaryUnit) {
          v.primaryUnit = packetUnitId;
          await cropDoc.save();
        }
        await applyManualStockAdjustment(cropDoc._id, v._id, row.stock, user._id);
      }
      continue;
    }
    console.log(`SET chem ${crop.cropName}/${variety.name} → ${row.stock}`);
    if (!DRY) {
      if (!variety.primaryUnit) {
        variety.primaryUnit = packetUnitId;
        await crop.save();
      }
      await applyManualStockAdjustment(crop._id, variety._id, row.stock, user._id);
    }
  }

  // ——— VERIFY ———
  if (!DRY) {
    const seeds = await RamAgriInputsProduct.find({ productType: "seed" });
    let seedStock = 0;
    for (const c of seeds) for (const v of c.varieties || []) seedStock += Number(v.currentStock) || 0;
    const chems = await RamAgriInputsProduct.find({ productType: "chemical" });
    let chemStock = 0;
    for (const c of chems) for (const v of c.varieties || []) chemStock += Number(v.currentStock) || 0;
    const activeBatches = await RamAgriBatch.countDocuments({
      status: "active",
      remainingQuantity: { $gt: 0 },
    });
    console.log("\n=== VERIFY ===");
    console.log("Seed currentStock sum:", seedStock, "(expect ~1697; Melody 10 skipped)");
    console.log("Chem currentStock sum:", chemStock, "(expect 266)");
    console.log("Active batches:", activeBatches);
    console.log("Seed batches created:", batchCreated);
  } else {
    console.log("\nWould seed pkt total:", SEED_LOTS.reduce((s, l) => s + l.qty, 0));
    console.log("Would chem stock sum:", CHEM_STOCK.reduce((s, l) => s + l.stock, 0));
  }

  await mongoose.disconnect();
  console.log(DRY ? "\nDRY RUN DONE" : "\nDONE");
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
