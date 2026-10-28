import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import Shade from "../models/shadeSchema.model.js";
import {
  SMART_SHEDS,
  batchSpaceHold,
  ceilingsFor,
  coverBatchId,
  cropOf,
  fortForShade,
  fortFromText,
  isOrderOut,
  shedRoom,
} from "../utility/smartShedSpace.js";

const idStr = (value) => (value == null || value === "" ? "" : String(value._id ?? value));

function emptyCrop() {
  return { occupied: 0, onOpen: 0, noOrder: 0, orderOut: 0 };
}

function addHold(target, hold) {
  target.occupied += hold.occupied;
  target.onOpen += hold.onOpen;
  target.noOrder += hold.noOrder;
  target.orderOut += hold.orderOut;
}

function orderCode(order) {
  return String(order?.publicOrderCode || order?.orderId || "");
}

/**
 * When the order has no per-batch cover row, use this batch's orderCoveredPlants.
 * Mixed open/out orders without a split stay held, so a status cannot empty the wrong share.
 */
function fallbackCovers(batch, ordersById) {
  const covered = Math.max(0, Number(batch?.orderCoveredPlants) || 0);
  const linked = (batch?.linkedOrderIds || []).map(idStr).filter(Boolean);
  if (covered < 1 || !linked.length) return [];
  const known = linked.map((id) => ordersById.get(id)).filter(Boolean);
  if (!known.length) {
    return [{ orderId: linked[0], code: "", name: "", status: "", plants: covered, out: false }];
  }
  const allOut = known.every((order) => isOrderOut(order.orderStatus));
  const noneOut = known.every((order) => !isOrderOut(order.orderStatus));
  if (!allOut && !noneOut) {
    return [{ orderId: "mixed", code: "", name: "", status: "MIXED", plants: covered, out: false }];
  }
  const sample = known[0];
  return [
    {
      orderId: String(sample._id),
      code: orderCode(sample),
      name: sample.name || "",
      status: sample.orderStatus || "",
      plants: covered,
      out: allOut,
    },
  ];
}

function rollCrops(items) {
  const crops = { papaya: emptyCrop(), watermelon: emptyCrop(), muskmelon: emptyCrop() };
  for (const item of items) {
    if (crops[item.crop]) addHold(crops[item.crop], item);
  }
  return crops;
}

function sumCrop(crops, field) {
  return crops.papaya[field] + crops.watermelon[field] + crops.muskmelon[field];
}

