/**
 * Fix mistaken Order.salesPerson from an Excel sheet (two users only).
 *
 * Matching (per row):
 * 1) Resolve order by booking / orderId / _id (see column candidates below).
 * 2) Verify plant name + subtype (variety) from sheet vs Order (populate PlantCms, subtype subdoc).
 * 3) "Refer by" cell → map to User A or User B (Chhatrapati/Chhtrapati Agro dealer vs Sandip Patil Sir),
 *    using phone + name + aliases: chhatrapati/chhtrapati+agro, sandip/sanip+patil, "sandip p", etc.
 *
 * Expected columns (first header row) — script picks first match per group:
 * - Order key: "Booking NO.", "Booking No.", "Booking No", "orderId", "Order ID", "order_number", "_id"
 * - Plant: "Crop", "Plant type", "Plant Name", … (excludes "Plant Qty.")
 * - Variety / subtype: "Subtype", "Variety", "subtype", "Plant Subtype", "Variety name"
 * - Refer by: "Refer by", "Refer By", "Refrence", "Reference", "Order By", "Order\r\nBy"
 *
 * Env (Mongo — one of the following user pairs):
 *   MONGO_URL | PROD_MONGO_URL | MONGODB_URI | DATABASE
 *   (1) SALES_FIX_USER_A_PHONE + SALES_FIX_USER_B_PHONE (digits as User.phoneNumber)
 *   (2) SALES_FIX_USER_A_ID + SALES_FIX_USER_B_ID (24-char Mongo ObjectIds)
 *   (3) SALES_FIX_DISCOVER_PLAN_USERS=1 — resolve by plan names: "Chhtrapati Agro N." (DEALER) + "Sandip Patil Sir" (must be unique each)
 *
 * Usage (from FINAL_NURSERY_BE):
 *   node scripts/fix-sales-person-from-refer-by-xlsx.js "/path/to/file.xlsx"
 *   ... --apply          # writes updates (default is dry-run)
 *   ... --fix-dealer-name-typo   # optional: User A name sanpip → sandip (run once if desired)
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import XLSX from "xlsx";
import fs from "fs";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import PlantCms from "../models/plantCms.model.js";

dotenv.config();

const mongoUrl =
  process.env.PROD_MONGO_URL ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  process.env.DATABASE;

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeText(s) {
  if (s == null) return "";
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function digitsOnly(s) {
  return String(s ?? "").replace(/\D/g, "");
}

function phoneLast10(n) {
  const d = digitsOnly(String(n ?? ""));
  return d.length >= 10 ? d.slice(-10) : d;
}

/** Booking "24-25/B0237" → 237; "B0237" → 237 */
function extractOrderIdFromBooking(bookingNo) {
  if (bookingNo == null || bookingNo === "") return null;
  const bookingStr = String(bookingNo).trim();
  const m1 = bookingStr.match(/\/B(\d+)/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = bookingStr.match(/B(\d+)/i);
  if (m2) return parseInt(m2[1], 10);
  const m3 = bookingStr.match(/^(\d+)$/);
  if (m3) return parseInt(m3[1], 10);
  const m4 = bookingStr.match(/(\d+)/);
  if (m4) return parseInt(m4[1], 10);
  return null;
}

function isLikelyObjectId(s) {
  return typeof s === "string" && /^[a-f\d]{24}$/i.test(s.trim());
}

function findColumn(columns, candidates, { excludeColumn } = {}) {
  const ok = (col) => !excludeColumn || !excludeColumn(col);
  for (const cand of candidates) {
    const n = normalizeText(cand);
    const hit = columns.find((c) => ok(c) && normalizeText(c) === n);
    if (hit) return hit;
  }
  for (const cand of candidates) {
    const sub = normalizeText(cand).replace(/\s/g, "");
    const hit = columns.find((c) => ok(c) && normalizeText(c).replace(/\s/g, "") === sub);
    if (hit) return hit;
  }
  for (const cand of candidates) {
    const needle = normalizeText(cand);
    const hit = columns.find(
      (c) =>
        ok(c) &&
        (normalizeText(c).includes(needle) || needle.includes(normalizeText(c)))
    );
    if (hit) return hit;
  }
  return null;
}

/** Avoid matching "Plant Qty." when candidate is "Plant". */
const excludePlantQtyColumn = (col) => /\bqty\b|quantity|plant\s*qty/i.test(String(col));

function getSubtypeDoc(plantDoc, subtypeId) {
  if (!plantDoc?.subtypes?.length) return null;
  const sid = String(subtypeId);
  return plantDoc.subtypes.find((st) => String(st._id) === sid) || null;
}

/** Sheet text for Chhatrapati/Chhtrapati Agro dealer side (order exchange partner A). */
function chhatrapatiAgroAliasScore(refNorm) {
  let s = 0;
  const hasChha = /chhatrapati|chhtrapati|chatrapati/.test(refNorm);
  const hasAgro = /\bagro\b/.test(refNorm);
  if (hasChha && hasAgro) s += 58;
  if (refNorm.includes("chhatrapati agro") || refNorm.includes("chhtrapati agro")) s += 62;
  return s;
}

/** Sheet text for Sandip Patil Sir side (typo sanip, shorthand "sandip p"). */
function sandipPatilAliasScore(refNorm) {
  let s = 0;
  const hasSandipLike = /sandip|sanip|sndip/.test(refNorm);
  const hasPatil = /\bpatil\b/.test(refNorm);
  if (hasSandipLike && hasPatil) s += 58;
  if (hasSandipLike && refNorm.includes("sir")) s += 12;
  if (/\bsandip\s*p\b/.test(refNorm) || refNorm.includes("sandip p")) s += 52;
  if (refNorm.includes("sanip")) s += 48;
  return s;
}

/**
 * Pick dealer vs other party for Chhatrapati Agro ↔ Sandip Patil exchange rows.
 * @returns {{ userId: import('mongoose').Types.ObjectId } | { error: string }}
 */
function resolveReferByToUser(referByRaw, userA, userB) {
  const ref = String(referByRaw ?? "").trim();
  if (!ref) return { error: "empty_refer_by" };

  const refNorm = normalizeText(ref);
  const refDigits = digitsOnly(ref);

  let dealerUser = [userA, userB].find((u) => u.jobTitle === "DEALER");
  let otherUser = [userA, userB].find((u) => dealerUser && String(u._id) !== String(dealerUser._id));
  if (!dealerUser || !otherUser) {
    dealerUser = [userA, userB].find((u) =>
      /chhatrapati|chhtrapati|chatrapati/i.test(u.name || "")
    );
    otherUser = [userA, userB].find((u) => u !== dealerUser);
  }

  const scoreUser = (u) => {
    let s = 0;
    const last10 = phoneLast10(u.phoneNumber);
    if (last10.length === 10 && refDigits.includes(last10)) s += 100;
    const n = normalizeText(u.name);
    if (n && (refNorm.includes(n) || n.includes(refNorm))) s += 50;
    const tokens = n.split(" ").filter((t) => t.length >= 3);
    for (const t of tokens) {
      if (refNorm.includes(t)) s += 10;
    }
    if (dealerUser && String(u._id) === String(dealerUser._id)) {
      s += chhatrapatiAgroAliasScore(refNorm);
    }
    if (otherUser && String(u._id) === String(otherUser._id)) {
      s += sandipPatilAliasScore(refNorm);
    }
    return s;
  };

  const a = scoreUser(userA);
  const b = scoreUser(userB);

  if (a === 0 && b === 0) return { error: "refer_by_matches_neither_user" };
  if (a === b) return { error: "refer_by_ambiguous_same_score" };

  if (a > b) {
    if (a < 10) return { error: "refer_by_weak_match_user_a" };
    return { userId: userA._id };
  }
  if (b < 10) return { error: "refer_by_weak_match_user_b" };
  return { userId: userB._id };
}

function buildDealerUpdate(existingOrder, oldSpUser, newUser) {
  const out = {};
  if (!existingOrder.dealerOrder) {
    if (newUser.jobTitle === "DEALER") {
      out.dealer = newUser._id;
    } else if (
      oldSpUser?.jobTitle === "DEALER" &&
      existingOrder.dealer &&
      String(existingOrder.dealer) === String(oldSpUser._id)
    ) {
      out.dealer = null;
    }
  }
  return out;
}

async function findOrderByKey(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Order.findOne({ orderId: raw });
  }
  const str = String(raw).trim();
  if (isLikelyObjectId(str) && mongoose.isValidObjectId(str)) {
    return Order.findById(str);
  }
  const oid = extractOrderIdFromBooking(str);
  if (oid != null && !Number.isNaN(oid)) {
    return Order.findOne({ orderId: oid });
  }
  const asNum = parseInt(str, 10);
  if (!Number.isNaN(asNum) && String(asNum) === str.replace(/^0+/, "") || String(asNum) === str) {
    return Order.findOne({ orderId: asNum });
  }
  return null;
}

