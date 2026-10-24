import moment from "moment";
import mongoose from "mongoose";
import Order from "../models/order.model.js";
import PlantCms from "../models/plantCms.model.js";
import { IST_OFFSET } from "../utility/istSlotDate.js";
import { dmyToYmd, inProgressOrderIdSet, listSowBatchStock } from "./sowBatchStock.service.js";

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
        notSownPlants: 0,
        inProgressPlants: 0,
        sowed: 0,
        excess: 0,
        batches: 0,
      });
    }
    return map.get(k);
  };

  for (const b of batches || []) {
    if (b.isIrrelevant) continue;
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
    const plants = n(o.plants);
    r.orderCount += 1;
    r.orderPlants += plants;
    if (!o.sowingDone && o.inProgress) r.inProgressPlants += plants;
    else if (!o.sowingDone) r.notSownPlants += plants;
    if (o.cropName && !r.plantName) r.plantName = o.cropName;
    if (o.varietyName && !r.subtypeName) r.subtypeName = o.varietyName;
    r.letter = plantLetter(r.plantName);
  }

  return [...map.values()]
    .map((r) => {
      const short = Math.max(0, r.notSownPlants - r.sowed);
      const free = Math.max(0, r.excess);
      return { ...r, short, free, net: free - short };
    })
    .sort((a, b) => b.orderPlants - a.orderPlants || b.excess - a.excess);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function labelOfYmd(ymd) {
  if (!ymd || ymd === "none") return "—";
  const [y, m, d] = String(ymd).split("-");
  return `${d} ${MONTHS[Number(m) - 1] || m} ${y}`;
}

/** Plant, then variety, then date. Irrelevant batches add no excess. */
export function groupByPlantVarietyDate(batches, orders) {
  const plants = new Map();
  const plantOf = (plantId, plantName) => {
    if (!plants.has(plantId)) {
      plants.set(plantId, {
        plantId,
        plantName: plantName || "",
        letter: plantLetter(plantName),
        varieties: new Map(),
      });
    }
    const plant = plants.get(plantId);
    if (plantName && !plant.plantName) plant.plantName = plantName;
    return plant;
  };
  const varietyOf = (plant, subtypeId, subtypeName) => {
    if (!plant.varieties.has(subtypeId)) {
      plant.varieties.set(subtypeId, { subtypeId, subtypeName: subtypeName || "", dates: new Map() });
    }
    const variety = plant.varieties.get(subtypeId);
    if (subtypeName && !variety.subtypeName) variety.subtypeName = subtypeName;
    return variety;
  };
  const dateOf = (variety, ymd) => {
    const key = ymd || "none";
    if (!variety.dates.has(key)) {
      variety.dates.set(key, {
        date: key === "none" ? "" : key,
        label: labelOfYmd(key),
        excess: 0,
        sowed: 0,
        batches: 0,
        notSownPlants: 0,
        notSownOrders: [],
        inProgressPlants: 0,
        inProgressCount: 0,
      });
    }
    return variety.dates.get(key);
  };

  for (const batch of batches || []) {
    if (batch.isIrrelevant) continue;
    const plant = plantOf(String(batch.plantId), batch.plantName);
    const variety = varietyOf(plant, String(batch.subtypeId), batch.subtypeName);
    const date = dateOf(variety, dmyToYmd(batch.plantReadyDate));
    date.excess += n(batch.excess);
    date.sowed += n(batch.plantsSowed);
    date.batches += 1;
  }
  for (const order of orders || []) {
    if (order.sowingDone) continue;
    const plant = plantOf(String(order.plantId), order.cropName);
    const variety = varietyOf(plant, String(order.subtypeId), order.varietyName);
    const date = dateOf(variety, order.dateYmd || "");
    const plants = n(order.plants);
    if (order.inProgress) {
      date.inProgressPlants += plants;
      date.inProgressCount += 1;
    } else {
      date.notSownPlants += plants;
      date.notSownOrders.push({
        _id: order._id || "",
        orderId: order.orderId || "",
        plants,
      });
    }
  }

  return [...plants.values()]
    .map((plant) => ({
      plantId: plant.plantId,
      plantName: plant.plantName,
      letter: plantLetter(plant.plantName),
      varieties: [...plant.varieties.values()]
        .map((variety) => ({
          subtypeId: variety.subtypeId,
          subtypeName: variety.subtypeName,
          dates: [...variety.dates.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
        }))
        .sort((a, b) => a.subtypeName.localeCompare(b.subtypeName)),
    }))
    .sort((a, b) => a.plantName.localeCompare(b.plantName));
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
        .select("orderId numberOfPlants additionalPlants plantName plantSubtype deliveryDate sowingDone")
        .populate("plantName", "name")
        .lean()
    : [];
  const progressIds = await inProgressOrderIdSet(orderDocs.map((o) => o._id));

  const nameById = new Map();
  for (const b of batches) nameById.set(`${b.plantId}|${b.subtypeId}`, b);
  const orders = orderDocs.map((o) => {
    const plantId = String(o.plantName?._id || o.plantName || "");
    const subtypeId = String(o.plantSubtype || "");
    const hit = nameById.get(`${plantId}|${subtypeId}`);
    const names = subtypeNameOf(plantId, subtypeId);
    const sowingDone = Boolean(o.sowingDone);
    return {
      _id: String(o._id),
      orderId: o.orderId,
      plantId,
      subtypeId,
      cropName: o.plantName?.name || hit?.plantName || names.plantName,
      varietyName: hit?.subtypeName || names.subtypeName,
      plants: n(o.numberOfPlants) + n(o.additionalPlants),
      sowingDone,
      inProgress: !sowingDone && progressIds.has(String(o._id)),
      dateYmd: moment(o.deliveryDate).utcOffset(IST_OFFSET).format("YYYY-MM-DD"),
    };
  });

  const rows = rollupDeliveryIntel(batches, orders);
  const groups = groupByPlantVarietyDate(batches, orders);
  const summary = rows.reduce(
    (s, r) => {
      s.orderCount += r.orderCount;
      s.orderPlants += r.orderPlants;
      s.notSownPlants += r.notSownPlants;
      s.inProgressPlants += r.inProgressPlants;
      s.sowed += r.sowed;
      s.excess += r.excess;
      s.short += r.short;
      s.free += r.free;
      s.batches += r.batches;
      return s;
    },
    {
      orderCount: 0,
      orderPlants: 0,
      notSownPlants: 0,
      inProgressPlants: 0,
      sowed: 0,
      excess: 0,
      short: 0,
      free: 0,
      batches: 0,
    }
  );

  return {
    from: range.fromYmd,
    to: range.toYmd,
    summary,
    rows,
    groups,
  };
}
