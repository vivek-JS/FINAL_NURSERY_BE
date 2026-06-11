/**
 * MIS drawer: transition dates + farmer / plant / dispatch display fields.
 */

import mongoose from "mongoose";
import Farmer from "../models/farmer.model.js";
import PlantCms from "../models/plantCms.model.js";
import User from "../models/user.model.js";

function transitionTimestamp(change) {
  return change?.createdAt ?? change?.changedAt ?? null;
}

/** Earliest statusChanges entry for a given newStatus. */
export function firstTransitionDate(order, newStatus) {
  const want = String(newStatus || "").toUpperCase();
  const changes = Array.isArray(order?.statusChanges) ? order.statusChanges : [];
  let earliest = null;
  for (const sc of changes) {
    if (String(sc?.newStatus || "").toUpperCase() !== want) continue;
    const t = transitionTimestamp(sc);
    if (!t) continue;
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) continue;
    if (!earliest || d < earliest) earliest = d;
  }
  return earliest;
}

/** Dispatch leg closest to bucket transition (for vehicle / DC on Out drawer). */
export function pickDispatchLegForBucket(order, bucketEventAt) {
  const hist = Array.isArray(order?.dispatchHistory) ? order.dispatchHistory : [];
  if (!hist.length) return null;

  if (bucketEventAt) {
    const target = new Date(bucketEventAt).getTime();
    if (!Number.isNaN(target)) {
      let best = null;
      let bestDelta = Infinity;
      for (const leg of hist) {
        const t = new Date(leg?.date || leg?.createdAt || 0).getTime();
        if (Number.isNaN(t)) continue;
        const delta = Math.abs(t - target);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = leg;
        }
      }
      if (best && bestDelta < 5 * 60 * 1000) return best;
    }
  }

  return hist[hist.length - 1];
}

