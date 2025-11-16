import mongoose from "mongoose";
import dotenv from "dotenv";
import moment from "moment";

import Order from "../models/order.model.js";
import PlantSlot from "../models/slots.model.js";
import "../models/plantCms.model.js";

dotenv.config();

const MONGO_URI =
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  "mongodb://127.0.0.1:27017/nursery-management";
const IST_OFFSET = "+05:30";
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARGUMENT = process.argv.find((arg) => arg.startsWith("--limit="));
const LIMIT = LIMIT_ARGUMENT ? Number(LIMIT_ARGUMENT.split("=")[1]) : null;

const summary = {
  totalOrdersScanned: 0,
  matchesVerified: 0,
  mismatchesFound: 0,
  reassigned: 0,
  skippedNoExistingSlot: 0,
  skippedNoMatchingSlot: 0,
  skippedZeroQuantity: 0,
  dryRun: DRY_RUN,
  errors: 0,
  examplesFixed: [],
  examplesMissingSlot: [],
  examplesNoTargetSlot: [],
  startedAt: new Date(),
};

const toObjectId = (value) => {
  if (!value) return null;
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(value);
};

const normalizeToISTStart = (input) =>
  moment(input).utcOffset(IST_OFFSET).startOf("day");

const normalizeToISTEnd = (input) =>
  moment(input).utcOffset(IST_OFFSET).endOf("day");

const formatDate = (input) =>
  moment(input).utcOffset(IST_OFFSET).format("DD-MM-YYYY");

const formatSlotWindow = (slot) => {
  if (!slot) return "Unknown slot";
  const range = `${slot.startDay || "??"} → ${slot.endDay || "??"}`;
  return `${range} (${slot.month || "?"})`;
};

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveOrderPlantCount = (order) => {
  const numberOfPlants = safeNumber(order.numberOfPlants);
  const additionalPlants = safeNumber(order.additionalPlants);
  const totalPlants = safeNumber(order.totalPlants, numberOfPlants + additionalPlants);
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

  if (!plantSlotDoc) {
    return null;
  }

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

  if (!matchedSlot) {
    return null;
  }

  return {
    plantSlotId: plantSlotDoc._id,
    plantId: plantSlotDoc.plantId?._id,
    plantName: plantSlotDoc.plantId?.name,
    isSowingAllowed: Boolean(plantSlotDoc.plantId?.sowingAllowed),
    subtypeId: matchedSubtype?.subtypeId,
    slot: matchedSlot,
  };
};

const isDateWithinSlot = (deliveryDate, slot) => {
  if (!deliveryDate || !slot?.startDay || !slot?.endDay) {
    return false;
  }

  const deliveryMoment = normalizeToISTStart(deliveryDate);
  const startMoment = normalizeToISTStart(
    moment(slot.startDay, "DD-MM-YYYY").toDate()
  );
  const endMoment = normalizeToISTEnd(moment(slot.endDay, "DD-MM-YYYY").toDate());

  if (!deliveryMoment.isValid() || !startMoment.isValid() || !endMoment.isValid()) {
    return false;
  }

  return deliveryMoment.isBetween(startMoment, endMoment, "day", "[]");
};

