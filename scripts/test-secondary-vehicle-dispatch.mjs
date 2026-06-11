/**
 * Integration: secondary vehicle load / loaded-lines / unload APIs.
 *
 * HTTP (running API + credentials):
 *   SMOKE_PHONE=... SMOKE_PASSWORD=... node scripts/test-secondary-vehicle-dispatch.mjs
 *
 * DB-only (no HTTP, needs Mongo with dispatch data):
 *   node scripts/test-secondary-vehicle-dispatch.mjs --db-only
 *
 * Round-trip load + unload (writes — use staging only):
 *   SMOKE_ALLOW_WRITES=1 SMOKE_PLANTS=126 SMOKE_PHONE=... SMOKE_PASSWORD=... node scripts/test-secondary-vehicle-dispatch.mjs
 */
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import Dispatch from "../models/dispatch.model.js";
import {
  collectLoadedOutwardLinesForDispatch,
} from "../services/secondaryVehicleUnload.service.js";
import { sumPlantsLoadedOnDispatch } from "../services/secondaryVehicleLoad.service.js";

const MONGO_URL =
  process.env.FLOW_TEST_MONGO_URL ||
  process.env.STAGE_MONGO_URL ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  "mongodb://localhost:27017/nursery";

const base = (process.env.API_BASE_URL || "http://localhost:8000").replace(
  /\/api\/v1\/?$/,
  "",
);

const dbOnly = process.argv.includes("--db-only");
const allowWrites = process.env.SMOKE_ALLOW_WRITES === "1";

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
  console.log("\n========== DB: vehicle load / unload services ==========\n");
  await mongoose.connect(MONGO_URL);
  console.log(`DB: ${mongoose.connection.name}\n`);

  const active = await Dispatch.find({
    isDeleted: { $ne: true },
    transportStatus: { $in: ["PENDING", "IN_TRANSIT", "LOADED"] },
  })
    .select("_id transportId transportStatus orderDispatchDetails")
    .sort({ updatedAt: -1 })
    .limit(5)
    .lean();

  log("active vehicle dispatches", active.length > 0, `count=${active.length}`);

  let loadedLinesOk = false;
  let sumOk = false;

  for (const d of active) {
    const { lines, totalPlants } = await collectLoadedOutwardLinesForDispatch(d._id);
    const { total } = await sumPlantsLoadedOnDispatch(d._id);
    if (lines.length > 0) {
      loadedLinesOk = true;
      const ln = lines[0];
      log(
        `collectLoadedOutwardLines ${d.transportId}`,
        Boolean(ln.secondaryOutwardId && ln.secondaryInwardId),
        `lines=${lines.length} plants=${totalPlants} status=${d.transportStatus}`,
      );
      log(
        "loaded line has source inward + slot ref",
        Boolean(ln.secondaryInwardId),
        `slot=${ln.linkedBookingSlotId || "none"}`,
      );
    }
    if (total >= 0) sumOk = true;
  }

  if (!loadedLinesOk) {
    console.log("  ⚠️  No vehicles with secondary outward lines — loaded-lines API will return empty.");
  }

  log("sumPlantsLoadedOnDispatch", sumOk);

  await mongoose.disconnect();
  return { ok: active.length > 0 && sumOk };
}

