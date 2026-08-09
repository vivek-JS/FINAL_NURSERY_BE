import mongoose from "mongoose";
import multer from "multer";
import RaisingSeedIntake from "../models/raisingSeedIntake.model.js";
import PlantCms from "../models/plantCms.model.js";
import Product from "../models/product.model.js";
import Order from "../models/order.model.js";
import { uploadMultipleImagesToLocalStorage } from "../utils/localStorageUtils.js";

const ACTIVE_ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

export const raisingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 8 },
});

async function bustLiteCache() {
  try {
    const { bustTodaySowingCardsLiteCache } = await import(
      "./sowingCardsLite.controller.js"
    );
    bustTodaySowingCardsLiteCache();
  } catch (_) {
    /* optional */
  }
}

function parseLinkedSlotIds(linkedSlotIds) {
  let slotIds = [];
  if (Array.isArray(linkedSlotIds)) {
    slotIds = linkedSlotIds;
  } else if (typeof linkedSlotIds === "string" && linkedSlotIds.trim()) {
    try {
      const parsed = JSON.parse(linkedSlotIds);
      slotIds = Array.isArray(parsed) ? parsed : [linkedSlotIds];
    } catch {
      slotIds = [linkedSlotIds];
    }
  }
  return slotIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

function parseBatchesPayload(raw, fallback = {}) {
  let list = [];
  if (typeof raw === "string" && raw.trim()) {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  }

  const normalized = (Array.isArray(list) ? list : [])
    .map((b) => {
      const batchNumber = String(b?.batchNumber || "").trim();
      const packets = Number(b?.packets ?? b?.packetsReceived);
      const exp = b?.expiryDate;
      return {
        batchNumber,
        packets,
        expiryDate:
          exp === "" || exp == null
            ? undefined
            : new Date(exp),
      };
    })
    .filter(
      (b) =>
        b.batchNumber &&
        Number.isFinite(b.packets) &&
        b.packets > 0 &&
        (!b.expiryDate || !Number.isNaN(b.expiryDate.getTime()))
    );

  if (normalized.length) return normalized;

  // Legacy single-batch body
  const batchNumber = String(fallback.batchNumber || "").trim();
  const packets = Number(fallback.packetsReceived);
  if (batchNumber && Number.isFinite(packets) && packets > 0) {
    return [
      {
        batchNumber,
        packets,
        expiryDate: fallback.expiryDate
          ? new Date(fallback.expiryDate)
          : undefined,
      },
    ];
  }
  return [];
}

function summarizeBatches(batches) {
  const total = batches.reduce((s, b) => s + Number(b.packets || 0), 0);
  const batchNumber = batches.map((b) => b.batchNumber).join(" · ");
  const withExp = batches
    .map((b) => b.expiryDate)
    .filter(Boolean)
    .sort((a, b) => new Date(a) - new Date(b));
  return {
    packetsReceived: Number(total.toFixed(4)),
    batchNumber: batchNumber.slice(0, 200) || batches[0]?.batchNumber || "",
    expiryDate: withExp[0] || undefined,
  };
}

function orderRaisingSnapshot(intake) {
  const batches = Array.isArray(intake.batches)
    ? intake.batches.map((b) => ({
        batchNumber: b.batchNumber || "",
        packets: Number(b.packets) || 0,
        expiryDate: b.expiryDate || undefined,
      }))
    : [];
  return {
    intakeNumber: intake.intakeNumber || "",
    packetsReceived: Number(intake.packetsReceived) || 0,
    packetsRemaining: Number(intake.packetsRemaining) || 0,
    batchNumber: intake.batchNumber || "",
    expiryDate: intake.expiryDate || undefined,
    batches,
    farmerName: intake.farmerName || "",
    notes: intake.notes || "",
    collectedAt: intake.createdAt || new Date(),
    updatedAt: intake.updatedAt || new Date(),
  };
}

async function syncOrderRaisingIntake(orderId, intake, { seedSource } = {}) {
  if (!orderId || !intake?._id) return;
  const set = {
    "sowingPlan.raisingSeedPackets": Number(intake.packetsReceived) || 0,
    "sowingPlan.raisingIntakeCollected": true,
    "sowingPlan.raisingIntakeId": intake._id,
    "sowingPlan.raisingIntake": orderRaisingSnapshot(intake),
  };
  if (seedSource) set["sowingPlan.seedSource"] = seedSource;
  await Order.updateOne({ _id: orderId }, { $set: set });
}

export const createRaisingIntake = async (req, res) => {
  try {
    const {
      orderId,
      farmerId,
      farmerName,
      plantId,
      subtypeId,
      packetsReceived,
      batchNumber,
      expiryDate,
      batches: batchesRaw,
      notes,
      linkedSlotIds,
    } = req.body;

    const batches = parseBatchesPayload(batchesRaw, {
      batchNumber,
      packetsReceived,
      expiryDate,
    });
    if (!plantId || !subtypeId || !batches.length) {
      return res.status(400).json({
        success: false,
        message:
          "plantId, subtypeId, and at least one batch (batchNumber + packets > 0) are required",
      });
    }
    const summary = summarizeBatches(batches);
    const packets = summary.packetsReceived;

    const plant = await PlantCms.findById(plantId).select("name subtypes").lean();
    if (!plant) {
      return res.status(404).json({ success: false, message: "Plant not found" });
    }

    const subtype = plant.subtypes?.find(
      (st) => st._id.toString() === subtypeId.toString()
    );
    if (!subtype) {
      return res.status(404).json({ success: false, message: "Subtype not found" });
    }

    const product = await Product.findOne({
      plantId: new mongoose.Types.ObjectId(plantId),
      subtypeId: new mongoose.Types.ObjectId(subtypeId),
      category: { $regex: /^seeds$/i },
      isActive: true,
    })
      .select("_id conversionFactor")
      .lean();

    let resolvedFarmerName = farmerName || "";
    let resolvedFarmerId = farmerId || null;
    let orderDoc = null;
    if (orderId && mongoose.Types.ObjectId.isValid(orderId)) {
      orderDoc = await Order.findById(orderId)
        .select("farmer name orderId sowingPlan")
        .populate("farmer", "name")
        .lean();
      if (orderDoc) {
        resolvedFarmerId =
          resolvedFarmerId || orderDoc.farmer?._id || orderDoc.farmer || null;
        resolvedFarmerName =
          resolvedFarmerName ||
          orderDoc.farmer?.name ||
          orderDoc.name ||
          "";

        // Only one raising collect per order
        if (
          orderDoc.sowingPlan?.raisingIntakeCollected ||
          orderDoc.sowingPlan?.raisingIntakeId
        ) {
          return res.status(409).json({
            success: false,
            message:
              "Raising seed already collected for this order. Edit the existing intake instead.",
            data: {
              raisingIntakeId: orderDoc.sowingPlan?.raisingIntakeId,
              raisingIntake: orderDoc.sowingPlan?.raisingIntake || null,
            },
          });
        }
        const existing = await RaisingSeedIntake.findOne({
          orderId: orderDoc._id,
        })
          .select("_id intakeNumber")
          .lean();
        if (existing) {
          return res.status(409).json({
            success: false,
            message:
              "Raising seed already collected for this order. Edit the existing intake instead.",
            data: { raisingIntakeId: existing._id, intakeNumber: existing.intakeNumber },
          });
        }
      }
    }

    const photos = [];
    if (req.files?.length) {
      const uploads = await uploadMultipleImagesToLocalStorage(
        req.files.map((f) => f.buffer),
        `raising-seed/${Date.now()}`
      );
      uploads
        .filter((u) => u.success)
        .forEach((u) => photos.push({ url: u.url, caption: "raising-packet" }));
    }

    const slotIds = parseLinkedSlotIds(linkedSlotIds);

    const intakeNumber = await RaisingSeedIntake.generateIntakeNumber();
    let intake;
    try {
      intake = await RaisingSeedIntake.create({
        intakeNumber,
        orderId: orderDoc?._id || (orderId || undefined),
        farmerId: resolvedFarmerId || undefined,
        farmerName: resolvedFarmerName,
        plantId,
        plantName: plant.name,
        subtypeId,
        subtypeName: subtype.name,
        productId: product?._id,
      packetsReceived: packets,
      packetsRemaining: packets,
      conversionFactor: product?.conversionFactor || 1,
      batchNumber: summary.batchNumber,
      expiryDate: summary.expiryDate,
      batches,
      photos,
      linkedSlotIds: slotIds,
      notes: notes || "",
      status: "received",
      receivedBy: req.user?._id,
    });
    } catch (err) {
      if (err?.code === 11000 && orderDoc?._id) {
        return res.status(409).json({
          success: false,
          message:
            "Raising seed already collected for this order. Edit the existing intake instead.",
        });
      }
      throw err;
    }

    if (orderDoc?._id) {
      const nextSource =
        orderDoc.sowingPlan?.seedSource === "MIXED" ? "MIXED" : "RAISING";
      await syncOrderRaisingIntake(orderDoc._id, intake, { seedSource: nextSource });
    }

    await bustLiteCache();

    return res.status(201).json({
      success: true,
      message: "Customer seed received",
      data: intake,
    });
  } catch (error) {
    console.error("createRaisingIntake:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create raising intake",
      error: error.message,
    });
  }
};