const findSlotForOrder = async (order) => {
  if (!order?.deliveryDate || !order?.plantName || !order?.plantSubtype) {
    return null;
  }

  const deliveryMoment = normalizeToISTStart(order.deliveryDate);
  if (!deliveryMoment.isValid()) {
    return null;
  }

  const targetYears = [
    deliveryMoment.year() - 1,
    deliveryMoment.year(),
    deliveryMoment.year() + 1,
  ];

  const plantSlots = await PlantSlot.find({
    plantId: toObjectId(order.plantName),
    year: { $in: targetYears },
    "subtypeSlots.subtypeId": toObjectId(order.plantSubtype),
  })
    .populate("plantId", "name sowingAllowed")
    .lean();

  if (!plantSlots?.length) {
    return null;
  }

  let bestCandidate = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestIsFuture = false;

  for (const plantSlotDoc of plantSlots) {
    const subtypeSlot = (plantSlotDoc.subtypeSlots || []).find(
      (slotGroup) =>
        slotGroup.subtypeId?.toString() === order.plantSubtype.toString()
    );

    if (!subtypeSlot) continue;

    for (const slot of subtypeSlot.slots || []) {
      const startMoment = normalizeToISTStart(
        moment(slot.startDay, "DD-MM-YYYY").toDate()
      );
      const endMoment = normalizeToISTEnd(
        moment(slot.endDay, "DD-MM-YYYY").toDate()
      );

      if (!startMoment.isValid() || !endMoment.isValid()) {
        continue;
      }

      if (
        deliveryMoment.isSameOrAfter(startMoment, "day") &&
        deliveryMoment.isSameOrBefore(endMoment, "day")
      ) {
        return {
          plantSlotId: plantSlotDoc._id,
          plantId: plantSlotDoc.plantId?._id,
          plantName: plantSlotDoc.plantId?.name,
          isSowingAllowed: Boolean(plantSlotDoc.plantId?.sowingAllowed),
          subtypeId: subtypeSlot.subtypeId,
          slot,
        };
      }

      const daysToStart = startMoment.diff(deliveryMoment, "days");
      const daysFromEnd = deliveryMoment.diff(endMoment, "days");

      const normalizedDistance = Math.min(
        Math.abs(daysToStart),
        Math.abs(daysFromEnd)
      );

      const withinGraceWindow =
        (daysToStart >= 0 && daysToStart <= 3) ||
        (daysFromEnd >= 0 && daysFromEnd <= 3);

      const isFutureSlot = daysToStart >= 0 && daysToStart <= 3;

      if (
        withinGraceWindow &&
        (normalizedDistance < bestDistance ||
          (normalizedDistance === bestDistance &&
            isFutureSlot &&
            !bestIsFuture))
      ) {
        bestDistance = normalizedDistance;
        bestIsFuture = isFutureSlot;
        bestCandidate = {
          plantSlotId: plantSlotDoc._id,
          plantId: plantSlotDoc.plantId?._id,
          plantName: plantSlotDoc.plantId?.name,
          isSowingAllowed: Boolean(plantSlotDoc.plantId?.sowingAllowed),
          subtypeId: subtypeSlot.subtypeId,
          slot,
        };
      }
    }
  }

  return bestCandidate;
};

const buildSlotUpdate = ({ slotContext, orderPlants, direction }) => {
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
    updateDoc.$set["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] =
      updatedAvailable;
    updateDoc.$set["subtypeSlots.$[subtypeSlot].slots.$[slot].isOverflow"] =
      overflowState;
    updateDoc.$set["subtypeSlots.$[subtypeSlot].slots.$[slot].overflow"] =
      overflowState;
  }

  if (isSubtract) {
    updateDoc.$pull = {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": toObjectId(
        slotContext.orderId
      ),
    };
  } else {
    updateDoc.$addToSet = {
      "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": toObjectId(
        slotContext.orderId
      ),
    };
  }

  return updateDoc;
};