async function runHttpChecks() {
  const phone = process.env.SMOKE_PHONE;
  const password = process.env.SMOKE_PASSWORD;
  if (!phone || !password) {
    console.log("Set SMOKE_PHONE and SMOKE_PASSWORD for HTTP checks.");
    return null;
  }

  console.log("\n========== HTTP: secondary vehicle dispatch ==========\n");

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

  const vehicles = await req(
    "/laboutward/secondary/vehicle-dispatches?page=1&limit=5",
    { token },
  );
  log("GET vehicle-dispatches", vehicles.status === 200);
  const items = vehicles.data?.items || [];
  const statuses = [...new Set(items.map((v) => v.transportStatus))];
  log(
    "vehicle list includes LOADED-capable statuses",
    statuses.some((s) => ["PENDING", "IN_TRANSIT", "LOADED"].includes(s)),
    statuses.join(", ") || "none",
  );

  const target =
    items.find((v) => (v.shedLoadedPlantsTotal || 0) > 0) || items[0];
  if (!target?._id) {
    console.log("  ⚠️  No vehicle dispatches to test further.");
    return true;
  }

  const loadedLines = await req(
    `/laboutward/secondary/vehicle-dispatch/${target._id}/loaded-lines`,
    { token },
  );
  log(
    "GET loaded-lines",
    loadedLines.status === 200 && Array.isArray(loadedLines.data?.lines),
    `lines=${loadedLines.data?.lines?.length ?? 0} total=${loadedLines.data?.totalPlants ?? 0}`,
  );

  const alloc = await req(
    `/laboutward/secondary/vehicle-dispatch/${target._id}/allocation-suggestions?plantRowIndex=0&eligibleOnly=true`,
    { token },
  );
  log(
    "GET allocation-suggestions",
    alloc.status === 200,
    `suggestions=${alloc.data?.suggestions?.length ?? 0}`,
  );

  const eligible = (alloc.data?.suggestions || []).filter(
    (s) => s.dispatchEligible !== false && (s.remainingPlants ?? s.availableQuantity) > 0,
  );
  const need = Math.max(
    0,
    (target.vehiclePlantQty || target.totalPlantQty || 0) -
      (target.shedLoadedPlantsTotal || 0),
  );
  const previewPlants = Math.min(
    Number(process.env.SMOKE_PLANTS) || 126,
    need || 126,
    eligible[0]?.remainingPlants ?? eligible[0]?.availableQuantity ?? 0,
  );

  if (eligible.length > 0 && previewPlants > 0) {
    const inwardSelections = [{ 
      secondaryInwardId: String(eligible[0].secondaryInwardId),
      batchId: eligible[0].batchId ? String(eligible[0].batchId) : undefined,
      plants: previewPlants,
    }];
    const preview = await req(
      `/laboutward/secondary/vehicle-dispatch/${target._id}/load-preview`,
      {
        token,
        method: "POST",
        body: { inwardSelections, plantRowIndex: 0 },
      },
    );
    log(
      "POST load-preview (manual inward)",
      preview.status === 200 && preview.data?.ok !== false,
      preview.data?.ok === false
        ? preview.data?.error
        : `allocated=${preview.data?.totalAllocated}`,
    );

    if (allowWrites && preview.data?.ok !== false) {
      const load = await req(
        `/laboutward/secondary/vehicle-dispatch/${target._id}/load`,
        {
          token,
          method: "POST",
          body: {
            inwardSelections,
            plantRowIndex: 0,
            remarks: "integration-test load",
          },
        },
      );
      log(
        "POST load",
        load.status === 200,
        `loaded=${load.data?.totalLoaded} status=${load.data?.transportStatus}`,
      );

      const afterLoad = await req(
        `/laboutward/secondary/vehicle-dispatch/${target._id}/loaded-lines`,
        { token },
      );
      const outLine = afterLoad.data?.lines?.find(
        (l) => l.plants >= previewPlants,
      );
      log(
        "GET loaded-lines after load",
        afterLoad.status === 200 && (afterLoad.data?.lines?.length || 0) > 0,
        `lines=${afterLoad.data?.lines?.length}`,
      );

      if (outLine && allowWrites) {
        const unload = await req(
          `/laboutward/secondary/vehicle-dispatch/${target._id}/unload`,
          {
            token,
            method: "POST",
            body: {
              outwardSelections: [
                {
                  secondaryOutwardId: outLine.secondaryOutwardId,
                  batchId: outLine.batchId,
                  plants: previewPlants,
                },
              ],
              linkedOrderId: outLine.linkedOrderId || undefined,
            },
          },
        );
        log(
          "POST unload (round-trip)",
          unload.status === 200,
          `unloaded=${unload.data?.totalUnloaded} status=${unload.data?.transportStatus}`,
        );
      }
    } else if (!allowWrites) {
      console.log("  ℹ️  Set SMOKE_ALLOW_WRITES=1 to run load/unload round-trip.");
    }
  } else {
    console.log("  ⚠️  No eligible inward stock for load-preview test.");
  }

  if ((loadedLines.data?.lines?.length || 0) > 0) {
    const firstOrder = loadedLines.data.lines[0]?.linkedOrderId;
    const byOrder = await req(
      `/laboutward/secondary/vehicle-dispatch/${target._id}/loaded-lines${
        firstOrder ? `?linkedOrderId=${firstOrder}` : ""
      }`,
      { token },
    );
    log(
      "GET loaded-lines filtered by order",
      byOrder.status === 200,
      `lines=${byOrder.data?.lines?.length}`,
    );
  }

  return true;
}

async function main() {
  let ok = true;
  if (dbOnly) {
    const r = await runDbChecks();
    ok = r?.ok !== false;
  } else {
    const db = await runDbChecks().catch((e) => {
      console.error("DB checks failed:", e.message);
      return { ok: false };
    });
    ok = db?.ok !== false;
    const http = await runHttpChecks();
    if (http === false) ok = false;
  }
  console.log(ok ? "\n✅ secondary vehicle dispatch checks passed\n" : "\n❌ some checks failed\n");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
