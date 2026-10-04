/**
 * Create the approved production batch for Kiran Chaudhari (9823832132).
 *
 * Dry run (default):
 *   node scripts/create-kiran-ram-tarbuja-orders-sep-oct-2026.js
 *
 * Production execution:
 *   node scripts/create-kiran-ram-tarbuja-orders-sep-oct-2026.js --execute
 *
 * Each order has a unique marker so reruns safely skip already-created rows.
 */
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const EXECUTE = process.argv.includes("--execute");
const API_BASE_URL = "https://api1.rambiotechplants.com";
const BATCH_ID = "KIRAN-RAM-TARBUJA-ALT-20260907-20261003";
const MOBILE_NUMBER = 9823832132;
const PLANT_ID = "691054dffba6fb380f8d57b3";
const SUBTYPE_ID = "6aa562960401ec99b9f6fe37";
const SALES_PERSON_ID = "69ca549bc2ef331f5e13c91b";
const CAVITY_ID = "699acb84779cdf7c42175832";

const PLAN = [
  ["2026-09-07", 3000, "RAISING"],
  ["2026-09-09", 3500, "COMPANY"],
  ["2026-09-11", 4000, "COMPANY"],
  ["2026-09-13", 4500, "RAISING"],
  ["2026-09-15", 5000, "COMPANY"],
  ["2026-09-17", 5500, "COMPANY"],
  ["2026-09-19", 6000, "RAISING"],
  ["2026-09-21", 3000, "COMPANY"],
  ["2026-09-23", 3500, "COMPANY"],
  ["2026-09-25", 4000, "RAISING"],
  ["2026-09-27", 4500, "COMPANY"],
  ["2026-09-29", 5000, "COMPANY"],
  ["2026-10-01", 5500, "RAISING"],
  ["2026-10-03", 6000, "COMPANY"],
];

function markerFor(date) {
  return `${BATCH_ID}:${date}`;
}

function slotDate(date) {
  const [yyyy, mm, dd] = date.split("-");
  return `${dd}-${mm}-${yyyy}`;
}

function deliveryDateUtc(date) {
  // Midnight IST on the requested delivery date.
  return `${date}T18:30:00.000Z`;
}

function createAccessToken(user) {
  const secret = process.env.JWT_SECRET || process.env.PRIVATE_KEY;
  if (!secret) throw new Error("JWT_SECRET/PRIVATE_KEY is missing");
  return jwt.sign(
    {
      _id: String(user._id),
      phoneNumber: user.phoneNumber,
      role: user.role,
      jobTitle: user.jobTitle,
      name: user.name,
      type: "access",
    },
    secret,
    {
      expiresIn: "1h",
      issuer: "nursery-app",
      audience: "nursery-users",
    }
  );
}