export async function loadSmartShedPayload() {
  const [shades, plants] = await Promise.all([
    Shade.find().select("name number smartCapacity isActive").lean(),
    PlantCms.find().select("name subtypes._id subtypes.name").lean(),
  ]);

  const plantById = new Map();
  const cropPlantIds = [];
  for (const plant of plants) {
    if (!cropOf(plant?.name) && !(plant?.subtypes || []).some((sub) => cropOf(sub?.name))) continue;
    plantById.set(String(plant._id), plant);
    cropPlantIds.push(plant._id);
  }

  const shadeByFort = new Map();
  for (const shade of shades) {
    const fort = fortForShade(shade);
    if (!fort) continue;
    const prev = shadeByFort.get(fort.key);
    if (!prev) {
      shadeByFort.set(fort.key, shade);
      continue;
    }
    const prevIsNumber = String(prev.number ?? "") === fort.number;
    const nextIsNumber = String(shade.number ?? "") === fort.number;
    if (!prevIsNumber && nextIsNumber) shadeByFort.set(fort.key, shade);
  }

  const rows = cropPlantIds.length
    ? await PlantSlot.aggregate([
        { $match: { plantId: { $in: cropPlantIds } } },
        { $unwind: "$subtypeSlots" },
        { $unwind: "$subtypeSlots.slots" },
        { $unwind: "$subtypeSlots.slots.sowingBatches" },
        { $match: { "subtypeSlots.slots.sowingBatches.plantsSowed": { $gt: 0 } } },
        {
          $project: {
            plantId: 1,
            subtypeId: "$subtypeSlots.subtypeId",
            slotId: "$subtypeSlots.slots._id",
            batch: {
              _id: "$subtypeSlots.slots.sowingBatches._id",
              plantsSowed: "$subtypeSlots.slots.sowingBatches.plantsSowed",
              destroyedPlants: "$subtypeSlots.slots.sowingBatches.destroyedPlants",
              dispatchLog: "$subtypeSlots.slots.sowingBatches.dispatchLog",
              shedName: "$subtypeSlots.slots.sowingBatches.shedName",
              readyPlantsReceived: "$subtypeSlots.slots.sowingBatches.readyPlantsReceived",
              linkedOrderIds: "$subtypeSlots.slots.sowingBatches.linkedOrderIds",
              orderCoveredPlants: "$subtypeSlots.slots.sowingBatches.orderCoveredPlants",
              sowingDate: "$subtypeSlots.slots.sowingBatches.sowingDate",
              requestNumber: "$subtypeSlots.slots.sowingBatches.requestNumber",
              plantReadyDate: "$subtypeSlots.slots.sowingBatches.plantReadyDate",
            },
          },
        },
      ]).allowDiskUse(true)
    : [];

  const batchIds = [];
  const linkedIds = [];
  for (const row of rows) {
    const batch = row.batch;
    if (!batch?._id || batch.readyPlantsReceived === false) continue;
    batchIds.push(batch._id);
    for (const id of batch.linkedOrderIds || []) {
      if (id) linkedIds.push(id);
    }
  }

  const orderOr = [];
  if (batchIds.length) {
    orderOr.push({ "sowingCoverSources.batchId": { $in: batchIds } });
    orderOr.push({ "sowingCoverSources.destBatchId": { $in: batchIds } });
  }
  if (linkedIds.length) orderOr.push({ _id: { $in: linkedIds } });

  const orders = orderOr.length
    ? await Order.find({ $or: orderOr })
        .select("_id orderId publicOrderCode name orderStatus sowingCoverSources sowingCoverReversedAt")
        .lean()
    : [];

  const ordersById = new Map(orders.map((order) => [String(order._id), order]));
  const coversByBatch = new Map();
  for (const order of orders) {
    if (order.sowingCoverReversedAt) continue;
    for (const source of order.sowingCoverSources || []) {
      const holder = coverBatchId(source);
      const plants = Math.max(0, Number(source?.plants) || 0);
      if (!holder || plants < 1) continue;
      if (!coversByBatch.has(holder)) coversByBatch.set(holder, []);
      coversByBatch.get(holder).push({
        orderId: String(order._id),
        code: orderCode(order),
        name: order.name || "",
        status: order.orderStatus || "",
        plants,
        out: isOrderOut(order.orderStatus),
      });
    }
  }

  const groups = new Map(SMART_SHEDS.map((fort) => [fort.key, []]));
  const unmatched = [];

  for (const row of rows) {
    const plant = plantById.get(String(row.plantId));
    const subtype = (plant?.subtypes || []).find((sub) => String(sub._id) === String(row.subtypeId));
    const crop = cropOf(plant?.name) || cropOf(subtype?.name);
    const batch = row.batch;
    if (!crop || !batch || batch.readyPlantsReceived === false) continue;

    const batchId = String(batch._id);
    const covers = coversByBatch.get(batchId)?.length
      ? coversByBatch.get(batchId)
      : fallbackCovers(batch, ordersById);
    const hold = batchSpaceHold(batch, covers);
    if (hold.skipped || hold.occupied < 1) continue;

    const item = {
      batchId,
      slotId: idStr(row.slotId),
      plantName: plant?.name || "",
      subtypeName: subtype?.name || "",
      crop,
      shedName: batch.shedName || "",
      sowingDate: batch.sowingDate || "",
      requestNumber: batch.requestNumber || "",
      plantReadyDate: batch.plantReadyDate || "",
      occupied: hold.occupied,
      onOpen: hold.onOpen,
      noOrder: hold.noOrder,
      orderOut: hold.orderOut,
      orders: covers.map((cover) => ({
        orderId: cover.code || cover.orderId,
        name: cover.name || "",
        status: cover.status || "",
        plants: cover.plants,
        out: Boolean(cover.out),
      })),
    };
    const fort = fortFromText(batch.shedName);
    if (fort) groups.get(fort.key).push(item);
    else unmatched.push(item);
  }

  const sheds = SMART_SHEDS.map((fort) => {
    const items = groups.get(fort.key) || [];
    items.sort((a, b) => b.occupied - a.occupied);
    const crops = rollCrops(items);
    const shade = shadeByFort.get(fort.key) || null;
    const { papayaMax, melonMax } = ceilingsFor(fort, shade);
    const papayaOccupied = crops.papaya.occupied;
    const melonOccupied = crops.watermelon.occupied + crops.muskmelon.occupied;
    const room = shedRoom({
      papayaUsed: papayaOccupied,
      melonUsed: melonOccupied,
      papayaMax,
      melonMax,
    });
    return {
      key: fort.key,
      label: fort.label,
      labelMr: fort.labelMr,
      number: fort.number,
      shadeName: shade?.name || "",
      shadeNumber: shade ? String(shade.number ?? "") : "",
      matchLabels: [fort.label, fort.labelMr, shade?.name].filter(Boolean),
      papayaMax,
      melonMax,
      papayaOccupied,
      melonOccupied,
      papaya: crops.papaya,
      watermelon: crops.watermelon,
      muskmelon: crops.muskmelon,
      onOpen: sumCrop(crops, "onOpen"),
      noOrder: sumCrop(crops, "noOrder"),
      orderOut: sumCrop(crops, "orderOut"),
      used: room.used,
      vacant: room.vacant,
      over: room.over,
      papayaRoom: room.papayaRoom,
      melonRoom: room.melonRoom,
      batches: items,
    };
  });

  const unmatchedCrops = rollCrops(unmatched);
  unmatched.sort((a, b) => b.occupied - a.occupied);

  return {
    sheds,
    unmatched: {
      occupied: sumCrop(unmatchedCrops, "occupied"),
      papayaOccupied: unmatchedCrops.papaya.occupied,
      watermelonOccupied: unmatchedCrops.watermelon.occupied,
      muskmelonOccupied: unmatchedCrops.muskmelon.occupied,
      batches: unmatched,
    },
  };
}
