/**
 * Move an order to another subtype's slot with the SAME startDay/endDay/month
 * (minus booked qty from old subtype slot, add to new subtype slot).
 *
 * Usage (PROD_MONGO_URL or MONGO_URL in .env):
 *   node scripts/reassign-order-subtype-same-slot-window.js <numericOrderId> <newSubtypeObjectId>
 *
 * Example (Papaya 15 no → W-46, same week):
 *   node scripts/reassign-order-subtype-same-slot-window.js 1472 6947adab5c0108fb438e60a6
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import "../models/plantCms.model.js";

dotenv.config();

const uri =
  process.env.PROD_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI;
if (!uri) {
  console.error("Set PROD_MONGO_URL or MONGO_URL");
  process.exit(1);
}

const toObjectId = (value) =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(value);

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveOrderPlantCount = (order) => {
  const numberOfPlants = safeNumber(order.numberOfPlants);
  const additionalPlants = safeNumber(order.additionalPlants);
  const totalPlants = safeNumber(
    order.totalPlants,
    numberOfPlants + additionalPlants
  );
  return totalPlants > 0 ? totalPlants : numberOfPlants + additionalPlants;
};

const getSlotContextById = async (slotId) => {
  if (!slotId) return null;
  const slotObjectId = toObjectId(slotId);
  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotObjectId,
  })
    .populate("plantId", "name sowingAllowed")
    .lean();

  if (!plantSlotDoc) return null;

  let matchedSubtype = null;
  let matchedSlot = null;
  for (const subtypeSlot of plantSlotDoc.subtypeSlots || []) {
    const candidate = (subtypeSlot.slots || []).find(
      (slot) => slot._id.toString() === slotObjectId.toString()
    );
    if (candidate) {
      matchedSubtype = subtypeSlot;
      matchedSlot = candidate;
      break;
    }
  }
  if (!matchedSlot) return null;

  return {
    plantSlotId: plantSlotDoc._id,
    plantId: plantSlotDoc.plantId?._id,
    plantName: plantSlotDoc.plantId?.name,
    isSowingAllowed: Boolean(plantSlotDoc.plantId?.sowingAllowed),
    subtypeId: matchedSubtype?.subtypeId,
    slot: matchedSlot,
  };
};

const findSameWindowSlotForSubtype = (plantSlotDocLean, targetSubtypeId, window) => {
  const tid = targetSubtypeId.toString();
  for (const ss of plantSlotDocLean.subtypeSlots || []) {
    if (!ss.subtypeId || ss.subtypeId.toString() !== tid) continue;
    for (const slot of ss.slots || []) {
      if (
        slot.startDay === window.startDay &&
        slot.endDay === window.endDay &&
        slot.month === window.month
      ) {
        return { subtypeId: ss.subtypeId, slot };
      }
    }
  }
  return null;
};

const buildSlotUpdate = ({ slotContext, orderId, orderPlants, direction }) => {
  const slotId = toObjectId(slotContext.slot._id);
  const currentTotalBooked = safeNumber(slotContext.slot.totalBookedPlants, 0);
  const currentAvailableRaw =
    typeof slotContext.slot.availablePlants === "number"
      ? slotContext.slot.availablePlants
      : safeNumber(slotContext.slot.totalPlants, 0) - currentTotalBooked;

  const isSubtract = direction === "subtract";
  const updatedTotalBooked = isSubtract
    ? Math.max(0, currentTotalBooked - orderPlants)
    : currentTotalBooked + orderPlants;

  let updatedAvailable = currentAvailableRaw;
  if (!slotContext.isSowingAllowed) {
    updatedAvailable = isSubtract
      ? currentAvailableRaw + orderPlants
      : currentAvailableRaw - orderPlants;
  }

  const overflowState =
    !slotContext.isSowingAllowed && typeof updatedAvailable === "number"
      ? updatedAvailable < 0
      : false;

  const updateDoc = {
    $set: {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants":
        updatedTotalBooked,
    },
    arrayFilters: [
      { "subtypeSlot.slots._id": slotId },
      { "slot._id": slotId },
    ],
  };

  if (!slotContext.isSowingAllowed) {
    updateDoc.$set[
      "subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"
    ] = updatedAvailable;
    updateDoc.$set["subtypeSlots.$[subtypeSlot].slots.$[slot].isOverflow"] =
      overflowState;
    updateDoc.$set["subtypeSlots.$[subtypeSlot].slots.$[slot].overflow"] =
      overflowState;
  }

  if (isSubtract) {
    updateDoc.$pull = {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": toObjectId(orderId),
    };
  } else {
    updateDoc.$addToSet = {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": toObjectId(orderId),
    };
  }

  return updateDoc;
};

async function main() {
  const [, , orderIdArg, newSubtypeArg] = process.argv;
  if (!orderIdArg || !newSubtypeArg) {
    console.error(
      "Usage: node scripts/reassign-order-subtype-same-slot-window.js <orderId> <newSubtypeObjectId>"
    );
    process.exit(1);
  }

  const orderIdNum = Number(orderIdArg);
  if (!Number.isFinite(orderIdNum)) {
    console.error("Invalid order id");
    process.exit(1);
  }

  const newSubtypeId = toObjectId(newSubtypeArg);

  await mongoose.connect(uri);

  const order = await Order.findOne({ orderId: orderIdNum });
  if (!order) {
    console.error("Order not found:", orderIdNum);
    process.exit(1);
  }

  const orderPlants = resolveOrderPlantCount(order);
  const mongoOrderId = order._id;

  const currentContext = await getSlotContextById(order.bookingSlot);
  if (!currentContext) {
    console.error("Current booking slot not found");
    process.exit(1);
  }

  if (currentContext.subtypeId.toString() === newSubtypeId.toString()) {
    console.log("Order already on target subtype.");
    process.exit(0);
  }

  const plantSlotFull = await PlantSlot.findById(currentContext.plantSlotId).lean();
  if (!plantSlotFull) {
    console.error("PlantSlot parent missing");
    process.exit(1);
  }

  const window = {
    startDay: currentContext.slot.startDay,
    endDay: currentContext.slot.endDay,
    month: currentContext.slot.month,
  };

  const target = findSameWindowSlotForSubtype(
    plantSlotFull,
    newSubtypeId,
    window
  );
  if (!target?.slot) {
    console.error(
      "No slot for target subtype with same window:",
      JSON.stringify(window)
    );
    process.exit(1);
  }

  const nextContext = {
    plantSlotId: currentContext.plantSlotId,
    plantId: currentContext.plantId,
    plantName: currentContext.plantName,
    isSowingAllowed: currentContext.isSowingAllowed,
    subtypeId: target.subtypeId,
    slot: target.slot,
  };

  console.log("Order", orderIdNum, "plants", orderPlants);
  console.log(
    "From subtype",
    currentContext.subtypeId.toString(),
    "slot",
    currentContext.slot._id.toString()
  );
  console.log(
    "To subtype",
    nextContext.subtypeId.toString(),
    "slot",
    nextContext.slot._id.toString()
  );
  console.log("Window", window.startDay, "→", window.endDay, window.month);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const removeUpdate = buildSlotUpdate({
        slotContext: { ...currentContext, orderId: mongoOrderId },
        orderId: mongoOrderId,
        orderPlants,
        direction: "subtract",
      });

      await PlantSlot.updateOne(
        { _id: currentContext.plantSlotId },
        removeUpdate,
        { session, arrayFilters: removeUpdate.arrayFilters }
      );

      const addUpdate = buildSlotUpdate({
        slotContext: { ...nextContext, orderId: mongoOrderId },
        orderId: mongoOrderId,
        orderPlants,
        direction: "add",
      });

      await PlantSlot.updateOne(
        { _id: nextContext.plantSlotId },
        addUpdate,
        { session, arrayFilters: addUpdate.arrayFilters }
      );

      await Order.updateOne(
        { _id: mongoOrderId },
        {
          $set: {
            bookingSlot: toObjectId(nextContext.slot._id),
            plantSubtype: newSubtypeId,
          },
          $push: {
            orderEditHistory: {
              field: "plantSubtype+bookingSlot",
              previousValue: {
                plantSubtype: order.plantSubtype,
                bookingSlot: order.bookingSlot,
              },
              newValue: {
                plantSubtype: newSubtypeId,
                bookingSlot: nextContext.slot._id,
              },
              notes: `Reassigned to same slot window (${window.startDay}–${window.endDay}) new subtype`,
            },
          },
        },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  console.log("Done.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