function uniqObjectIds(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (v == null || v === "") continue;
    const s = String(v);
    if (!mongoose.Types.ObjectId.isValid(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(new mongoose.Types.ObjectId(s));
  }
  return out;
}

function subtypeNameFromPlant(plantDoc, subtypeId) {
  if (!plantDoc?.subtypes?.length || subtypeId == null) return null;
  const sid = String(subtypeId);
  const hit = plantDoc.subtypes.find((st) => String(st._id) === sid);
  return hit?.name ?? null;
}

function locationFromFarmer(farmer) {
  if (!farmer) return { village: null, taluka: null, district: null };
  return {
    village: farmer.village || null,
    taluka: farmer.talukaName || farmer.taluka || null,
    district: farmer.districtName || farmer.district || null,
  };
}

function locationFromOrderFor(orderFor) {
  if (!orderFor) return { village: null, taluka: null, district: null };
  return {
    village: orderFor.village || null,
    taluka: orderFor.talukaName || orderFor.taluka || null,
    district: orderFor.districtName || orderFor.district || null,
  };
}

/**
 * @param {object} order lean order document
 * @param {{ bucket?: string, bucketEventAt?: Date|string|null }} opts
 */
export function enrichMisOrderRow(order, { bucket, bucketEventAt } = {}) {
  const dispatchedDate = firstTransitionDate(order, "DISPATCHED");
  const completedDate = firstTransitionDate(order, "COMPLETED");

  let eventAt = bucketEventAt ? new Date(bucketEventAt) : null;
  if (!eventAt || Number.isNaN(eventAt.getTime())) {
    if (bucket === "dispatched") eventAt = dispatchedDate;
    else if (bucket === "completed") eventAt = completedDate;
  }

  const dispatchLeg = pickDispatchLegForBucket(order, eventAt);
  const displayDispatched =
    (bucket === "dispatched" || bucket === "vehicleDispatched") && eventAt
      ? eventAt
      : dispatchedDate;
  const displayCompleted =
    bucket === "completed" && eventAt ? eventAt : completedDate;

  return {
    ...order,
    dispatchedDate: displayDispatched || null,
    completedDate: displayCompleted || null,
    bucketEventAt: eventAt || null,
    dispatch: dispatchLeg
      ? {
          date: dispatchLeg.date || dispatchLeg.createdAt || null,
          quantity: dispatchLeg.quantity ?? null,
          driverName: dispatchLeg.driverName || null,
          vehicleName: dispatchLeg.vehicleName || null,
          invoiceNumber: dispatchLeg.invoiceNumber || null,
          dispatchId: dispatchLeg.dispatchId || null,
        }
      : null,
  };
}

export function enrichMisOrderList(orders, bucket, eventAtById) {
  return (orders || []).map((order) => {
    const id = order?._id != null ? String(order._id) : "";
    return enrichMisOrderRow(order, {
      bucket,
      bucketEventAt: eventAtById?.get?.(id) ?? order?.bucketEventAt,
    });
  });
}

/**
 * Resolve farmer / plant / sales names for drawer rows (batch).
 * @param {object[]} orders
 */
export async function hydrateMisOrderDrawerList(orders) {
  if (!orders?.length) return [];

  const farmerIds = uniqObjectIds(orders.map((o) => o.farmer));
  const plantIds = uniqObjectIds(orders.map((o) => o.plantName));
  const salesIds = uniqObjectIds(orders.map((o) => o.salesPerson));
  const dealerIds = uniqObjectIds(orders.map((o) => o.dealer));

  const [farmers, plants, salesUsers, dealers] = await Promise.all([
    farmerIds.length
      ? Farmer.find({ _id: { $in: farmerIds } })
          .select("name mobileNumber village taluka talukaName district districtName")
          .lean()
      : [],
    plantIds.length
      ? PlantCms.find({ _id: { $in: plantIds } }).select("name subtypes").lean()
      : [],
    salesIds.length
      ? User.find({ _id: { $in: salesIds } }).select("name phoneNumber").lean()
      : [],
    dealerIds.length
      ? User.find({ _id: { $in: dealerIds } }).select("name phoneNumber").lean()
      : [],
  ]);

  const farmerById = new Map(farmers.map((f) => [String(f._id), f]));
  const plantById = new Map(plants.map((p) => [String(p._id), p]));
  const salesById = new Map(salesUsers.map((u) => [String(u._id), u]));
  const dealerById = new Map(dealers.map((u) => [String(u._id), u]));

  return orders.map((order) => {
    const farmerDoc = order.farmer ? farmerById.get(String(order.farmer)) : null;
    const plantDoc = order.plantName ? plantById.get(String(order.plantName)) : null;
    const salesDoc = order.salesPerson ? salesById.get(String(order.salesPerson)) : null;
    const dealerDoc = order.dealer ? dealerById.get(String(order.dealer)) : null;
    const of = order.orderFor;

    const farmerName =
      farmerDoc?.name || of?.name || null;
    const loc = farmerDoc
      ? locationFromFarmer(farmerDoc)
      : locationFromOrderFor(of);

    const plantTypeName = plantDoc?.name || null;
    const plantSubtypeName =
      subtypeNameFromPlant(plantDoc, order.plantSubtype) || null;

    const deliveryChangeCount = Array.isArray(order.deliveryChanges)
      ? order.deliveryChanges.length
      : 0;
    const lastChange = deliveryChangeCount
      ? order.deliveryChanges[deliveryChangeCount - 1]
      : null;

    return {
      ...order,
      farmerName,
      farmerMobile: farmerDoc?.mobileNumber ?? of?.mobileNumber ?? null,
      farmerVillage: loc.village,
      farmerTaluka: loc.taluka,
      farmerDistrict: loc.district,
      plantTypeName,
      plantSubtypeName,
      salesPersonName: salesDoc?.name || null,
      dealerName: dealerDoc?.name || null,
      deliveryChangeCount,
      isEarlyDispatch: Boolean(order.dispatchedFromAnotherSlot),
      lastDeliveryChangeReason: lastChange?.reasonForChange || null,
    };
  });
}
