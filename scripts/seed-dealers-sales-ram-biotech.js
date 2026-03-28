/**
 * Seed dealers & sales users from the Ram Biotech sheet (shop + contact, phone → SALES if last 4 digits are 6452 else DEALER).
 *
 * SAFETY:
 *   - Default is DRY RUN (no DB writes). Pass --execute to apply.
 *   - Deletes only users with jobTitle DEALER or SALES (does not touch SUPER_ADMIN, ACCOUNTANT, FARMER, etc.).
 *
 * Usage (production — use your real env file, never commit secrets):
 *   cd FINAL_NURSERY_BE
 *   Uses MONGO_URL, or PROD_MONGO_URL if MONGO_URL is unset (matches repo .env).
 *   node scripts/seed-dealers-sales-ram-biotech.js                    # dry run
 *   node scripts/seed-dealers-sales-ram-biotech.js --execute          # apply (PROD_MONGO_URL || MONGO_URL)
 *   node scripts/seed-dealers-sales-ram-biotech.js --execute --prod-db # apply — ONLY PROD_MONGO_URL (recommended)
 *
 * Optional: create via HTTP instead of Mongoose (same payloads as /user/createUser):
 *   SEED_METHOD=api API_BASE_URL=https://api1.rambiotechplants.com/api/v1 node scripts/seed-dealers-sales-ram-biotech.js --execute
 *
 * Recovery if delete succeeded but insert failed:
 *   node scripts/seed-dealers-sales-ram-biotech.js --execute --create-only
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import axios from "axios";
import User from "../models/user.model.js";

const envPath = process.env.ENV_FILE || ".env";
dotenv.config({ path: envPath });

// shop, contact (person name), phone digits only, area note (→ defaultVillage)
const SHEET_ROWS = [
  ["Baliraja Krushi Kendra", "Prakash Markad", "965799662", "Indapur"],
  ["Barde Sir", "Hiralal Barde", "9011076452", "Office"],
  ["bhumika Tredars", "Jai Nageshwar", "8999662791", "Shirpur"],
  ["Call center", "Office", "9011086452", "Office"],
  ["Chaitanya Pipe", "Kunal Patil", "7038061060", "Shahada Nandurbar"],
  ["Chhtrapati Agro Sales", "Sandip Patil", "9403692569", "Nandurbar"],
  ["D. Patil", "Dipak Patil", "7218186452", "Office"],
  ["Datta Agro Fattepur", "Datta Agro Fattepur", "9922502901", "Jamner"],
  ["Dharti agro Khaknar", "Safal Bhai", "9399550161", "Khaknar"],
  ["Dhole Sir", "Bhaskar Dhole", "9028506452", "Raver & Yawal"],
  ["durgesh Agro Agency", "durgesh Agro Agency", "9960538182", "Manvel"],
  ["FPO Sampule", "Bhushan Patil", "9545663500", "Sampule"],
  ["Gajanan P", "Gajanan Patil", "7447766452", "Shirpur Dhule Amalner"],
  ["Gurukrupa Krushi Kendra", "Gurukrupa Krushi Kendra", "8788912405", "Dusane Sakri"],
  ["Harshda Kushi Kendra", "Vishal Patil", "9764948137", "Raver"],
  ["Idhashi Mata Tredar", "Ajay Patil", "9665762648", "Jamner"],
  ["Ishwar Bhau Raver", "Sitaram Patil", "9730744031", "Raver"],
  ["Jayvant Shinde Akluj", "Jayvant Shinde", "8857055505", "Pandharpur"],
  ["Kamsidha Ent.", "", "9823962005", "Raver"],
  ["Krushi Mitra Jamner", "Avinash Patil", "8805788660", "Jamner"],
  ["Krushiratn Kapusavdi", "Ishwar Barbude", "9730329606", "Kapuswadi Jamner"],
  ["Maharastra Tredars Neri", "Bhushan Patil", "9834609202", "Neri Jamner"],
  ["Matoshree KK Neri", "Nitin Patil", "9405050630", "Jamner"],
  ["Mauli KSK Kondhaval", "Yogesh Patil", "9545844712", "Amalner"],
  ["Muktai k k Rajni", "Subhash Dhakare", "8888999259", "Ranjani"],
  ["Mukund Bhai", "Mukund Patel", "9423246740", "Shahada"],
  ["Nachiket C.", "Nachiket Chaudhari", "8888888164", "Raver Jalgaon"],
  ["Narmada Agro Ent.", "Praful Patil", "9284454433", "Shahada"],
  ["New Agro Agency", "Kundan Dusane", "9423478959", "Parsode padalda Hatti uajload"],
  ["Om Sai Agro Jamner", "Tejas Wagh", "8390682754", "Jamner"],
  ["Om Sai Swar chhaya", "Nitin Patil", "7350207885", "Jamner"],
  ["Parthana Agro", "Jitu Patil", "8225081667", "Turk Gorada"],
  ["Prashant Shinde", "Prashant Shinde", "7447366452", "jamner Pachora"],
  ["Rahul Patil", "Rahul Patil", "7389679115", "Dhaba MP"],
  ["Ram Agree Sales", "Harish Patil", "9309109344", "Jalgaon Office"],
  ["Ramesh Bhau Padsod", "Ramesh Patil", "7350572733", "Padsod"],
  ["Mauli Kushi Kendra", "Sachin Desale", "9579404749", "Hol JuneMohida"],
  ["Sagar Bhau", "Raghu Vyvhare", "7020847264", "Indapur"],
  ["Sai kruppa Krushi", "Sanjay Patil", "9403262661", "vadali"],
  ["Samartha Tredars Pachora", "Amol Patil", "7057229586", "Pachora"],
  ["Sambha Raddy sir", "Sambha Raddy sir", "9490095895", "AP"],
  ["Sandip p", "Sandip Patil", "8624076452", "Jalgaon Gramin & Chopada"],
  ["Sankalpa Ent.", "Sandip Patil", "9575588867", "Shahda - Nanduerbar"],
  ["Satguru Erigation", "Vijay Parkhad", "9423160474", "Jamner"],
  ["Shiv KK", "Ganesh Pawar", "7620461867", "Jalgaon Gramin"],
  ["Shriram Samrth Ent.", "Vikas Bhoi", "8329770063", "Neri"],
  ["Tapan Bhai", "Tapan Kapadia", "8965871666", "Burhanpur MP"],
  ["Thirtha Agro", "", "8308140003", "Damalda"],
  ["Unnati Agro Agency", "Ravindra Petkar", "9423289957", "Shindkheda Shahada Nandurbar"],
  ["Vaibhav P", "Vaibhav Patil", "7058836452", "Jamner"],
  ["Vighnaharta NimBhora", "Sunil Konde", "9011261345", "Nimbhor Raver"],
  ["Vikas P", "Vikas Patil", "8329946251", "Dharnagaon Jalgaon"],
  ["Vinay Agro", "Jagdish Patil", "8208719975", "Malpimpri"],
  ["Vishal Agro Soygaon", "Vishal Patil", "9209513200", "Soyagon"],
  ["Waghur Parisar Neri", "Bhagwat bhoi", "9689385040", "neri"],
  ["Yash Agro Pahur", "Yash Patil", "9356855374", "Pahur"],
  ["Yash Tractor", "Jagdish Chaudhari", "7020458160", "Nandurbar"],
];

function normalizePhoneDigits(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  // Sheet sometimes drops leading 9 on 10-digit Indian mobiles (verify in DB if unsure)
  if (d.length === 9) {
    const padded = `9${d}`;
    console.warn(`Phone normalized 9→10 digits: ${raw} → ${padded}`);
    d = padded;
  }
  if (d.length === 10) return d;
  return d;
}

function displayName(shop, person) {
  const s = String(shop || "").trim();
  const p = String(person || "").trim();
  if (!s && !p) return null;
  if (!p || p.toLowerCase() === s.toLowerCase()) return s || p;
  return `${s} (${p})`;
}

function jobTitleForPhone(digits) {
  return digits.endsWith("6452") ? "SALES" : "DEALER";
}

function buildPayloads() {
  const payloads = [];
  const seen = new Set();
  for (const [shop, contact, phoneRaw, village] of SHEET_ROWS) {
    const digits = normalizePhoneDigits(phoneRaw);
    if (!digits || digits.length < 10) {
      console.warn(`Skip row (invalid phone): ${shop} / ${phoneRaw}`);
      continue;
    }
    if (seen.has(digits)) {
      console.warn(`Skip duplicate phone: ${digits} (${shop})`);
      continue;
    }
    seen.add(digits);
    const name = displayName(shop, contact);
    if (!name) continue;
    const jobTitle = jobTitleForPhone(digits);
    payloads.push({
      name,
      phoneNumber: Number(digits),
      jobTitle,
      role: jobTitle,
      password: "1234",
      defaultVillage: String(village || "").trim() || undefined,
      isPasswordSet: false,
    });
  }
  return payloads;
}

async function deleteDealersAndSales() {
  const res = await User.deleteMany({ jobTitle: { $in: ["DEALER", "SALES"] } });
  return res.deletedCount ?? 0;
}

async function insertViaMongoose(payloads) {
  const hashed = await bcrypt.hash("1234", 10);
  const docs = payloads.map((p) => ({
    ...p,
    password: hashed,
  }));
  await User.insertMany(docs, { ordered: false });
}

async function insertViaApi(payloads) {
  const base = (process.env.API_BASE_URL || "https://api1.rambiotechplants.com/api/v1").replace(/\/$/, "");
  const url = `${base}/user/createUser`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const token = process.env.SUPER_ADMIN_BEARER_TOKEN;
  if (token) {
    const t = token.trim().replace(/^Bearer\s+/i, "");
    headers.Authorization = `Bearer ${t}`;
  }

  for (const p of payloads) {
    const body = {
      name: p.name,
      phoneNumber: String(p.phoneNumber),
      jobTitle: p.jobTitle,
      birthDate: "",
    };
    await axios.post(url, body, { headers, timeout: 60000 });
  }
}

async function main() {
  const execute = process.argv.includes("--execute");
  const createOnly = process.argv.includes("--create-only");
  const method = (process.env.SEED_METHOD || "mongoose").toLowerCase();

  const prodOnly = process.argv.includes("--prod-db");
  const mongoUrl = prodOnly
    ? process.env.PROD_MONGO_URL
    : process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (prodOnly && !mongoUrl) {
    console.error("--prod-db requires PROD_MONGO_URL in .env or the environment.");
    process.exit(1);
  }
  if (!mongoUrl) {
    console.error(
      "Missing database URL: set PROD_MONGO_URL (and pass --prod-db) or MONGO_URL in ENV_FILE (.env)."
    );
    process.exit(1);
  }

  try {
    const host = mongoUrl.replace(/^mongodb(\+srv)?:\/\//, "").split("@").pop()?.split("/")[0];
    console.log(`Using Mongo host: ${host || "(parse failed)"}${prodOnly ? " (--prod-db)" : ""}`);
  } catch {
    /* ignore */
  }

  const payloads = buildPayloads();
  console.log(`Prepared ${payloads.length} users (${payloads.filter((p) => p.jobTitle === "SALES").length} SALES, ${payloads.filter((p) => p.jobTitle === "DEALER").length} DEALER).`);
  if (!execute) {
    console.log("DRY RUN — pass --execute to delete DEALER+SALES and insert. Add --create-only to insert without delete.");
    payloads.slice(0, 5).forEach((p) => console.log("  ", p.phoneNumber, p.jobTitle, p.name));
    if (payloads.length > 5) console.log("  ...");
    process.exit(0);
  }

  await mongoose.connect(mongoUrl);
  try {
    let deleted = 0;
    if (!createOnly) {
      deleted = await deleteDealersAndSales();
      console.log(`Deleted ${deleted} users (jobTitle DEALER or SALES).`);
    }
    if (method === "api") {
      await insertViaApi(payloads);
      console.log(`Created ${payloads.length} users via API (${process.env.API_BASE_URL || "default"}).`);
    } else {
      await insertViaMongoose(payloads);
      console.log(`Inserted ${payloads.length} users via Mongoose.`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
