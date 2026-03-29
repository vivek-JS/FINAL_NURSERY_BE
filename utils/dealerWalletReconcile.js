import mongoose from "mongoose";
import Order from "../models/order.model.js";
import DealerWallet from "../models/dealerWallet.js";

/**
 * Normalize ids so ObjectId, 24-char hex string (any case), and populated doc _id all map to one wallet key.
 */
function normalizeMongoId(id) {
  if (id == null) return "";
  if (typeof id === "string") {
    const s = id.trim();
    if (/^[0-9a-fA-F]{24}$/.test(s)) return s.toLowerCase();
    return s;
  }
  if (id instanceof mongoose.Types.ObjectId) return id.toHexString();
  if (typeof id.toString === "function") {
    const s = id.toString();
    if (/^[0-9a-fA-F]{24}$/.test(s)) return s.toLowerCase();
    return s;
  }
  return String(id);
}

/**
 * Stable key for a wallet line (plant + subtype + slot).
 */
export function dealerWalletLineKey(plantTypeId, subTypeId, bookingSlotId) {
  const p = normalizeMongoId(plantTypeId);
  const s = normalizeMongoId(subTypeId);
  const b = normalizeMongoId(bookingSlotId);
  return `${p}|${s}|${b}`;
}

/**
 * Per order line: bulk purchased (dealerOrder) vs farmer consumption (quotaSource dealer).
 * Single aggregation — no N+1.
 */
export async function aggregateDerivedFromOrders(dealerId) {
  const oid =
    typeof dealerId === "string" ? new mongoose.Types.ObjectId(dealerId) : dealerId;

  const rows = await Order.aggregate([
    {
      $match: {
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
        $or: [
          {
            $and: [
              { dealer: oid },
              { $or: [{ dealerOrder: true }, { dealerOrder: "true" }] },
            ],
          },
          // Dealer bulk where salesPerson is the dealer but dealer field differs / legacy (still counts toward wallet bulk)
          {
            $and: [
              { salesPerson: oid },
              { $or: [{ dealerOrder: true }, { dealerOrder: "true" }] },
            ],
          },
          {
            salesPerson: oid,
            quotaSource: "dealer",
            $or: [{ dealerOrder: false }, { dealerOrder: { $exists: false } }],
          },
          // Office (or other) salesPerson with dealer quota: dealer set, farmer present, not bulk
          {
            dealer: oid,
            quotaSource: "dealer",
            farmer: { $exists: true, $ne: null },
            $nor: [{ dealerOrder: true }, { dealerOrder: "true" }],
          },
        ],
      },
    },
    {
      $addFields: {
        // Boolean and legacy string "true" both count as dealer bulk (must not sum into farmerBooked).
        isDealerBulkOrder: {
          $or: [
            { $eq: ["$dealerOrder", true] },
            { $eq: ["$dealerOrder", "true"] },
          ],
        },
      },
    },
    {
      $project: {
        plantName: 1,
        plantSubtype: 1,
        bookingSlot: 1,
        dealerOrder: 1,
        quotaSource: 1,
        numberOfPlants: 1,
        quotaUsed: 1,
        bulkPlants: {
          $cond: ["$isDealerBulkOrder", { $ifNull: ["$numberOfPlants", 0] }, 0],
        },
        // Farmer quota only: not a bulk line, quotaSource dealer, real farmer ref.
        farmerBooked: {
          $cond: [
            {
              $and: [
                { $eq: ["$isDealerBulkOrder", false] },
                { $eq: ["$quotaSource", "dealer"] },
                { $ne: [{ $ifNull: ["$farmer", null] }, null] },
              ],
            },
            {
              $cond: [
                { $gt: [{ $ifNull: ["$quotaUsed", 0] }, 0] },
                "$quotaUsed",
                { $ifNull: ["$numberOfPlants", 0] },
              ],
            },
            0,
          ],
        },
      },
    },
    // One logical line per plant/subtype/slot even if some orders store refs as string vs ObjectId
    {
      $addFields: {
        plantKey: { $toString: "$plantName" },
        subtypeKey: { $toString: "$plantSubtype" },
        slotKey: { $toString: "$bookingSlot" },
      },
    },
    {
      $group: {
        _id: {
          plantName: "$plantKey",
          plantSubtype: "$subtypeKey",
          bookingSlot: "$slotKey",
        },
        bulkFromOrders: { $sum: "$bulkPlants" },
        farmerBookedFromOrders: { $sum: "$farmerBooked" },
      },
    },
  ]);

  const map = new Map();
  for (const r of rows) {
    const k = dealerWalletLineKey(
      r._id.plantName,
      r._id.plantSubtype,
      r._id.bookingSlot
    );
    map.set(k, {
      bulkFromOrders: r.bulkFromOrders || 0,
      farmerBookedFromOrders: r.farmerBookedFromOrders || 0,
    });
  }
  return map;
}

