/**
 * Integration flow: secondary shed ↔ booking slot stock APIs.
 *
 * Usage (HTTP, needs running API + credentials):
 *   SMOKE_PHONE=... SMOKE_PASSWORD=... node scripts/test-secondary-shed-flow.mjs
 *
 * Usage (DB-only rollup spot-check, no HTTP):
 *   node scripts/test-secondary-shed-flow.mjs --db-only
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import PlantOutward from "../models/plantOutward.model.js";
import PlantSlot from "../models/slots.model.js";
import {
  aggregateShedStockBySlotIds,
  getSlotSecondaryShedBreakdown,
  rollupShedStockForSlots,
} from "../services/secondaryShedSlotStock.service.js";

const MONGO_URL =
  process.env.FLOW_TEST_MONGO_URL ||
  process.env.STAGE_MONGO_URL ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  "mongodb://localhost:27017/nursery";

const base = (process.env.API_BASE_URL || "http://localhost:8000").replace(
  /\/api\/v1\/?$/,
  ""
);

function log(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function unwrap(raw) {
  let cur = raw;
  if (cur?.data && (cur.status != null || cur.message != null)) cur = cur.data;
  return cur;
}

async function req(path, { token, method = "GET", body } = {}) {
  const url = `${base}/api/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: unwrap(json), raw: json };
}

async function runDbChecks() {
  console.log("\n========== DB: secondary shed slot linkage ==========\n");
  await mongoose.connect(MONGO_URL);
  console.log(`DB: ${mongoose.connection.name}\n`);

  const linkedCount = await PlantOutward.countDocuments({
    "secondaryInward.linkedBookingSlotId": { $exists: true, $ne: null },
  });
  log("PlantOutward with linkedBookingSlotId", linkedCount > 0, `count=${linkedCount}`);

  const samplePo = await PlantOutward.findOne({
    "secondaryInward.linkedBookingSlotId": { $exists: true, $ne: null },
  })
    .select("secondaryInward batchId")
    .lean();

  if (!samplePo) {
    console.log(
      "⚠️  No linked secondary inward lines in this DB — rollup/breakdown checks skipped."
    );
    console.log(
      "    Point FLOW_TEST_MONGO_URL or STAGE_MONGO_URL at a DB with secondary shed data."
    );
    await mongoose.disconnect();
    return { ok: true, skipped: true, reason: "no_linked_data" };
  }

  const slotId = samplePo.secondaryInward.find((si) => si.linkedBookingSlotId)
    ?.linkedBookingSlotId;
  const slotStr = String(slotId);

  const rollupDb = await aggregateShedStockBySlotIds([
    new mongoose.Types.ObjectId(slotStr),
  ]);
  const rollupPure = rollupShedStockForSlots([samplePo], [slotStr]);
  const dbAgg = rollupDb.get(slotStr);
  const pureAgg = rollupPure.get(slotStr);

  const rollupMatch =
    dbAgg &&
    pureAgg &&
    dbAgg.shedAvailableInShed === pureAgg.shedAvailableInShed &&
    dbAgg.shedSyncedPlants === pureAgg.shedSyncedPlants;
  log(
    "aggregateShedStockBySlotIds matches pure rollup for sample",
    rollupMatch,
    rollupMatch
      ? `avail=${dbAgg.shedAvailableInShed} synced=${dbAgg.shedSyncedPlants}`
      : `db=${JSON.stringify(dbAgg)} pure=${JSON.stringify(pureAgg)}`
  );

  const breakdown = await getSlotSecondaryShedBreakdown(slotStr);
  const breakdownOk =
    breakdown?.slot?._id &&
    Array.isArray(breakdown.batches) &&
    breakdown.summary &&
    typeof breakdown.summary.actualPlants === "number";
  log(
    "getSlotSecondaryShedBreakdown",
    breakdownOk,
    breakdownOk
      ? `batches=${breakdown.batches.length} actualPlants=${breakdown.summary.actualPlants}`
      : "missing shape"
  );

  if (breakdown?.batches?.[0]) {
    const b = breakdown.batches[0];
    log(
      "batch has sowing anchor fields",
      "anchorSowingLabel" in b || "anchorSowingDate" in b,
      `batchNumber=${b.batchNumber}`
    );
    const ln = b.lines?.[0];
    if (ln) {
      log(
        "line pendingSlotSync",
        typeof ln.pendingSlotSync === "number",
        `pending=${ln.pendingSlotSync} avail=${ln.availableQuantity}`
      );
    }
  }

  await mongoose.disconnect();
  return { ok: linkedCount > 0 && rollupMatch && breakdownOk, skipped: false };
}

async function runHttpChecks() {
  const phone = process.env.SMOKE_PHONE;
  const password = process.env.SMOKE_PASSWORD;
  if (!phone || !password) {
    console.log("Set SMOKE_PHONE and SMOKE_PASSWORD for HTTP flow checks.");
    return null;
  }

  console.log("\n========== HTTP: secondary shed + slot stock ==========\n");

  const login = await req("/user/login", {
    method: "POST",
    body: { phoneNumber: phone, password },
  });
  if (login.status !== 200) {
    log("login", false, String(login.status));
    return false;
  }
  const token =
    login.data?.accessToken ||
    login.data?.token ||
    login.raw?.data?.accessToken;
  log("login", Boolean(token));

  const dash = await req(
    "/laboutward/secondary-mobile-dashboard?upcomingDays=7&syncSlotStock=true",
    { token }
  );
  log("secondary-mobile-dashboard + syncSlotStock", dash.status === 200);
  const inwardLines = dash.data?.availableSecondaryInwardLines;
  console.log(
    "  availableSecondaryInwardLines:",
    Array.isArray(inwardLines) ? inwardLines.length : typeof inwardLines
  );

  const vehicles = await req(
    "/laboutward/secondary/vehicle-dispatches?page=1&limit=3",
    { token }
  );
  log("vehicle-dispatches", vehicles.status === 200);
  const v0 = vehicles.data?.items?.[0];
  if (v0?._id) {
    const alloc = await req(
      `/laboutward/secondary/vehicle-dispatch/${v0._id}/allocation-suggestions?plantRowIndex=0&eligibleOnly=true`,
      { token }
    );
    log(
      "allocation-suggestions",
      alloc.status === 200 && Array.isArray(alloc.data?.suggestedFulfillmentSequence),
      `suggestions=${alloc.data?.suggestions?.length ?? 0}`
    );
  }

  await mongoose.connect(MONGO_URL);
  const slotWithLink = await PlantOutward.findOne({
    "secondaryInward.linkedBookingSlotId": { $exists: true, $ne: null },
  })
    .select("secondaryInward")
    .lean();
  let stockOk = false;
  let breakdownOk = false;

  if (slotWithLink) {
    const slotId = String(
      slotWithLink.secondaryInward.find((si) => si.linkedBookingSlotId)
        .linkedBookingSlotId
    );
    const plantSlot = await PlantSlot.findOne({
      "subtypeSlots.slots._id": new mongoose.Types.ObjectId(slotId),
    })
      .select("plantId year subtypeSlots.subtypeId")
      .lean();

    if (plantSlot) {
      let subtypeId = null;
      for (const st of plantSlot.subtypeSlots || []) {
        if ((st.slots || []).some((s) => String(s._id) === slotId)) {
          subtypeId = st.subtypeId;
          break;
        }
      }
      const plantId = plantSlot.plantId?._id ?? plantSlot.plantId;
      if (plantId && subtypeId) {
        const stockPath = `/slots/stock-entry?plantId=${plantId}&subtypeId=${subtypeId}&year=${plantSlot.year}`;
        const stock = await req(stockPath, { token });
        const row = (stock.data?.slots || []).find((s) => String(s._id) === slotId);
        stockOk =
          stock.status === 200 &&
          row &&
          typeof row.actualAvailable === "number" &&
          typeof row.shedSyncedPlants === "number";
        log(
          "GET stock-entry (actualAvailable + shed fields)",
          stockOk,
          row
            ? `actualAvailable=${row.actualAvailable} shedSynced=${row.shedSyncedPlants}`
            : "row not found"
        );

        const br = await req(`/slots/${slotId}/secondary-shed-breakdown`, { token });
        breakdownOk =
          br.status === 200 &&
          br.data?.success !== false &&
          Array.isArray(br.data?.batches);
        log(
          "GET secondary-shed-breakdown",
          breakdownOk,
          `batches=${br.data?.batches?.length ?? 0}`
        );
      }
    }
  } else {
    log("stock-entry / breakdown", false, "no linked slot in DB");
  }

  await mongoose.disconnect();
  return dash.status === 200 && stockOk && breakdownOk;
}

async function main() {
  const dbOnly = process.argv.includes("--db-only");
  let dbPass = false;
  let dbSkipped = false;
  let httpPass = null;

  try {
    const dbResult = await runDbChecks();
    if (dbResult && typeof dbResult === "object") {
      dbPass = dbResult.ok;
      dbSkipped = Boolean(dbResult.skipped);
    } else {
      dbPass = Boolean(dbResult);
    }
  } catch (e) {
    console.error("DB checks failed:", e.message);
    dbPass = false;
  }

  if (!dbOnly) {
    try {
      httpPass = await runHttpChecks();
    } catch (e) {
      console.error("HTTP checks failed:", e.message);
      httpPass = false;
    }
  }

  console.log("\n========== Summary ==========");
  if (dbSkipped) console.log("DB checks: SKIPPED (empty / no linked shed data)");
  else console.log(`DB checks: ${dbPass ? "PASS" : "FAIL"}`);
  if (httpPass === null) console.log("HTTP checks: SKIPPED (no credentials)");
  else console.log(`HTTP checks: ${httpPass ? "PASS" : "FAIL"}`);

  const exitOk = (dbPass || dbSkipped) && (httpPass === null || httpPass);
  process.exit(exitOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
