import moment from "moment";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";
import { dmyToYmd, listSowBatchStock } from "./sowBatchStock.service.js";

const n = (v) => Number(v) || 0;

export function ymdInRange(ymd, fromYmd, toYmd) {
  return Boolean(ymd) && ymd >= fromYmd && ymd <= toYmd;
}

export function plantLetter(name) {
  const s = String(name || "");
  if (/water|tarbuj/i.test(s)) return "W";
  if (/papaya/i.test(s)) return "P";
  if (/musk|kharbuj/i.test(s)) return "M";
  if (/banana/i.test(s)) return "B";
  if (/tomato/i.test(s)) return "T";
  if (/chill|mirchi/i.test(s)) return "C";
  const c = s.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

export function rollupDeliveryIntel(batches, orders) {
  const map = new Map();
  const keyOf = (plantId, subtypeId) => `${plantId}|${subtypeId}`;
  const row = (plantId, subtypeId, plantName, subtypeName) => {
    const k = keyOf(plantId, subtypeId);
    if (!map.has(k)) {
      map.set(k, {
        plantId,
        subtypeId,
        plantName: plantName || "",
        subtypeName: subtypeName || "",
        letter: plantLetter(plantName),
        orderCount: 0,
        orderPlants: 0,
        sowed: 0,
        excess: 0,
        batches: 0,
      });
    }
    return map.get(k);
  };

  for (const b of batches || []) {
    const r = row(String(b.plantId), String(b.subtypeId), b.plantName, b.subtypeName);
    r.sowed += n(b.plantsSowed);
    r.excess += n(b.excess);
    r.batches += 1;
  }
  for (const o of orders || []) {
    const r = row(
      String(o.plantId || o.plantName),
      String(o.subtypeId || o.plantSubtype),
      o.cropName,
      o.varietyName
    );
    r.orderCount += 1;
    r.orderPlants += n(o.plants);
    if (o.cropName && !r.plantName) r.plantName = o.cropName;
    if (o.varietyName && !r.subtypeName) r.subtypeName = o.varietyName;
    r.letter = plantLetter(r.plantName);
  }

  return [...map.values()]
    .map((r) => {
      const short = Math.max(0, r.orderPlants - r.sowed);
      const free = Math.max(0, r.excess);
      return { ...r, short, free, net: free - short };
    })
    .sort((a, b) => b.orderPlants - a.orderPlants || b.excess - a.excess);
}

function parseRange(from, to) {
  const fromM = moment(from, ["YYYY-MM-DD", "DD-MM-YYYY"], true).utcOffset(IST_OFFSET, true);
  const toM = moment(to, ["YYYY-MM-DD", "DD-MM-YYYY"], true).utcOffset(IST_OFFSET, true);
  if (!fromM.isValid() || !toM.isValid()) return null;
  if (toM.isBefore(fromM, "day")) return null;
  return {
    fromYmd: fromM.format("YYYY-MM-DD"),
    toYmd: toM.format("YYYY-MM-DD"),
    fromDate: fromM.clone().startOf("day").toDate(),
    toDate: toM.clone().endOf("day").toDate(),
  };
}

export async function sowBatchStockIntel(query = {}) {
  const range = parseRange(query.from, query.to);
  if (!range) {
    return { error: "from and to dates are required (YYYY-MM-DD)" };
  }
  const stock = await listSowBatchStock({
    plantId: query.plantId,
    subtypeId: query.subtypeId,
    stock: "all",
    ready: "all",
  });
  const batches = (stock.items || []).filter((b) =>
    ymdInRange(dmyToYmd(b.plantReadyDate), range.fromYmd, range.toYmd)
  );

  const plantQuery = { sowingAllowed: true };
  if (query.plantId && mongoose.Types.ObjectId.isValid(String(query.plantId))) {
    plantQuery._id = new mongoose.Types.ObjectId(String(query.plantId));
  }
  const allowed = await PlantCms.find(plantQuery).select("_id name subtypes._id subtypes.name").lean();
  const plantFilter = allowed.map((p) => p._id);
  const subtypeNameOf = (plantId, subtypeId) => {
    const p = allowed.find((x) => String(x._id) === String(plantId));
    const st = (p?.subtypes || []).find((s) => String(s._id) === String(subtypeId));
    return { plantName: p?.name || "", subtypeName: st?.name || "" };
  };

  const orderMatch = {
    orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
    deliveryDate: { $gte: range.fromDate, $lte: range.toDate },
  };
  if (plantFilter.length) orderMatch.plantName = { $in: plantFilter };
  if (query.subtypeId && mongoose.Types.ObjectId.isValid(String(query.subtypeId))) {
    orderMatch.plantSubtype = new mongoose.Types.ObjectId(String(query.subtypeId));
  }

  const orderDocs = plantFilter.length
    ? await Order.find(orderMatch)
        .select("orderId numberOfPlants additionalPlants plantName plantSubtype deliveryDate")
        .populate("plantName", "name")
        .lean()
    : [];

  const nameById = new Map();
  for (const b of batches) nameById.set(`${b.plantId}|${b.subtypeId}`, b);
  const orders = orderDocs.map((o) => {
    const plantId = String(o.plantName?._id || o.plantName || "");
    const subtypeId = String(o.plantSubtype || "");
    const hit = nameById.get(`${plantId}|${subtypeId}`);
    const names = subtypeNameOf(plantId, subtypeId);
    return {
      plantId,
      subtypeId,
      cropName: o.plantName?.name || hit?.plantName || names.plantName,
      varietyName: hit?.subtypeName || names.subtypeName,
      plants: n(o.numberOfPlants) + n(o.additionalPlants),
    };
  });

  const rows = rollupDeliveryIntel(batches, orders);
  const summary = rows.reduce(
    (s, r) => {
      s.orderCount += r.orderCount;
      s.orderPlants += r.orderPlants;
      s.sowed += r.sowed;
      s.excess += r.excess;
      s.short += r.short;
      s.free += r.free;
      s.batches += r.batches;
      return s;
    },
    { orderCount: 0, orderPlants: 0, sowed: 0, excess: 0, short: 0, free: 0, batches: 0 }
  );

  return {
    from: range.fromYmd,
    to: range.toYmd,
    summary,
    rows,
  };
}