/** Edit existing raising intake (same form from inventory + order detail). */
export const updateRaisingIntake = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid intake id" });
    }

    const intake = await RaisingSeedIntake.findById(id);
    if (!intake) {
      return res.status(404).json({ success: false, message: "Intake not found" });
    }

    const {
      packetsReceived,
      batchNumber,
      expiryDate,
      batches: batchesRaw,
      notes,
      farmerName,
      linkedSlotIds,
    } = req.body;

    if (farmerName != null) intake.farmerName = String(farmerName).trim();
    if (notes != null) intake.notes = String(notes);
    if (linkedSlotIds != null) {
      intake.linkedSlotIds = parseLinkedSlotIds(linkedSlotIds);
    }

    const hasBatchesField =
      batchesRaw != null &&
      !(typeof batchesRaw === "string" && !String(batchesRaw).trim());
    const batches = hasBatchesField
      ? parseBatchesPayload(batchesRaw, {
          batchNumber,
          packetsReceived,
          expiryDate,
        })
      : null;

    if (batches) {
      if (!batches.length) {
        return res.status(400).json({
          success: false,
          message: "At least one batch with batchNumber and packets > 0 is required",
        });
      }
      const summary = summarizeBatches(batches);
      const used = Math.max(
        0,
        Number(intake.packetsReceived) - Number(intake.packetsRemaining)
      );
      if (summary.packetsReceived < used) {
        return res.status(400).json({
          success: false,
          message: `Cannot set packets below already used (${used})`,
        });
      }
      intake.batches = batches;
      intake.packetsReceived = summary.packetsReceived;
      intake.packetsRemaining = Number(
        (summary.packetsReceived - used).toFixed(4)
      );
      intake.batchNumber = summary.batchNumber;
      intake.expiryDate = summary.expiryDate;
      if (intake.packetsRemaining <= 0) {
        intake.packetsRemaining = 0;
        intake.status = "used";
      } else if (used > 0) {
        intake.status = "partially_used";
      } else {
        intake.status = "received";
      }
    } else {
      if (batchNumber != null && String(batchNumber).trim()) {
        intake.batchNumber = String(batchNumber).trim();
      }
      if (expiryDate === "" || expiryDate === null) {
        intake.expiryDate = undefined;
      } else if (expiryDate) {
        intake.expiryDate = new Date(expiryDate);
      }
      if (packetsReceived != null && packetsReceived !== "") {
        const packets = Number(packetsReceived);
        if (!Number.isFinite(packets) || packets <= 0) {
          return res.status(400).json({
            success: false,
            message: "packetsReceived must be > 0",
          });
        }
        const used = Math.max(
          0,
          Number(intake.packetsReceived) - Number(intake.packetsRemaining)
        );
        if (packets < used) {
          return res.status(400).json({
            success: false,
            message: `Cannot set packets below already used (${used})`,
          });
        }
        intake.packetsReceived = packets;
        intake.packetsRemaining = Number((packets - used).toFixed(4));
        if (!intake.batches?.length) {
          intake.batches = [
            {
              batchNumber: intake.batchNumber,
              packets,
              expiryDate: intake.expiryDate,
            },
          ];
        }
        if (intake.packetsRemaining <= 0) {
          intake.packetsRemaining = 0;
          intake.status = "used";
        } else if (used > 0) {
          intake.status = "partially_used";
        } else {
          intake.status = "received";
        }
      }
    }

    if (req.files?.length) {
      const uploads = await uploadMultipleImagesToLocalStorage(
        req.files.map((f) => f.buffer),
        `raising-seed/${Date.now()}`
      );
      uploads
        .filter((u) => u.success)
        .forEach((u) =>
          intake.photos.push({ url: u.url, caption: "raising-packet" })
        );
    }

    await intake.save();

    if (intake.orderId) {
      await syncOrderRaisingIntake(intake.orderId, intake);
    }

    await bustLiteCache();

    return res.json({
      success: true,
      message: "Raising intake updated",
      data: intake,
    });
  } catch (error) {
    console.error("updateRaisingIntake:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update raising intake",
      error: error.message,
    });
  }
};