/** Plan User A: dealer Chhtrapati Agro N.; User B: Sandip Patil Sir */
const PLAN_USER_A_NAME_REGEX = /^Chhtrapati Agro N\.?\s*$/i;
const PLAN_USER_B_NAME_REGEX = /^Sandip Patil Sir\s*$/i;

async function loadUsersTwoParty() {
  const idA = process.env.SALES_FIX_USER_A_ID;
  const idB = process.env.SALES_FIX_USER_B_ID;
  if (idA && idB && mongoose.isValidObjectId(idA) && mongoose.isValidObjectId(idB)) {
    const userA = await User.findById(idA);
    const userB = await User.findById(idB);
    if (!userA) throw new Error(`User A not found for id=${idA}`);
    if (!userB) throw new Error(`User B not found for id=${idB}`);
    return { userA, userB, source: "SALES_FIX_USER_*_ID" };
  }

  const pa = process.env.SALES_FIX_USER_A_PHONE;
  const pb = process.env.SALES_FIX_USER_B_PHONE;
  if (pa && pb) {
    const na = Number(String(pa).replace(/\D/g, ""));
    const nb = Number(String(pb).replace(/\D/g, ""));
    const userA = await User.findOne({ phoneNumber: na });
    const userB = await User.findOne({ phoneNumber: nb });
    if (!userA) throw new Error(`User A not found for phoneNumber=${na}`);
    if (!userB) throw new Error(`User B not found for phoneNumber=${nb}`);
    return { userA, userB, source: "SALES_FIX_USER_*_PHONE" };
  }

  if (process.env.SALES_FIX_DISCOVER_PLAN_USERS === "1") {
    const dealersA = await User.find({
      $or: [
        { name: PLAN_USER_A_NAME_REGEX },
        { name: /^Chhatrapati Agro N\.?\s*$/i },
      ],
      jobTitle: "DEALER",
    }).lean();
    const salesB = await User.find({ name: PLAN_USER_B_NAME_REGEX }).lean();
    if (dealersA.length !== 1) {
      throw new Error(
        `SALES_FIX_DISCOVER_PLAN_USERS: expected exactly 1 DEALER named Chhtrapati Agro N., found ${dealersA.length}`
      );
    }
    if (salesB.length !== 1) {
      throw new Error(
        `SALES_FIX_DISCOVER_PLAN_USERS: expected exactly 1 user named Sandip Patil Sir, found ${salesB.length}`
      );
    }
    const userA = await User.findById(dealersA[0]._id);
    const userB = await User.findById(salesB[0]._id);
    return { userA, userB, source: "SALES_FIX_DISCOVER_PLAN_USERS" };
  }

  throw new Error(
    "Set SALES_FIX_USER_A_PHONE + SALES_FIX_USER_B_PHONE, or SALES_FIX_USER_A_ID + SALES_FIX_USER_B_ID, or SALES_FIX_DISCOVER_PLAN_USERS=1"
  );
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath || !fs.existsSync(filePath)) {
    console.error("Usage: node scripts/fix-sales-person-from-refer-by-xlsx.js <path-to.xlsx> [--apply] [--fix-dealer-name-typo]");
    console.error(
      "Requires MONGO_URL and user pair: *_PHONE, *_ID, or SALES_FIX_DISCOVER_PLAN_USERS=1 (see script header)"
    );
    process.exit(1);
  }

  if (!mongoUrl) {
    console.error("Missing MONGO_URL / PROD_MONGO_URL / MONGODB_URI / DATABASE");
    process.exit(1);
  }

  const apply = hasFlag("apply");
  const fixTypo = hasFlag("fix-dealer-name-typo");

  await mongoose.connect(mongoUrl);
  console.log("Connected:", mongoose.connection.host);

  const { userA, userB, source } = await loadUsersTwoParty();
  console.log("Users loaded via:", source);
  console.log("User A:", userA.name, userA.phoneNumber, userA.jobTitle, userA._id);
  console.log("User B:", userB.name, userB.phoneNumber, userB.jobTitle, userB._id);

  if (fixTypo) {
    const withTypo = [userA, userB].find((u) => /sanpip/i.test(u.name));
    if (!withTypo) {
      console.warn("--fix-dealer-name-typo: no 'sanpip' in either user's name; skipping");
    } else {
      const newName = withTypo.name.replace(/sanpip/gi, "sandip");
      if (apply) {
        await User.updateOne({ _id: withTypo._id }, { $set: { name: newName } });
        console.log("Updated user name:", withTypo.name, "→", newName);
      } else {
        console.log("[dry-run] would update user name:", withTypo.name, "→", newName);
      }
    }
  }

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) {
    console.error("No rows in sheet");
    process.exit(1);
  }

  const columns = Object.keys(rows[0]);
  console.log("Columns:", columns);

  const colOrder = findColumn(columns, [
    "Booking NO.",
    "Booking No.",
    "Booking No",
    "orderId",
    "Order ID",
    "order_number",
    "Order Id",
    "_id",
  ]);
  const colPlant = findColumn(
    columns,
    [
      "Crop",
      "Plant type",
      "Plant Name",
      "plantName",
      "Plant name",
      "Expected\r\nNursery",
      "Plant",
      "plant",
    ],
    { excludeColumn: excludePlantQtyColumn }
  );
  const colVariety = findColumn(columns, [
    "Subtype",
    "Variety",
    "subtype",
    "Plant Subtype",
    "Variety name",
    "Variety Name",
  ]);
  const colRefer = findColumn(columns, [
    "Refer by",
    "Refer By",
    "Refrence",
    "Reference",
    "Order By",
    "Order\r\nBy",
  ]);

  if (!colOrder || !colPlant || !colVariety || !colRefer) {
    console.error("Missing column(s). Found:", {
      order: colOrder,
      plant: colPlant,
      variety: colVariety,
      referBy: colRefer,
    });
    process.exit(1);
  }

  console.log("Using columns:", { order: colOrder, plant: colPlant, variety: colVariety, referBy: colRefer });

  let skipped = 0;
  let applied = 0;
  let proposed = 0;
  let unchanged = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const orderKey = row[colOrder];
    const sheetPlant = row[colPlant];
    const sheetVariety = row[colVariety];
    const referBy = row[colRefer];

    const keyEmpty =
      orderKey === "" ||
      orderKey === null ||
      orderKey === undefined ||
      (typeof orderKey === "number" && !Number.isFinite(orderKey)) ||
      (typeof orderKey === "number" && orderKey === 0);
    if (keyEmpty) {
      skipped++;
      continue;
    }

    const order = await findOrderByKey(orderKey);
    if (!order) {
      errors.push({ row: rowNum, reason: "order_not_found", orderKey });
      skipped++;
      continue;
    }

    const plantDoc = await PlantCms.findById(order.plantName);
    if (!plantDoc) {
      errors.push({ row: rowNum, reason: "plant_cms_not_found", orderId: order.orderId });
      skipped++;
      continue;
    }

    const plantNormSheet = normalizeText(sheetPlant);
    const plantNormDb = normalizeText(plantDoc.name);
    if (!plantNormSheet || plantNormSheet !== plantNormDb) {
      errors.push({
        row: rowNum,
        reason: "plant_mismatch",
        orderId: order.orderId,
        sheet: sheetPlant,
        db: plantDoc.name,
      });
      skipped++;
      continue;
    }

    const subDoc = getSubtypeDoc(plantDoc, order.plantSubtype);
    const dbVariety = subDoc?.name ?? "";
    const varNormSheet = normalizeText(sheetVariety);
    const varNormDb = normalizeText(dbVariety);
    if (!varNormSheet || varNormSheet !== varNormDb) {
      errors.push({
        row: rowNum,
        reason: "variety_mismatch",
        orderId: order.orderId,
        sheet: sheetVariety,
        db: dbVariety,
      });
      skipped++;
      continue;
    }

    const target = resolveReferByToUser(referBy, userA, userB);
    if (target.error) {
      errors.push({ row: rowNum, reason: target.error, orderId: order.orderId, referBy });
      skipped++;
      continue;
    }

    const targetId = String(target.userId);
    const currentId = String(order.salesPerson);

    if (targetId === currentId) {
      console.log(`Row ${rowNum} order ${order.orderId}: salesPerson already correct (${targetId})`);
      unchanged++;
      continue;
    }

    const oldSpUser = await User.findById(order.salesPerson);
    const newUser = target.userId.equals(userA._id) ? userA : userB;

    const dealerPatch = buildDealerUpdate(order, oldSpUser, newUser);
    const oldName = oldSpUser?.name || currentId;
    const newName = newUser.name || targetId;

    const historyEntry = {
      field: "salesPerson",
      previousValue: order.salesPerson,
      newValue: newUser._id,
      changedBy: null,
      notes: `Sales person changed from ${oldName} to ${newName} (bulk refer-by xlsx row ${rowNum})`,
    };

    console.log(
      `${apply ? "APPLY" : "DRY"} row ${rowNum} orderId=${order.orderId}: ${oldName} → ${newName} | dealer patch:`,
      JSON.stringify(dealerPatch)
    );

    if (apply) {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            salesPerson: newUser._id,
            ...dealerPatch,
          },
          $push: { orderEditHistory: historyEntry },
        }
      );
      applied++;
    } else {
      proposed++;
    }
  }

  console.log("\n--- Summary ---");
  console.log("Mode:", apply ? "APPLY (writes)" : "DRY-RUN (no writes)");
  console.log("Proposed updates (dry-run only):", proposed);
  console.log("Applied updates:", applied);
  console.log("Unchanged (already correct):", unchanged);
  console.log("Skipped:", skipped);
  if (errors.length) {
    console.log("Errors / skips (first 40):");
    console.log(JSON.stringify(errors.slice(0, 40), null, 2));
    if (errors.length > 40) console.log(`... and ${errors.length - 40} more`);
  }

  await mongoose.connection.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