/**
 * Reconcile line math shared with buildWalletCorrectionPlan: fixed quantity and headroom for farmer orders.
 * @param {{ quantity?: number, bookedQuantity?: number }} entry - wallet entry (stored values may be legacy-wrong)
 * @param {{ bulkFromOrders?: number, farmerBookedFromOrders?: number }} derivedRow - from aggregateDerivedFromOrders map
 * @returns {{ fixedQty: number, farmerBookedFromOrders: number, bulkFromOrders: number, availableForFarmerOrders: number }}
 */
export function computeDealerQuotaLineFromDerived(entry, derivedRow) {
  const bulk = Math.max(0, Number(derivedRow?.bulkFromOrders) || 0);
  const farmer = Math.max(0, Number(derivedRow?.farmerBookedFromOrders) || 0);
  const newQty = Math.max(Number(entry?.quantity) || 0, bulk + farmer);
  const fixedQty = Math.max(newQty, farmer);
  const availableForFarmerOrders = Math.max(0, fixedQty - farmer);
  return {
    fixedQty,
    farmerBookedFromOrders: farmer,
    bulkFromOrders: bulk,
    availableForFarmerOrders,
  };
}

/**
 * Wallet line + order-derived availability for validate/allocate dealer quota (same truth as wallet API overlay).
 * @param {import("mongoose").Types.ObjectId|string} dealerId
 * @param {import("mongoose").Types.ObjectId} plantType
 * @param {import("mongoose").Types.ObjectId} subType
 * @param {import("mongoose").Types.ObjectId} bookingSlot
 * @param {{ session?: import("mongoose").ClientSession }} [options]
 */
export async function getDealerQuotaLineAvailability(dealerId, plantType, subType, bookingSlot, options = {}) {
  const { session } = options;
  const q = DealerWallet.findOne({ dealer: dealerId });
  if (session) q.session(session);
  const wallet = await q;

  if (!wallet) {
    return {
      ok: false,
      reason: "no_wallet",
      message: "Dealer has no quota allocation",
    };
  }

  const entryIndex = wallet.entries.findIndex(
    (e) =>
      e.plantType?.equals(plantType) &&
      e.subType?.equals(subType) &&
      e.bookingSlot?.equals(bookingSlot)
  );

  if (entryIndex === -1) {
    return {
      ok: false,
      reason: "no_entry",
      message: "No quota allocation found for this plant/subtype/slot combination",
    };
  }

  const entry = wallet.entries[entryIndex];
  const derivedMap = await aggregateDerivedFromOrders(dealerId);
  const k = dealerWalletLineKey(plantType, subType, bookingSlot);
  const derivedRow = derivedMap.get(k) || {
    bulkFromOrders: 0,
    farmerBookedFromOrders: 0,
  };

  const computed = computeDealerQuotaLineFromDerived(entry, derivedRow);

  return {
    ok: true,
    wallet,
    entry,
    entryIndex,
    derivedRow,
    ...computed,
  };
}

/**
 * Replace per-slot booked/remaining with Order-derived farmer quota (quotaSource dealer).
 * Fixes API responses when DealerWallet still has legacy bulk double-counting in bookedQuantity.
 * Bulk purchases do not consume farmer quota; remaining = quantity − farmerBooked only.
 */