export const getRaisingIntakeByOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }
    const intake = await RaisingSeedIntake.findOne({ orderId }).lean();
    if (!intake) {
      return res.json({ success: true, data: null });
    }
    return res.json({ success: true, data: intake });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to get intake for order",
      error: error.message,
    });
  }
};

export const getAvailableRaisingIntakes = async (req, res) => {
  try {
    const { plantId, subtypeId, orderId } = req.query;
    const query = {
      packetsRemaining: { $gt: 0 },
      status: { $in: ["received", "allocated", "partially_used"] },
    };
    if (plantId) query.plantId = plantId;
    if (subtypeId) query.subtypeId = subtypeId;
    if (orderId) query.orderId = orderId;

    const rows = await RaisingSeedIntake.find(query)
      .select(
        "intakeNumber orderId farmerName plantId plantName subtypeId subtypeName packetsReceived packetsRemaining batchNumber expiryDate photos status conversionFactor createdAt"
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to list raising intakes",
      error: error.message,
    });
  }
};

/**
 * Orders flagged for farmer seed that inventory can collect against.
 * q = order # / mobile / name search.
 */
export const getPendingRaisingOrders = async (req, res) => {
  const t0 = Date.now();
  try {
    const q = String(req.query.q || "").trim();
    const match = {
      orderStatus: { $in: ACTIVE_ORDER_STATUSES },
      "sowingPlan.seedSource": { $in: ["RAISING", "MIXED"] },
    };

    const orders = await Order.find(match)
      .select(
        "orderId name farmer plantName plantSubtype numberOfPlants additionalPlants sowingPlan bookingSlot createdAt orderStatus"
      )
      .populate("farmer", "name mobileNumber village")
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    const ql = q.toLowerCase();
    const filtered = !q
      ? orders.slice(0, 40)
      : orders
          .filter((o) => {
            const orderNo = String(o.orderId ?? "");
            const nm = String(o.farmer?.name || o.name || "").toLowerCase();
            const mob = String(o.farmer?.mobileNumber || "");
            return (
              orderNo.includes(q) ||
              nm.includes(ql) ||
              mob.includes(q)
            );
          })
          .slice(0, 40);

    const plantIds = [
      ...new Set(
        filtered
          .map((o) => String(o.plantName || ""))
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));

    const plants = plantIds.length
      ? await PlantCms.find({ _id: { $in: plantIds } })
          .select("name subtypes._id subtypes.name")
          .lean()
      : [];
    const plantMap = new Map(plants.map((p) => [String(p._id), p]));

    const orderIds = filtered.map((o) => o._id);
    const intakeAgg = orderIds.length
      ? await RaisingSeedIntake.aggregate([
          {
            $match: {
              orderId: { $in: orderIds },
            },
          },
          {
            $group: {
              _id: "$orderId",
              packetsInHand: {
                $sum: {
                  $cond: [
                    { $gt: ["$packetsRemaining", 0] },
                    "$packetsRemaining",
                    0,
                  ],
                },
              },
              packetsReceived: { $sum: "$packetsReceived" },
              intakeCount: { $sum: 1 },
            },
          },
        ])
      : [];
    const intakeMap = new Map(intakeAgg.map((r) => [String(r._id), r]));

    const data = filtered.map((o) => {
      const plantsCount =
        (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const plantId = o.plantName ? String(o.plantName) : null;
      const subtypeId = o.plantSubtype ? String(o.plantSubtype) : null;
      const plant = plantMap.get(plantId);
      const subtype = plant?.subtypes?.find(
        (st) => String(st._id) === subtypeId
      );
      const inc = intakeMap.get(String(o._id)) || {};
      const collected =
        Boolean(o.sowingPlan?.raisingIntakeCollected) ||
        Boolean(o.sowingPlan?.raisingIntakeId) ||
        (inc.intakeCount || 0) > 0;
      return {
        orderId: o._id,
        orderNumber: o.orderId,
        farmerName: o.farmer?.name || o.name || "",
        farmerMobile: o.farmer?.mobileNumber || "",
        village: o.farmer?.village || "",
        plantId,
        plantName: plant?.name || "",
        subtypeId,
        subtypeName: subtype?.name || "",
        numberOfPlants: plantsCount,
        seedSource: o.sowingPlan?.seedSource || "RAISING",
        planRaisingPackets: Number(o.sowingPlan?.raisingSeedPackets) || 0,
        packetsInHand: Number(inc.packetsInHand) || 0,
        packetsReceivedTotal: Number(inc.packetsReceived) || 0,
        intakeCount: inc.intakeCount || 0,
        raisingCollected: collected,
        raisingIntakeId: o.sowingPlan?.raisingIntakeId || null,
        raisingIntake: o.sowingPlan?.raisingIntake || null,
        bookingSlot: o.bookingSlot,
        orderStatus: o.orderStatus,
        createdAt: o.createdAt,
      };
    });

    return res.json({
      success: true,
      data,
      ms: Date.now() - t0,
    });
  } catch (error) {
    console.error("getPendingRaisingOrders:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to list pending raising orders",
      error: error.message,
    });
  }
};

