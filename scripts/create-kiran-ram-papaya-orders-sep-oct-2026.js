/**
 * Create the approved production Ram Papaya batch for Kiran (9823832132).
 * Default is dry-run; pass --execute for production creation.
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
const BATCH_ID = "KIRAN-RAM-PAPAYA-ALT-20260907-20261025";
const MOBILE_NUMBER = 9823832132;
const PLANT_ID = "691054dffba6fb380f8d5676";
const SUBTYPE_ID = "6aa5625d0401ec99b9f6f60d";
const SALES_PERSON_ID = "69ca549bc2ef331f5e13c91b";
const CAVITY_ID = "699acb84779cdf7c42175832";
const QUANTITIES = [3000, 3500, 4000, 4500, 5000, 5500, 6000];

function buildPlan() {
  const plan = [];
  const current = new Date(Date.UTC(2026, 8, 7));
  const end = new Date(Date.UTC(2026, 9, 25));
  let index = 0;
  while (current <= end) {
    const date = current.toISOString().slice(0, 10);
    plan.push({
      date,
      quantity: QUANTITIES[index % QUANTITIES.length],
      seedSource: index % 3 === 0 ? "RAISING" : "COMPANY",
    });
    current.setUTCDate(current.getUTCDate() + 2);
    index += 1;
  }
  return plan;
}

function markerFor(date) {
  return `${BATCH_ID}:${date}`;
}

function parseSlotDate(value) {
  const [dd, mm, yyyy] = value.split("-").map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

function deliveryDateUtc(date) {
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
  if (!process.env.PROD_MONGO_URL) throw new Error("PROD_MONGO_URL is missing");

  await mongoose.connect(process.env.PROD_MONGO_URL, {
    serverSelectionTimeoutMS: 15000,
  });
  const db = mongoose.connection.db;
  const objectId = (value) => new mongoose.Types.ObjectId(value);

  const [farmer, plant, salesPerson, cavity, authUser, slotDoc] =
    await Promise.all([
      db.collection("farmers").findOne({ mobileNumber: MOBILE_NUMBER }),
      db.collection("plantcms").findOne({
        _id: objectId(PLANT_ID),
        "subtypes._id": objectId(SUBTYPE_ID),
      }),
      db.collection("users").findOne({ _id: objectId(SALES_PERSON_ID) }),
      db.collection("trays").findOne({ _id: objectId(CAVITY_ID) }),
      db.collection("users").findOne({
        isDisabled: { $ne: true },
        $or: [{ role: "SUPER_ADMIN" }, { jobTitle: "SUPER_ADMIN" }],
      }),
      db.collection("plantslots").findOne({
        plantId: objectId(PLANT_ID),
        year: 2026,
        "subtypeSlots.subtypeId": objectId(SUBTYPE_ID),
      }),
    ]);

  if (!farmer) throw new Error(`Farmer ${MOBILE_NUMBER} not found`);
  if (!plant) throw new Error("Papaya / Ram papaya subtype not found");
  if (!salesPerson || salesPerson.isDisabled) {
    throw new Error("Configured sales person is missing or disabled");
  }
  if (!cavity) throw new Error("Configured 126 cavity tray not found");
  if (!authUser) throw new Error("No active SUPER_ADMIN available");
  if (!slotDoc) throw new Error("Ram Papaya 2026 slots not found");

  const subtype = plant.subtypes.find((row) => String(row._id) === SUBTYPE_ID);
  const subtypeSlots = slotDoc.subtypeSlots.find(
    (row) => String(row.subtypeId) === SUBTYPE_ID
  );
  const slots = subtypeSlots?.slots || [];
  const orders = db.collection("orders");
  const preflight = [];

  for (const row of buildPlan()) {
    const target = new Date(`${row.date}T00:00:00.000Z`);
    const slot = slots.find(
      (candidate) =>
        target >= parseSlotDate(candidate.startDay) &&
        target <= parseSlotDate(candidate.endDay)
    );
    if (!slot || slot.status !== true) {
      throw new Error(`No active slot covering ${row.date}`);
    }
    const marker = markerFor(row.date);
    const existing = await orders.findOne(
      { orderRemarks: marker },
      { projection: { orderId: 1 } }
    );
    const raising = row.seedSource === "RAISING";
    preflight.push({
      ...row,
      packets: raising ? Math.ceil(row.quantity / 100) : 0,
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

    const response = await fetch(`${API_BASE_URL}/api/v1/farmer/createFarmer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
      }),
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
    if (!orderId) throw new Error(`${row.date} returned no orderId`);
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
        },
      }
    )
    .sort({ deliveryDate: 1 })
    .toArray();

  if (verified.length !== preflight.length) {
    throw new Error(
      `Verification failed: expected ${preflight.length}, found ${verified.length}`
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