const reassignOrderToSlot = async (order, currentContext, nextContext) => {
  const session = await mongoose.startSession();
  const orderId = toObjectId(order._id);
  const orderPlants = resolveOrderPlantCount(order);

  const payload = {
    previousSlot: currentContext?.slot,
    targetSlot: nextContext.slot,
    orderPlants,
  };

  if (DRY_RUN) {
    console.log(
      `🟡 [DRY-RUN] Order #${order.orderId || orderId} would move from ${formatSlotWindow(
        payload.previousSlot
      )} to ${formatSlotWindow(payload.targetSlot)}`
    );
    summary.reassigned += 1;
    summary.examplesFixed.push({
      orderId: order.orderId || orderId?.toString(),
      from: currentContext?.slot?._id?.toString(),
      to: nextContext.slot?._id?.toString(),
    });
    session.endSession();
    return;
  }

  try {
    await session.withTransaction(async () => {
      if (orderPlants <= 0) {
        summary.skippedZeroQuantity += 1;
        throw new Error("Order has zero plants; skipping reassignment.");
      }

      if (currentContext) {
        const removeUpdate = buildSlotUpdate({
          slotContext: { ...currentContext, orderId },
          orderPlants,
          direction: "subtract",
        });

        await PlantSlot.updateOne(
          { _id: currentContext.plantSlotId },
          removeUpdate,
          { session, arrayFilters: removeUpdate.arrayFilters }
        );
      }

      const addUpdate = buildSlotUpdate({
        slotContext: { ...nextContext, orderId },
        orderPlants,
        direction: "add",
      });

      await PlantSlot.updateOne(
        { _id: nextContext.plantSlotId },
        addUpdate,
        { session, arrayFilters: addUpdate.arrayFilters }
      );

      const deliveryChangeEntry = currentContext
        ? {
            previousDeliveryDate: {
              startDay: currentContext.slot.startDay,
              endDay: currentContext.slot.endDay,
              month: currentContext.slot.month,
              year: new Date().getFullYear(),
            },
            newDeliveryDate: {
              startDay: nextContext.slot.startDay,
              endDay: nextContext.slot.endDay,
              month: nextContext.slot.month,
              year: new Date().getFullYear(),
            },
            previousSlot: toObjectId(currentContext.slot._id),
            newSlot: toObjectId(nextContext.slot._id),
            reasonForChange: "Auto realigned to match deliveryDate",
            changedBy: null,
          }
        : null;

      const orderUpdate = {
        $set: {
          bookingSlot: toObjectId(nextContext.slot._id),
        },
      };

      if (deliveryChangeEntry) {
        orderUpdate.$push = {
          deliveryChanges: deliveryChangeEntry,
          orderEditHistory: {
            field: "bookingSlot",
            previousValue: toObjectId(currentContext.slot._id),
            newValue: toObjectId(nextContext.slot._id),
            notes: `Auto realigned to slot ${formatSlotWindow(
              nextContext.slot
            )} on ${new Date().toISOString()}`,
          },
        };
      }

      await Order.updateOne({ _id: orderId }, orderUpdate, { session });
    });

    summary.reassigned += 1;
    if (summary.examplesFixed.length < 20) {
      summary.examplesFixed.push({
        orderId: order.orderId || orderId?.toString(),
        from: currentContext?.slot?._id?.toString() || null,
        to: nextContext.slot?._id?.toString(),
        deliveryDate: formatDate(order.deliveryDate),
      });
    }
  } catch (error) {
    summary.errors += 1;
    console.error(
      `❌ Failed to reassign order #${order.orderId || orderId?.toString()}:`,
      error.message
    );
  } finally {
    await session.endSession();
  }
};