export function overlayOrderDerivedQuotaOnPlantDetails(plantDetails, derivedMap) {
  if (!Array.isArray(plantDetails) || !derivedMap) return plantDetails;
  for (const plant of plantDetails) {
    const slots = plant.slotDetails || [];
    let sumQty = 0;
    let sumBooked = 0;
    let sumRem = 0;
    for (const slot of slots) {
      const k = dealerWalletLineKey(plant.plantType, plant.subType, slot.slotId);
      const d = derivedMap.get(k) || {
        bulkFromOrders: 0,
        farmerBookedFromOrders: 0,
      };
      const qty = Math.max(0, Number(slot.quantity) || 0);
      const farmerBooked = Math.min(
        qty,
        Math.max(0, d.farmerBookedFromOrders || 0)
      );
      slot.bookedQuantity = farmerBooked;
      slot.remainingQuantity = Math.max(0, qty - farmerBooked);
      sumQty += qty;
      sumBooked += farmerBooked;
      sumRem += slot.remainingQuantity;
    }
    plant.totalQuantity = sumQty;
    plant.totalBookedQuantity = sumBooked;
    plant.totalRemainingQuantity = sumRem;
  }
  return plantDetails;
}

/**
 * Attach derived hints to grouped plantDetails slot rows (read-only).
 */
export function attachReconcileHintsToPlantDetails(plantDetails, derivedMap) {
  if (!Array.isArray(plantDetails)) return plantDetails;
  for (const plant of plantDetails) {
    const slots = plant.slotDetails || [];
    for (const slot of slots) {
      const k = dealerWalletLineKey(plant.plantType, plant.subType, slot.slotId);
      const d = derivedMap.get(k) || {
        bulkFromOrders: 0,
        farmerBookedFromOrders: 0,
      };
      const storedQty = slot.quantity ?? 0;
      const storedBooked = slot.bookedQuantity ?? 0;
      const storedRem = slot.remainingQuantity ?? 0;
      const impliedRem = storedQty - storedBooked;
      const derivedRemainingHint = Math.max(
        0,
        Math.max(storedQty, d.bulkFromOrders + d.farmerBookedFromOrders) -
          d.farmerBookedFromOrders
      );
      slot.reconcile = {
        bulkFromOrders: d.bulkFromOrders,
        farmerBookedFromOrders: d.farmerBookedFromOrders,
        derivedRemainingHint,
        inconsistent:
          storedRem !== impliedRem ||
          storedBooked !== d.farmerBookedFromOrders,
      };
    }
  }
  return plantDetails;
}

/**
 * Build proposed corrections from Order-derived sums vs stored wallet entries.
 * @returns {{ changes: Array<{ key: string, before: object, after: object }>, walletModified: boolean }}
 */
export function buildWalletCorrectionPlan(walletDoc, derivedMap) {
  const changes = [];
  if (!walletDoc?.entries?.length) {
    return { changes, walletModified: false };
  }

  let walletModified = false;
  for (let i = 0; i < walletDoc.entries.length; i++) {
    const entry = walletDoc.entries[i];
    const k = dealerWalletLineKey(
      entry.plantType,
      entry.subType,
      entry.bookingSlot
    );
    const d = derivedMap.get(k) || {
      bulkFromOrders: 0,
      farmerBookedFromOrders: 0,
    };
    const newBooked = d.farmerBookedFromOrders;
    const newQty = Math.max(
      entry.quantity || 0,
      d.bulkFromOrders + newBooked
    );
    const fixedQty = Math.max(newQty, newBooked);
    const fixedRem = fixedQty - newBooked;

    const before = {
      quantity: entry.quantity,
      bookedQuantity: entry.bookedQuantity,
      remainingQuantity: entry.remainingQuantity,
    };
    const after = {
      quantity: fixedQty,
      bookedQuantity: newBooked,
      remainingQuantity: fixedRem,
    };

    if (
      before.quantity !== after.quantity ||
      before.bookedQuantity !== after.bookedQuantity ||
      before.remainingQuantity !== after.remainingQuantity
    ) {
      changes.push({ key: k, index: i, before, after });
      walletModified = true;
    }
  }

  return { changes, walletModified };
}

/**
 * Apply correction plan in-memory; caller saves DealerWallet (or pass dryRun).
 */
export function applyCorrectionPlanToWalletEntries(walletDoc, changes) {
  for (const ch of changes) {
    const e = walletDoc.entries[ch.index];
    if (!e) continue;
    e.quantity = ch.after.quantity;
    e.bookedQuantity = ch.after.bookedQuantity;
    e.remainingQuantity = ch.after.remainingQuantity;
  }
  return walletDoc;
}

/**
 * Same plant rows as GET wallet-details: grouped plant+subtype with slots, then order-derived overlay
 * (bulk vs farmer booked). Single source of truth for dealer quota distribution UI.
 */