async function main() {
  if (!process.env.PROD_MONGO_URL) {
    throw new Error("PROD_MONGO_URL is missing");
  }

  await mongoose.connect(process.env.PROD_MONGO_URL, {
    serverSelectionTimeoutMS: 15000,
  });

  const db = mongoose.connection.db;
  const farmers = db.collection("farmers");
  const plants = db.collection("plantcms");
  const plantSlots = db.collection("plantslots");
  const orders = db.collection("orders");
  const users = db.collection("users");
  const trays = db.collection("trays");

  const [farmer, plant, salesPerson, cavity, authUser, slotDoc] =
    await Promise.all([
      farmers.findOne({ mobileNumber: MOBILE_NUMBER }),
      plants.findOne({
        _id: new mongoose.Types.ObjectId(PLANT_ID),
        "subtypes._id": new mongoose.Types.ObjectId(SUBTYPE_ID),
      }),
      users.findOne({ _id: new mongoose.Types.ObjectId(SALES_PERSON_ID) }),
      trays.findOne({ _id: new mongoose.Types.ObjectId(CAVITY_ID) }),
      users.findOne({
        isDisabled: { $ne: true },
        $or: [{ role: "SUPER_ADMIN" }, { jobTitle: "SUPER_ADMIN" }],
      }),
      plantSlots.findOne({
        plantId: new mongoose.Types.ObjectId(PLANT_ID),
        year: 2026,
        "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(SUBTYPE_ID),
      }),
    ]);

  if (!farmer) throw new Error(`Farmer ${MOBILE_NUMBER} not found`);
  if (!plant) throw new Error("Watermelon / Ram Tarbuja subtype not found");
  if (!salesPerson || salesPerson.isDisabled) {
    throw new Error("Configured sales person is missing or disabled");
  }
  if (!cavity) throw new Error("Configured 126 cavity tray not found");
  if (!authUser) throw new Error("No active SUPER_ADMIN available");
  if (!slotDoc) throw new Error("Ram Tarbuja 2026 slot document not found");

  const subtype = plant.subtypes.find((row) => String(row._id) === SUBTYPE_ID);
  const subtypeSlots = slotDoc.subtypeSlots.find(
    (row) => String(row.subtypeId) === SUBTYPE_ID
  );
  const slotsByDate = new Map(
    (subtypeSlots?.slots || []).map((slot) => [slot.startDay, slot])
  );

  const preflight = [];
  for (const [date, quantity, seedSource] of PLAN) {
    const slot = slotsByDate.get(slotDate(date));
    if (!slot || slot.endDay !== slotDate(date) || slot.status !== true) {
      throw new Error(`No active exact-day slot for ${date}`);
    }
    const marker = markerFor(date);
    const existing = await orders.findOne(
      { orderRemarks: marker },
      { projection: { orderId: 1 } }
    );
    const raising = seedSource === "RAISING";
    preflight.push({
      date,
      quantity,
      seedSource,
      packets: raising ? Math.ceil(quantity / 100) : 0,
      rate: raising ? Number(subtype.raisingRate) : Number(subtype.rates?.[0]),
      slotId: String(slot._id),
      marker,
      existingOrderId: existing?.orderId ?? null,
    });
  }

  console.log(
    `${EXECUTE ? "EXECUTE" : "DRY RUN"}: ${farmer.name} (${MOBILE_NUMBER}), ${plant.name} / ${subtype.name}`
  );
  for (const row of preflight) {
    console.log(
      `${row.date} qty=${row.quantity} ${row.seedSource} packets=${row.packets} rate=${row.rate}` +
        (row.existingOrderId ? ` SKIP(existing #${row.existingOrderId})` : "")
    );
  }

  if (!EXECUTE) {
    console.log("No writes performed. Pass --execute to create the batch.");
    return;
  }

  const token = createAccessToken(authUser);
  const created = [];
  const skipped = [];

  for (const row of preflight) {
    if (row.existingOrderId) {
      skipped.push(row.existingOrderId);
      continue;
    }

    const payload = {
      name: farmer.name,
      village: farmer.village,
      taluka: farmer.taluka,
      district: farmer.district,
      state: farmer.state,
      stateName: farmer.stateName,
      talukaName: farmer.talukaName,
      districtName: farmer.districtName,
      mobileNumber: String(MOBILE_NUMBER),
      numberOfPlants: row.quantity,
      rate: row.rate,
      paymentStatus: "not paid",
      salesPerson: SALES_PERSON_ID,
      orderStatus: "ACCEPTED",
      plantName: PLANT_ID,
      plantSubtype: SUBTYPE_ID,
      bookingSlot: row.slotId,
      cavity: CAVITY_ID,
      deliveryDate: deliveryDateUtc(row.date),
      orderBookingDate: new Date().toISOString(),
      orderPaymentStatus: "PENDING",
      sowingPlan: {
        seedSource: row.seedSource,
        companySeedPackets: 0,
        raisingSeedPackets: row.packets,
        sowingNotes:
          row.seedSource === "RAISING" ? "biyane shetkari denar aahe" : "",
      },
      orderRemarks: [
        row.marker,
        `Approved production batch: ${row.date} ${row.seedSource}`,
      ],
    };

    const response = await fetch(`${API_BASE_URL}/api/v1/farmer/createFarmer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.status === "Error" || body?.success === false) {
      throw new Error(
        `${row.date} failed (HTTP ${response.status}): ${
          body?.message || body?.error || JSON.stringify(body)
        }`
      );
    }

    const orderId = body?.data?.order?.orderId;
    if (!orderId) {
      throw new Error(`${row.date} returned no orderId`);
    }
    created.push(orderId);
    console.log(`CREATED ${row.date} -> #${orderId}`);
  }

  const verified = await orders
    .find(
      { orderRemarks: { $regex: `^${BATCH_ID}:` } },
      {
        projection: {
          orderId: 1,
          numberOfPlants: 1,
          deliveryDate: 1,
          rate: 1,
          sowingPlan: 1,
          orderRemarks: 1,
        },
      }
    )
    .sort({ deliveryDate: 1 })
    .toArray();

  if (verified.length !== PLAN.length) {
    throw new Error(
      `Verification failed: expected ${PLAN.length} marked orders, found ${verified.length}`
    );
  }

  console.log(
    `VERIFIED ${verified.length} orders; created=${created.length}; skipped=${skipped.length}; orderIds=${verified
      .map((row) => row.orderId)
      .join(",")}`
  );
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