const processOrders = async () => {
  console.log("===========================================");
  console.log("🔍 Checking orders for delivery-slot mismatch");
  console.log("===========================================\n");
  console.log(`Mongo URI: ${MONGO_URI}`);
  console.log(`Dry run: ${DRY_RUN ? "Yes" : "No"}`);
  if (LIMIT) {
    console.log(`Processing limit: ${LIMIT} order(s)`);
  }
  console.log("");

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB\n");

  const query = {
    deliveryDate: { $exists: true, $ne: null },
    bookingSlot: { $exists: true, $ne: null },
  };

  const projection = {
    orderId: 1,
    bookingSlot: 1,
    deliveryDate: 1,
    plantName: 1,
    plantSubtype: 1,
    numberOfPlants: 1,
    additionalPlants: 1,
    totalPlants: 1,
    orderStatus: 1,
  };

  const cursor = Order.find(query).select(projection).cursor();

  for await (const order of cursor) {
    if (LIMIT && summary.totalOrdersScanned >= LIMIT) {
      break;
    }

    summary.totalOrdersScanned += 1;
    const orderIdDisplay = order.orderId || order._id?.toString();

    const currentContext = await getSlotContextById(order.bookingSlot);
    if (!currentContext) {
      summary.skippedNoExistingSlot += 1;
      if (summary.examplesMissingSlot.length < 20) {
        summary.examplesMissingSlot.push({
          orderId: orderIdDisplay,
          bookingSlot: order.bookingSlot?.toString(),
          deliveryDate: formatDate(order.deliveryDate),
        });
      }
      continue;
    }

    const aligned = isDateWithinSlot(order.deliveryDate, currentContext.slot);
    if (aligned) {
      summary.matchesVerified += 1;
      continue;
    }

    summary.mismatchesFound += 1;

    const targetContext = await findSlotForOrder(order);
    if (!targetContext) {
      summary.skippedNoMatchingSlot += 1;
      if (summary.examplesNoTargetSlot.length < 20) {
        summary.examplesNoTargetSlot.push({
          orderId: orderIdDisplay,
          deliveryDate: formatDate(order.deliveryDate),
          currentSlot: formatSlotWindow(currentContext.slot),
        });
      }
      console.warn(
        `⚠️  No matching slot found for order #${orderIdDisplay} (delivery ${formatDate(
          order.deliveryDate
        )})`
      );
      continue;
    }

    const currentSlotId = currentContext.slot?._id?.toString();
    const targetSlotId = targetContext.slot?._id?.toString();

    if (currentSlotId === targetSlotId) {
      summary.matchesVerified += 1;
      continue;
    }

    console.log(
      `🔁 Realigning order #${orderIdDisplay}: ${formatSlotWindow(
        currentContext.slot
      )} → ${formatSlotWindow(targetContext.slot)}`
    );

    await reassignOrderToSlot(order, currentContext, targetContext);
  }

  await mongoose.disconnect();
  console.log("\n🔌 MongoDB connection closed\n");
};

const printSummary = () => {
  const durationMs = Date.now() - summary.startedAt.getTime();
  console.log("===========================================");
  console.log("📦 Delivery Slot Alignment Summary");
  console.log("===========================================\n");

  console.log(`Total orders scanned      : ${summary.totalOrdersScanned}`);
  console.log(`Matches already correct   : ${summary.matchesVerified}`);
  console.log(`Mismatches detected       : ${summary.mismatchesFound}`);
  console.log(`Reassigned successfully   : ${summary.reassigned}`);
  console.log(`Skipped (no slot found)   : ${summary.skippedNoExistingSlot}`);
  console.log(`Skipped (no target slot)  : ${summary.skippedNoMatchingSlot}`);
  console.log(`Skipped (zero plants)     : ${summary.skippedZeroQuantity}`);
  console.log(`Errors                    : ${summary.errors}`);
  console.log(`Dry run                   : ${summary.dryRun ? "Yes" : "No"}`);
  console.log(`Elapsed                   : ${(durationMs / 1000).toFixed(2)}s\n`);

  if (summary.examplesFixed.length > 0) {
    console.log("✅ Sample fixes:");
    summary.examplesFixed.forEach((item) => {
      console.log(
        `   • Order #${item.orderId}: ${item.from || "?"} → ${item.to || "?"} (delivery ${item.deliveryDate})`
      );
    });
    console.log("");
  }

  if (summary.examplesMissingSlot.length > 0) {
    console.log("⚠️  Orders missing slot references:");
    summary.examplesMissingSlot.forEach((item) => {
      console.log(
        `   • Order #${item.orderId}: slot ${item.bookingSlot}, delivery ${item.deliveryDate}`
      );
    });
    console.log("");
  }

  if (summary.examplesNoTargetSlot.length > 0) {
    console.log("⚠️  Orders without matching slot for delivery date:");
    summary.examplesNoTargetSlot.forEach((item) => {
      console.log(
        `   • Order #${item.orderId}: delivery ${item.deliveryDate}, current slot ${item.currentSlot}`
      );
    });
    console.log("");
  }
};

const run = async () => {
  try {
    await processOrders();
  } catch (error) {
    summary.errors += 1;
    console.error("❌ Script failed:", error);
  } finally {
    printSummary();
    if (summary.errors > 0) {
      process.exitCode = 1;
    }
  }
};

run();