export const getRaisingIntakeById = async (req, res) => {
  try {
    const intake = await RaisingSeedIntake.findById(req.params.id).lean();
    if (!intake) {
      return res.status(404).json({ success: false, message: "Intake not found" });
    }
    return res.json({ success: true, data: intake });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to get intake",
      error: error.message,
    });
  }
};

/**
 * FIFO allocate raising packets across intakes. Mutates DB.
 * @returns {{ intakeIds: ObjectId[], allocated: number }}
 */
export async function allocateRaisingPackets({
  plantId,
  subtypeId,
  packetsNeeded,
  preferredIntakeIds = [],
  linkedOrderIds = [],
}) {
  const need = Number(packetsNeeded) || 0;
  if (need <= 0) return { intakeIds: [], allocated: 0 };

  const baseQuery = {
    plantId: new mongoose.Types.ObjectId(plantId),
    subtypeId: new mongoose.Types.ObjectId(subtypeId),
    packetsRemaining: { $gt: 0 },
    status: { $in: ["received", "allocated", "partially_used"] },
  };

  let intakes = [];
  if (preferredIntakeIds.length) {
    intakes = await RaisingSeedIntake.find({
      ...baseQuery,
      _id: {
        $in: preferredIntakeIds.map((id) => new mongoose.Types.ObjectId(id)),
      },
    }).sort({ createdAt: 1 });
  }

  if (!intakes.length && linkedOrderIds.length) {
    intakes = await RaisingSeedIntake.find({
      ...baseQuery,
      orderId: {
        $in: linkedOrderIds.map((id) => new mongoose.Types.ObjectId(id)),
      },
    }).sort({ createdAt: 1 });
  }

  if (!intakes.length) {
    intakes = await RaisingSeedIntake.find(baseQuery).sort({ createdAt: 1 });
  }

  let remaining = need;
  const usedIds = [];
  for (const intake of intakes) {
    if (remaining <= 0) break;
    const take = Math.min(Number(intake.packetsRemaining) || 0, remaining);
    if (take <= 0) continue;
    intake.packetsRemaining = Number(
      (Number(intake.packetsRemaining) - take).toFixed(4)
    );
    if (intake.packetsRemaining <= 0) {
      intake.packetsRemaining = 0;
      intake.status = "used";
    } else if (intake.packetsRemaining < intake.packetsReceived) {
      intake.status = "partially_used";
    } else {
      intake.status = "allocated";
    }
    await intake.save();
    usedIds.push(intake._id);
    remaining = Number((remaining - take).toFixed(4));
  }

  return {
    intakeIds: usedIds,
    allocated: Number((need - remaining).toFixed(4)),
    shortfall: Math.max(0, remaining),
  };
}
