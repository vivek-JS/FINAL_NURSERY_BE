/**
 * Change sow date on completed sowing requests (PROD) — reslots by new ready date
 * via editSowEntryOnSlots and syncs Order.sowingDoneAt for orders marked by the request.
 *
 *   TZ=UTC node scripts/edit-sow-date-prod.mjs           # dry-run
 *   TZ=UTC node scripts/edit-sow-date-prod.mjs --apply   # write PROD
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import SowingRequest from "../models/sowingRequest.model.js";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import { editSowEntryOnSlots, pushEvent } from "../controllers/sowingCompleteHelpers.js";
import {
  parseLocalDate,
  fmtDDMMYYYY,
  addDays,
  findSlotByPlantReadyDate,
} from "../controllers/sowingSlotReadyHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");

const EDITS = [
  { requestNumber: "SR202610170002", sowDate: "2026-10-15" },
  { requestNumber: "SR202610170004", sowDate: "2026-10-16" },
];

async function currentSlotBatches(requestId) {
  const docs = await PlantSlot.find({
    "subtypeSlots.slots.sowingBatches.sowingRequestId": requestId,
  })
    .select("subtypeSlots")
    .lean();
  const out = [];
  for (const d of docs) {
    for (const st of d.subtypeSlots || []) {
      for (const sl of st.slots || []) {
        for (const b of sl.sowingBatches || []) {
          if (String(b.sowingRequestId) === String(requestId)) {
            out.push({
              slotId: String(sl._id),
              window: `${sl.startDay} – ${sl.endDay}`,
              sowingDate: b.sowingDate,
              plantReadyDate: b.plantReadyDate,
              plantReadyDays: b.plantReadyDays,
              plantsSowed: b.plantsSowed,
            });
          }
        }
      }
    }
  }
  return out;
}

const SOW_EVENT_TYPES = ["SOW_COMPLETED", "PLANTS_SOWED", "ORDERS_MARKED_SOWED"];

/** Sowing-entries list reads sow/ready/slot from event meta first — keep it in sync with the slot batch. */
function syncEventMeta(request, { sowYmd, readyStr, slotId }) {
  const changes = [];
  for (const ev of request.completionEvents || []) {
    if (!SOW_EVENT_TYPES.includes(ev.type) || !ev.meta) continue;
    const meta = { ...ev.meta };
    const set = (key, val) => {
      if (meta[key] != null && String(meta[key]) !== String(val)) {
        changes.push(`${ev.type}.${key}: ${meta[key]} → ${val}`);
        meta[key] = val;
      }
    };
    set("sowDate", sowYmd);
    set("plantReadyDate", readyStr);
    set("orderReadyDate", readyStr);
    set("readyDate", readyStr);
    if (meta.appliedSlotId != null) {
      set("appliedSlotId", typeof meta.appliedSlotId === "string" ? String(slotId) : slotId);
    }
    ev.meta = meta;
  }
  if (changes.length) request.markModified("completionEvents");
  return changes;
}

async function main() {
  if (process.env.TZ !== "UTC") {
    throw new Error("Run with TZ=UTC so sow dates are stored at 12:00Z like the server");
  }
  console.log(APPLY ? "APPLY sow-date edits — PROD\n" : "DRY-RUN sow-date edits — PROD\n");

  await mongoose.connect(process.env.PROD_MONGO_URL);
  const admin = await mongoose.connection
    .collection("users")
    .findOne({ _id: new mongoose.Types.ObjectId("69c74937ac73e9c36b673925") });
  if (!admin) throw new Error("Admin user not found");

  for (const edit of EDITS) {
    const request = await SowingRequest.findOne({ requestNumber: edit.requestNumber });
    console.log("─".repeat(70));
    if (!request) {
      console.log(`${edit.requestNumber}: NOT FOUND`);
      continue;
    }
    const newSow = parseLocalDate(edit.sowDate);
    const oldSowStr = request.sowingCompletedDate ? fmtDDMMYYYY(request.sowingCompletedDate) : "—";
    const newSowStr = fmtDDMMYYYY(newSow);
    const batches = await currentSlotBatches(request._id);
    const readyDays = Number(batches[0]?.plantReadyDays) || 0;
    const newReadyStr = readyDays ? fmtDDMMYYYY(addDays(newSow, readyDays)) : "?";
    const target = readyDays
      ? await findSlotByPlantReadyDate(request.plantId, request.subtypeId, newReadyStr)
      : null;
    const orders = await Order.find({ sowingDoneRequestId: request._id })
      .select("orderId sowingDoneAt deliveryDate")
      .lean();

    console.log(
      `${edit.requestNumber} · ${request.subtypeName} · ${request.sowedQuantity} plants · ${request.isExcessiveSowing ? "excess" : "order"}`
    );
    console.log(`Sow:   ${oldSowStr} → ${newSowStr}`);
    for (const b of batches) {
      console.log(`Slot now:  ${b.window} (${b.slotId}) · sow ${b.sowingDate} · ready ${b.plantReadyDate} (${b.plantReadyDays}d) · ${b.plantsSowed}`);
    }
    console.log(
      `Slot new:  ${target ? `${target.startDay} – ${target.endDay} (${target.slotId})` : "— NONE —"} · ready ${newReadyStr}`
    );
    for (const o of orders) {
      console.log(
        `Order #${o.orderId} · sowingDoneAt ${o.sowingDoneAt ? fmtDDMMYYYY(o.sowingDoneAt) : "—"} → ${newSowStr} · delivery ${o.deliveryDate ? fmtDDMMYYYY(o.deliveryDate) : "—"}`
      );
    }

    if (oldSowStr === newSowStr) {
      const b = batches[0];
      const changes = b
        ? syncEventMeta(request, {
            sowYmd: edit.sowDate,
            readyStr: b.plantReadyDate,
            slotId: new mongoose.Types.ObjectId(b.slotId),
          })
        : [];
      if (!changes.length) {
        console.log("Already on target date — events in sync");
        continue;
      }
      console.log("Event meta out of sync:");
      for (const c of changes) console.log(`  ${c}`);
      if (APPLY) {
        await request.save();
        console.log("APPLIED event meta sync");
      }
      continue;
    }
    if (!target?.slotId) {
      console.log("No slot for new ready date — skip");
      continue;
    }
    if (!APPLY) continue;

    const result = await editSowEntryOnSlots(request, {
      by: admin._id,
      sowDate: edit.sowDate,
      reason: "EDIT_SOW_DATE",
    });
    syncEventMeta(request, {
      sowYmd: edit.sowDate,
      readyStr: result.toReadyDate,
      slotId: result.toSlotId,
    });
    pushEvent(request, {
      type: "NOTE",
      by: admin._id,
      quantity: result.plantsSowed,
      unit: "plants",
      message: `Sow date edited ${oldSowStr} → ${result.sowingDate} · ready ${result.fromReadyDate} → ${result.toReadyDate}`,
      meta: { ...result, editType: "SOW_ENTRY_EDITED" },
    });
    await request.save();

    if (orders.length) {
      await Order.updateMany(
        { sowingDoneRequestId: request._id },
        { $set: { sowingDoneAt: request.sowingCompletedDate } }
      );
    }
    console.log(
      `APPLIED · ready ${result.fromReadyDate} → ${result.toReadyDate} · slotChanged=${result.slotChanged} · orders synced ${orders.length}`
    );
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