export async function getWalletPlantDetailsWithDerivedOverlay(dealerId) {
  const oid =
    typeof dealerId === "string" ? new mongoose.Types.ObjectId(dealerId) : dealerId;

  const walletDetails = await DealerWallet.aggregate([
    { $match: { dealer: oid } },
    {
      $facet: {
        plantDetails: [
          { $unwind: "$entries" },
          {
            $lookup: {
              from: "plantcms",
              localField: "entries.plantType",
              foreignField: "_id",
              as: "plantDetails",
            },
          },
          {
            $lookup: {
              from: "plantcms",
              let: { subTypeId: "$entries.subType" },
              pipeline: [
                { $unwind: "$subtypes" },
                { $match: { $expr: { $eq: ["$subtypes._id", "$$subTypeId"] } } },
              ],
              as: "subtypeDetails",
            },
          },
          {
            $group: {
              _id: {
                plantType: "$entries.plantType",
                subType: "$entries.subType",
              },
              plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
              subtypeName: { $first: { $arrayElemAt: ["$subtypeDetails.subtypes.name", 0] } },
              totalQuantity: { $sum: "$entries.quantity" },
              totalBookedQuantity: { $sum: "$entries.bookedQuantity" },
              totalRemainingQuantity: { $sum: "$entries.remainingQuantity" },
              slotDetails: {
                $push: {
                  slotId: "$entries.bookingSlot",
                  quantity: "$entries.quantity",
                  bookedQuantity: "$entries.bookedQuantity",
                  remainingQuantity: "$entries.remainingQuantity",
                },
              },
            },
          },
          {
            $lookup: {
              from: "plantslots",
              let: { slots: "$slotDetails" },
              pipeline: [
                { $unwind: "$subtypeSlots" },
                { $unwind: "$subtypeSlots.slots" },
                {
                  $match: {
                    $expr: { $in: ["$subtypeSlots.slots._id", "$$slots.slotId"] },
                  },
                },
                {
                  $project: {
                    _id: "$subtypeSlots.slots._id",
                    startDay: "$subtypeSlots.slots.startDay",
                    endDay: "$subtypeSlots.slots.endDay",
                    month: "$subtypeSlots.slots.month",
                  },
                },
              ],
              as: "slotDates",
            },
          },
          {
            $project: {
              _id: 0,
              plantType: "$_id.plantType",
              plantName: 1,
              subType: "$_id.subType",
              subtypeName: 1,
              totalQuantity: 1,
              totalBookedQuantity: 1,
              totalRemainingQuantity: 1,
              slotDetails: {
                $map: {
                  input: "$slotDetails",
                  as: "slot",
                  in: {
                    slotId: "$$slot.slotId",
                    quantity: "$$slot.quantity",
                    bookedQuantity: "$$slot.bookedQuantity",
                    remainingQuantity: "$$slot.remainingQuantity",
                    dates: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: "$slotDates",
                            as: "date",
                            cond: { $eq: ["$$date._id", "$$slot.slotId"] },
                          },
                        },
                        0,
                      ],
                    },
                  },
                },
              },
            },
          },
        ],
      },
    },
  ]);

  let plantDetails = walletDetails[0]?.plantDetails || [];
  if (plantDetails.length === 0) return [];
  const derivedMap = await aggregateDerivedFromOrders(dealerId);
  return overlayOrderDerivedQuotaOnPlantDetails(plantDetails, derivedMap);
}

/**
 * Load wallet and optionally persist reconciled entries.
 */
export async function reconcileDealerWalletEntries(dealerId, { dryRun = true } = {}) {
  const oid =
    typeof dealerId === "string" ? new mongoose.Types.ObjectId(dealerId) : dealerId;

  const derivedMap = await aggregateDerivedFromOrders(oid);
  const wallet = await DealerWallet.findOne({ dealer: oid });
  if (!wallet) {
    return {
      dryRun,
      dealerId: oid.toString(),
      changes: [],
      message: "No DealerWallet document for this dealer.",
      saved: false,
    };
  }

  const { changes, walletModified } = buildWalletCorrectionPlan(wallet, derivedMap);
  if (!walletModified || dryRun) {
    return {
      dryRun,
      dealerId: oid.toString(),
      changes,
      saved: false,
    };
  }

  applyCorrectionPlanToWalletEntries(wallet, changes);
  wallet.markModified("entries");
  await wallet.save();

  return {
    dryRun: false,
    dealerId: oid.toString(),
    changes,
    saved: true,
  };
}
