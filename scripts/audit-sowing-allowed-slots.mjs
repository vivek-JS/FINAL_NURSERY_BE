/**
 * Read-only audit of slots for sowingAllowed plants.
 * Compares stored slots with createSlotsForNewSubtype rules.
 * Does not write. Exit 2 if a booked or sowed slot is malformed.
 *
 *   node scripts/audit-sowing-allowed-slots.mjs
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import moment from "moment";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

function parseCmsDate(dateStr) {
  const raw = String(dateStr || "").trim();
  if (!raw) return null;
  if (raw.includes("-") && raw.split("-")[0].length === 4) {
    const m = moment(raw, "YYYY-MM-DD", true);
    return m.isValid() ? m : null;
  }
  const m = moment(raw, "DD-MM-YYYY", true);
  return m.isValid() ? m : null;
}

function expectedSlotsForSubtype(subtype) {
  const start = parseCmsDate(subtype.slotStartDate);
  const end = parseCmsDate(subtype.slotEndDate);
  const slotDays = Number(subtype.slotDays);
  if (!start || !end || !Number.isFinite(slotDays) || slotDays < 1) {
    return { error: "missing slotDays or slot date range", slots: [] };
  }
  if (end.isBefore(start, "day")) {
    return { error: "slotEndDate is before slotStartDate", slots: [] };
  }

  const slots = [];
  let cursor = start.clone().startOf("day");
  const endDay = end.clone().startOf("day");
  let guard = 0;
  while (cursor.isSameOrBefore(endDay, "day")) {
    if (guard++ > 5000) {
      return { error: "slot generation exceeded 5000 steps", slots };
    }
    const slotStart = cursor.clone();
    let slotEnd = cursor.clone().add(slotDays - 1, "days");
    if (slotEnd.isAfter(endDay, "day")) slotEnd = endDay.clone();
    const monthEnd = slotStart.clone().endOf("month").startOf("day");
    if (slotEnd.isAfter(monthEnd, "day")) slotEnd = monthEnd.clone();
    slots.push({
      startDay: slotStart.format("DD-MM-YYYY"),
      endDay: slotEnd.format("DD-MM-YYYY"),
      year: slotStart.year(),
      startMs: slotStart.valueOf(),
      endMs: slotEnd.valueOf(),
    });
    cursor = slotEnd.clone().add(1, "day");
  }
  return { error: null, slots };
}

function slotActivity(slot, orderCount) {
  const sowed = Number(slot.primarySowed) || 0;
  const batches = Array.isArray(slot.sowingBatches) ? slot.sowingBatches.length : 0;
  const orders = Number(orderCount) || 0;
  return { sowed, batches, orders, active: sowed > 0 || batches > 0 || orders > 0 };
}

async function main() {
  const url = process.env.PROD_MONGO_URL || process.env.MONGO_URL;
  if (!url) {
    console.error("PROD_MONGO_URL or MONGO_URL is not set");
    process.exit(1);
  }
  await mongoose.connect(url);

  const plants = await PlantCms.find({ sowingAllowed: true })
    .select("name subtypes")
    .lean();
  const plantIds = plants.map((p) => p._id);
  const slotDocs = await PlantSlot.find({ plantId: { $in: plantIds } })
    .select("plantId year subtypeSlots")
    .lean();

  const orderCounts = await Order.aggregate([
    {
      $match: {
        plantName: { $in: plantIds },
        bookingSlot: { $exists: true, $ne: null },
        orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
      },
    },
    { $group: { _id: "$bookingSlot", n: { $sum: 1 } } },
  ]);
  const ordersBySlot = new Map(orderCounts.map((r) => [String(r._id), r.n]));

  const storedByPlant = new Map();
  for (const doc of slotDocs) {
    const key = String(doc.plantId);
    if (!storedByPlant.has(key)) storedByPlant.set(key, []);
    storedByPlant.get(key).push(doc);
  }

  const blocked = [];
  const emptyIssues = [];
  let subtypesChecked = 0;
  let slotsChecked = 0;

  for (const plant of plants) {
    const yearDocs = storedByPlant.get(String(plant._id)) || [];
    for (const subtype of plant.subtypes || []) {
      subtypesChecked += 1;
      const expected = expectedSlotsForSubtype(subtype);
      const label = `${plant.name} · ${subtype.name}`;
      if (expected.error) {
        emptyIssues.push({ label, issue: expected.error });
        continue;
      }

      const byYear = new Map();
      for (const doc of yearDocs) {
        const groups = (doc.subtypeSlots || []).filter(
          (g) => String(g.subtypeId) === String(subtype._id)
        );
        if (groups.length > 1) {
          const issue = {
            label,
            issue: `duplicate subtype slot lists in year ${doc.year} (${groups.length})`,
          };
          const anyActive = groups.some((g) =>
            (g.slots || []).some((s) => slotActivity(s, ordersBySlot.get(String(s._id))).active)
          );
          (anyActive ? blocked : emptyIssues).push(issue);
        }
        if (groups.length) byYear.set(doc.year, groups[0].slots || []);
      }

      const actual = [];
      for (const slots of byYear.values()) {
        for (const slot of slots) {
          slotsChecked += 1;
          const start = moment(slot.startDay, "DD-MM-YYYY", true);
          const end = moment(slot.endDay, "DD-MM-YYYY", true);
          const activity = slotActivity(slot, ordersBySlot.get(String(slot._id)));
          const problems = [];
          if (!start.isValid() || !end.isValid()) problems.push("invalid date");
          else if (end.isBefore(start, "day")) problems.push("end before start");
          else if (start.month() !== end.month() || start.year() !== end.year()) {
            problems.push("crosses a month");
          }
          if (problems.length) {
            const row = {
              label,
              range: `${slot.startDay || "?"} → ${slot.endDay || "?"}`,
              issue: problems.join(", "),
            };
            (activity.active ? blocked : emptyIssues).push(row);
          }
          if (start.isValid() && end.isValid()) {
            actual.push({
              startDay: slot.startDay,
              endDay: slot.endDay,
              startMs: start.startOf("day").valueOf(),
              endMs: end.startOf("day").valueOf(),
              activity,
              id: String(slot._id),
            });
          }
        }
      }

      actual.sort((a, b) => a.startMs - b.startMs);
      const expectedKeys = new Set(expected.slots.map((s) => `${s.startDay}|${s.endDay}`));
      const actualKeys = new Set(actual.map((s) => `${s.startDay}|${s.endDay}`));

      for (let i = 1; i < actual.length; i += 1) {
        const prev = actual[i - 1];
        const cur = actual[i];
        if (cur.startMs <= prev.endMs) {
          const row = {
            label,
            range: `${prev.startDay} overlaps ${cur.startDay}`,
            issue: "overlap",
          };
          (prev.activity.active || cur.activity.active ? blocked : emptyIssues).push(row);
        }
      }

      for (const exp of expected.slots) {
        if (!actualKeys.has(`${exp.startDay}|${exp.endDay}`)) {
          emptyIssues.push({
            label,
            range: `${exp.startDay} → ${exp.endDay}`,
            issue: "expected slot missing",
          });
        }
      }
      for (const got of actual) {
        if (!expectedKeys.has(`${got.startDay}|${got.endDay}`)) {
          const row = {
            label,
            range: `${got.startDay} → ${got.endDay}`,
            issue: "slot is outside the generated pattern",
          };
          (got.activity.active ? blocked : emptyIssues).push(row);
        }
      }
    }
  }

  console.log(
    `Checked ${plants.length} sowing-allowed plants, ${subtypesChecked} subtypes, ${slotsChecked} stored slots.`
  );
  console.log(`Blocked (booked or sowed and malformed): ${blocked.length}`);
  console.log(`Empty structural issues: ${emptyIssues.length}`);

  const printRows = (rows, limit = 40) => {
    for (const row of rows.slice(0, limit)) {
      console.log(`  - ${row.label}${row.range ? ` [${row.range}]` : ""}: ${row.issue}`);
    }
    if (rows.length > limit) console.log(`  … ${rows.length - limit} more`);
  };

  if (blocked.length) {
    console.log("\nUnsafe malformed slots (not rewritten):");
    printRows(blocked);
  }
  if (emptyIssues.length) {
    console.log("\nEmpty structural issues (repair is a separate step):");
    printRows(emptyIssues);
  }

  await mongoose.disconnect();
  if (blocked.length) process.exit(2);
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
