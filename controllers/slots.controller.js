import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import mongoose from "mongoose";
import moment from "moment"; // Optional: Use moment.js or other libraries for date validation/formatting
import SlotTransferLog from "../models/slotTransfer.model.js";
import { calculateEffectiveBuffer, calculateBufferAdjustedCapacity, releaseBufferPlants, addPlantsToCapacity, addPlantsToAvailable, resolveSlotBufferFields, computeLegacyAvailableFromCapacity, isAvailablePlantsMaterialized, deriveSlotCapacity } from "../utility/bufferUtils.js";
import { updateSlotBufferCalculations, updateAllSlotBuffers } from "../utility/slotBufferUpdater.js";
import {
  applyStockFieldUpdates,
  logStockFieldChange,
  STOCK_TRAIL_ACTION_LIST,
} from "../utility/slotStockTrail.js";
import {
  getSlotTrailActivityName,
  SLOT_TRAIL_ACTIONS,
  TRANSFER_TRAIL_ACTION_LIST,
  ROLL_TRAIL_ACTION_LIST,
} from "../constants/slotTrailActions.js";
import {
  appendTransferSlotTrail,
  buildSlotSnapshot,
} from "../utility/slotTransferTrail.js";
import { executeMassOrderSlotTransfer } from "../services/slotOrderTransfer.service.js";
import {
  aggregateShedStockBySlotIds,
  computeActualAvailable,
  getSlotSecondaryShedBreakdown,
  transferSlotExpectedMortalityToReady,
} from "../services/secondaryShedSlotStock.service.js";
import { slotWindowToDeliveryUtcRange } from "../utility/findDeliverySlot.js";
import {
  addRolledDispatchedToStats,
  addRolledRemainingToStats,
  aggregateSlotDispatchStats,
  computeSlotDispatchStatsFromOrders,
  finalizeDispatchedBifurcation,
  getNativeDeliveryCohortOrders,
  getSlotDispatchStats,
  groupOrdersByDeliverySlot,
  sumDispatchedCrossSlotOntoSlot,
} from "../utility/slotDispatchStats.js";
import { fetchSlotAvailabilityReport } from "../services/availabilityOverview.service.js";
import { getLagwadAnalysis } from "../services/lagwadAnalysis.service.js";
import {
  runPastDueSlotRollover,
} from "../services/pastDueSlotRollover.service.js";
import {
  listRollExpiredAvailableSources,
  runRollExpiredSlotAvailable,
  listReadyRollLogForSlot,
  summarizeReadyRollForSlot,
} from "../services/rollExpiredSlotAvailable.service.js";
import { getSlotOrderDispatchByBatch } from "../services/slotOrderDispatchByBatch.service.js";
import {
  aggregatePastDueMetricsForSlotGroup,
  buildCrossSlotDetailBySlot,
  buildSlotOrderMetrics,
  sumEarlyDispatchOntoSlot,
} from "../utility/pastDueSlotMetrics.js";

// Helper function to convert month name to number
const getMonthNumber = (monthName) => {
  const months = {
    'January': '01', 'February': '02', 'March': '03', 'April': '04',
    'May': '05', 'June': '06', 'July': '07', 'August': '08',
    'September': '09', 'October': '10', 'November': '11', 'December': '12'
  };
  return months[monthName] || '01';
};

// Helper function to get days in month
const getDaysInMonth = (monthName, year) => {
  const monthNumber = getMonthNumber(monthName);
  return moment(`${year}-${monthNumber}`, 'YYYY-MM').daysInMonth();
};

const findSlotDetails = async (slotId) => {
  if (!mongoose.Types.ObjectId.isValid(slotId)) {
    return null;
  }

  const slotObjectId = new mongoose.Types.ObjectId(slotId);
  const plantSlotDoc = await PlantSlot.findOne({
    "subtypeSlots.slots._id": slotObjectId,
  }).lean();

  if (!plantSlotDoc) {
    return null;
  }

  let matchedSubtype = null;
  let matchedSlot = null;

  for (const subtype of plantSlotDoc.subtypeSlots || []) {
    const slot = (subtype.slots || []).find(
      (item) => item._id?.toString() === slotObjectId.toString()
    );
    if (slot) {
      matchedSubtype = subtype;
      matchedSlot = slot;
      break;
    }
  }

  if (!matchedSlot) {
    return null;
  }

  return {
    plantSlotId: plantSlotDoc._id,
    plantId: plantSlotDoc.plantId,
    plantSlotYear: plantSlotDoc.year,
    subtypeId: matchedSubtype.subtypeId,
    slot: matchedSlot,
  };
};

const safeArray = (value) => (Array.isArray(value) ? value : []);

/**
 * Stored `availablePlants` on a slot is often missing in older data. `Number(undefined)` is NaN
 * and `??` does not fall back for NaN, which breaks transfer UIs (max qty 0, confirm disabled).
 */
const getSlotEffectiveAvailablePlants = (slot) => {
  const resolved = resolveSlotBufferFields(slot);
  return resolved.availablePlants;
};

const getSlotBookedPlantCount = async (slotId) => {
  const details = await findSlotDetails(slotId);
  const range = details?.slot ? slotWindowToDeliveryUtcRange(details.slot) : null;
  const match = {
    orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
    $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
  };
  if (range) {
    match.deliveryDate = { $gte: range.start, $lte: range.end };
  } else {
    match.bookingSlot = new mongoose.Types.ObjectId(slotId);
  }
  if (details?.plantId) match.plantName = details.plantId;
  if (details?.subtypeId) match.plantSubtype = details.subtypeId;

  const orders = await Order.find(match)
    .select(
      "numberOfPlants additionalPlants orderStatus pastDueSlotRollover pastDueSlotRolloverAt deliveryDate quotaSource"
    )
    .lean();
  return computeSlotDispatchStatsFromOrders(orders).totalBookedPlants;
};

export const createSlotsForYear = async (year) => {
  try {
    // Fetch all plants from PlantCms
    const plants = await PlantCms.find();

    for (const plant of plants) {
      const subtypeSlots = plant.subtypes.map((subtype) => ({
        subtypeId: subtype._id,
        slots: generateSlotsForYear(year),
      }));

      // Save slots for this plant and year
      const plantSlot = new PlantSlot({
        plantId: plant._id,
        year,
        subtypeSlots,
      });

      await plantSlot.save();
    }

    // console.log(
    //   `Slots created successfully for the year ${year} for all plants and subtypes.`
    // );
  } catch (error) {
    console.error("Error creating slots:", error);
  }
};

// Test function to verify slot generation logic
export const testSlotGeneration = () => {
  console.log("=== Testing slot generation with slotSize = 7 ===");
  
  // Test January (31 days) with 7-day slots
  const testSlots = generateSlotsForYear(2025, 7);
  const januarySlots = testSlots.filter(slot => slot.month === "January");
  
  console.log(`\nJanuary slots (31 days total):`);
  januarySlots.forEach((slot, index) => {
    const start = moment(slot.startDay, "DD-MM-YYYY").date();
    const end = moment(slot.endDay, "DD-MM-YYYY").date();
    const days = moment(slot.endDay, "DD-MM-YYYY").diff(moment(slot.startDay, "DD-MM-YYYY"), 'days') + 1;
    console.log(`  Slot ${index + 1}: Day ${start} to ${end} (${days} days) - ${slot.startDay} to ${slot.endDay}`);
  });
  
  // Test February (28 days in 2025) with 7-day slots
  const februarySlots = testSlots.filter(slot => slot.month === "February");
  
  console.log(`\nFebruary slots (28 days total):`);
  februarySlots.forEach((slot, index) => {
    const start = moment(slot.startDay, "DD-MM-YYYY").date();
    const end = moment(slot.endDay, "DD-MM-YYYY").date();
    const days = moment(slot.endDay, "DD-MM-YYYY").diff(moment(slot.startDay, "DD-MM-YYYY"), 'days') + 1;
    console.log(`  Slot ${index + 1}: Day ${start} to ${end} (${days} days) - ${slot.startDay} to ${slot.endDay}`);
  });

  // Test March (31 days) with 7-day slots
  const marchSlots = testSlots.filter(slot => slot.month === "March");
  
  console.log(`\nMarch slots (31 days total):`);
  marchSlots.forEach((slot, index) => {
    const start = moment(slot.startDay, "DD-MM-YYYY").date();
    const end = moment(slot.endDay, "DD-MM-YYYY").date();
    const days = moment(slot.endDay, "DD-MM-YYYY").diff(moment(slot.startDay, "DD-MM-YYYY"), 'days') + 1;
    console.log(`  Slot ${index + 1}: Day ${start} to ${end} (${days} days) - ${slot.startDay} to ${slot.endDay}`);
  });
  
  console.log("=== Test completed ===");
  return testSlots;
};

export const generateSlotsForYear = (year, slotSize = 5) => {
  const slots = [];
  const daysInMonths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  // Adjust for leap year
  if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) {
    daysInMonths[1] = 29; // February has 29 days
  }

  // Generate slots for each month
  daysInMonths.forEach((daysInMonth, monthIndex) => {
    const monthName = monthNames[monthIndex];
    let startDay = 1;
    const monthSlots = [];

    // Generate slots for this month
    while (startDay <= daysInMonth) {
      let endDay = Math.min(startDay + slotSize - 1, daysInMonth);
      
      // Check if this would be the last iteration and if remaining days are small
      const remainingDaysAfterThisSlot = daysInMonth - endDay;
      
      // If remaining days are less than slotSize, extend current slot to end of month
      if (remainingDaysAfterThisSlot > 0 && remainingDaysAfterThisSlot < slotSize) {
        endDay = daysInMonth;
      }

      const startDate = moment(
        `${year}-${monthIndex + 1}-${startDay}`,
        "YYYY-M-D"
      ).format("DD-MM-YYYY");
      const endDate = moment(
        `${year}-${monthIndex + 1}-${endDay}`,
        "YYYY-M-D"
      ).format("DD-MM-YYYY");

      slots.push({
        startDay: startDate,
        endDay: endDate,
        month: monthName,
        totalPlants: 0,
        totalBookedPlants: 0,
        buffer: 0, // Buffer percentage at slot level
        orders: [],
        allowedSalesmen: [], // Array to store salesman IDs who can access this slot
        restrictToSalesmen: false, // Flag to enable/disable salesman restrictions
        overflow: false,
        status: true,
        plantReadyDays: 0,
      });

      // Move to next slot (this will exit if we extended to end of month)
      startDay = endDay + 1;
    }
  });

  return slots;
};

export const getAllSlots = async (req, res) => {
  try {
    const { plantId, subtypeId, year, page = 1, limit = 10 } = req.query;

    const pageNumber = Number(page);
    const pageSize = Number(limit);

    // Build query dynamically
    const query = {};
    if (plantId) query.plantId = plantId;
    if (year) query.year = Number(year);
    if (subtypeId) query["subtypeSlots.subtypeId"] = subtypeId;

    // Fetch slots with optimized query
    const slots = await PlantSlot.find(query)
      .populate({
        path: "plantId",
        select: "name", // Populate only the plant name
      })
      .select("year plantId subtypeSlots") // Fetch only necessary fields
      .lean() // Use lean queries for faster performance
      .skip((pageNumber - 1) * pageSize) // Pagination
      .limit(pageSize);

    if (!slots.length) {
      return res.status(404).json({ message: "No slots found." });
    }

    res.status(200).json(slots);
  } catch (error) {
    console.error("Error fetching slots:", error);
    res.status(500).json({ message: "Internal server error.", error });
  }
};

export const getPlantNames = async (req, res) => {
  try {
    const { year } = req.query;
    
    // First, get all plants from PlantCms
    const allPlants = await PlantCms.find({}).select('_id name subtypes sowingAllowed');
    
    if (allPlants.length === 0) {
      return res.status(404).json({ message: "No plants found in database." });
    }

    // If year is specified, get slot data for that year
    if (year) {
    const plantDetails = await PlantSlot.aggregate([
        {
          $match: { year: parseInt(year) }
        },
      {
        $lookup: {
          from: "plantcms", // Join with the PlantCms collection
          localField: "plantId",
          foreignField: "_id",
          as: "plantDetails",
        },
      },
      {
        $unwind: "$plantDetails", // Unwind to access plant details
      },
      {
        $unwind: "$subtypeSlots", // Unwind subtypeSlots array
      },
      {
        $unwind: "$subtypeSlots.slots", // Unwind slots array within subtypeSlots
      },
      {
        $group: {
          _id: "$plantId", // Group by plantId
          plantName: { $first: "$plantDetails.name" }, // Fetch plant name
          totalPlants: { $sum: "$subtypeSlots.slots.totalPlants" }, // Sum totalPlants for all slots
          totalBookedPlants: { $sum: "$subtypeSlots.slots.totalBookedPlants" }, // Sum totalBookedPlants for all slots
        },
      },
      {
        $project: {
          _id: 0,
          plantId: "$_id", // Include plantId in the response
          name: "$plantName", // Include plant name
          totalPlants: 1, // Include totalPlants
          totalBookedPlants: 1, // Include totalBookedPlants
        },
      },
      {
        $sort: { name: 1 }, // Sort by plant name in ascending order (alphabetical)
      },
    ]);

      // Create a map of plants with slots
      const plantsWithSlots = new Map(plantDetails.map(p => [p.plantId.toString(), p]));
      
      // Return all plants, with slot data if available
      const result = allPlants.map(plant => {
        const plantWithSlots = plantsWithSlots.get(plant._id.toString());
        return {
          plantId: plant._id,
          name: plant.name,
          totalPlants: plantWithSlots ? plantWithSlots.totalPlants : 0,
          totalBookedPlants: plantWithSlots ? plantWithSlots.totalBookedPlants : 0,
          hasSlots: !!plantWithSlots,
          sowingAllowed: plant.sowingAllowed || false,
          subtypes: (plant.subtypes || []).map((s) => ({
            _id: s._id,
            name: s.name,
            rates: s.rates,
            monthlyRates: s.monthlyRates,
            raisingRate: Number(s.raisingRate) || 0,
          })),
        };
      });

      res.status(200).json(result);
    } else {
      // If no year specified, return all plants with zero slot data
      const result = allPlants.map(plant => ({
        plantId: plant._id,
        name: plant.name,
        totalPlants: 0,
        totalBookedPlants: 0,
        hasSlots: false,
        sowingAllowed: plant.sowingAllowed || false,
        subtypes: (plant.subtypes || []).map((s) => ({
          _id: s._id,
          name: s.name,
          rates: s.rates,
          monthlyRates: s.monthlyRates,
          raisingRate: Number(s.raisingRate) || 0,
        })),
      }));

      res.status(200).json(result);
    }
  } catch (error) {
    console.error("Error fetching plant details with summary:", error);
    res.status(500).json({ message: "Internal server error.", error });
  }
};

export const getSubtypesByPlant = async (req, res) => {
  try {
    const { plantId, year } = req.query;

    // Validate inputs
    if (!plantId) {
      return res.status(400).json({ message: "Plant ID is required." });
    }

    if (!year) {
      return res.status(400).json({ message: "Year is required." });
    }

    // Convert plantId to ObjectId
    const plantObjectId = new mongoose.Types.ObjectId(plantId);

    // Fetch stats from PlantSlot
    const stats = await PlantSlot.aggregate([
      {
        $match: {
          plantId: plantObjectId, // Match the provided plantId as ObjectId
          year: parseInt(year), // Match the provided year
        },
      },
      {
        $unwind: "$subtypeSlots", // Deconstruct the array of subtypeSlots
      },
      {
        $unwind: "$subtypeSlots.slots", // Deconstruct the array of slots within each subtype
      },
      {
        $group: {
          _id: "$subtypeSlots.subtypeId", // Group by subtypeId
          totalPlants: { $sum: "$subtypeSlots.slots.totalPlants" }, // Sum totalPlants across all slots for this subtype
          totalBookedPlants: { $sum: "$subtypeSlots.slots.totalBookedPlants" }, // Sum totalBookedPlants across all slots for this subtype
          totalActualPlants: { $sum: "$subtypeSlots.slots.actualPlants" },
          totalExpectedMortality: { $sum: "$subtypeSlots.slots.expectedMortality" },
          totalActualReadyPlants: { $sum: "$subtypeSlots.slots.actualReadyPlants" },
          totalLagwadRemaining: { $sum: "$subtypeSlots.slots.lagwadRemaining" },
        },
      },
      {
        $lookup: {
          from: "plantcms", // Lookup the PlantCms collection
          localField: "_id", // Match _id (subtypeId) with PlantCms.subtypes._id
          foreignField: "subtypes._id", // Reference subtypes array in PlantCms
          as: "subtypeDetails", // Output the matched subtype details
        },
      },
      {
        $unwind: "$subtypeDetails", // Deconstruct subtypeDetails array
      },
      {
        $addFields: {
          subtypeData: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$subtypeDetails.subtypes",
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$_id"] }, // Match subtype ID
                },
              },
              0,
            ],
          },
        },
      },
      {
        $project: {
          _id: 0, // Exclude MongoDB default _id
          subtypeId: "$_id", // Include subtypeId
          subtypeName: "$subtypeData.name", // Extract and include the correct name
          rate: "$subtypeData.rates", // Include the rates array for the subtype
          monthlyRates: "$subtypeData.monthlyRates", // Per-month rate overrides
          raisingRate: "$subtypeData.raisingRate", // Rate when farmer gives seed
          totalPlants: 1, // Include the sum of totalPlants
          totalBookedPlants: 1, // Include the sum of totalBookedPlants
          totalActualPlants: 1,
          totalExpectedMortality: 1,
          totalActualReadyPlants: 1,
          totalLagwadRemaining: 1,
        },
      },
      {
        $sort: { subtypeName: 1 }, // Sort by subtype name for consistent ordering
      },
    ]);

    if (stats.length === 0) {
      const plant = await PlantCms.findById(plantObjectId)
        .select("subtypes")
        .lean();
      if (!plant) {
        return res.status(404).json({ message: "Plant not found." });
      }
      const cmsSubtypes = plant.subtypes || [];
      if (cmsSubtypes.length === 0) {
        return res.status(404).json({
          message:
            "No slots for this year and no subtypes are configured for this plant.",
        });
      }
      stats.push(
        ...cmsSubtypes
          .map((s) => ({
            subtypeId: s._id,
            subtypeName: s.name,
            rate: s.rates,
            monthlyRates: s.monthlyRates || [],
            raisingRate: s.raisingRate || 0,
            totalPlants: 0,
            totalBookedPlants: 0,
            totalActualPlants: 0,
            totalExpectedMortality: 0,
            totalActualReadyPlants: 0,
            totalLagwadRemaining: 0,
          }))
          .sort((a, b) =>
            String(a.subtypeName).localeCompare(String(b.subtypeName))
          )
      );
    }

    const plantCms = await PlantCms.findById(plantObjectId).select("subtypes").lean();
    const cmsById = new Map(
      (plantCms?.subtypes || []).map((s) => [String(s._id), s])
    );
    for (const st of stats) {
      const cms = cmsById.get(String(st.subtypeId));
      if (!cms) continue;
      st.raisingRate = Number(cms.raisingRate) || 0;
      if (!st.monthlyRates?.length && cms.monthlyRates?.length) {
        st.monthlyRates = cms.monthlyRates;
      }
      if ((st.rate == null || (Array.isArray(st.rate) && !st.rate.length)) && cms.rates?.length) {
        st.rate = cms.rates;
      }
    }

    // Calculate the overall totals for all subtypes
    const overallTotals = stats.reduce(
      (totals, subtype) => {
        totals.totalPlants += subtype.totalPlants;
        totals.totalBookedPlants += subtype.totalBookedPlants;
        totals.totalActualPlants += subtype.totalActualPlants || 0;
        totals.totalExpectedMortality += subtype.totalExpectedMortality || 0;
        totals.totalActualReadyPlants += subtype.totalActualReadyPlants || 0;
        totals.totalLagwadRemaining += subtype.totalLagwadRemaining || 0;
        return totals;
      },
      {
        totalPlants: 0,
        totalBookedPlants: 0,
        totalActualPlants: 0,
        totalExpectedMortality: 0,
        totalActualReadyPlants: 0,
        totalLagwadRemaining: 0,
      }
    );

    // Response with subtypes and overall totals
    res.status(200).json({
      plantId,
      year,
      subtypes: stats,
      overallTotals, // Includes totalPlants and totalBookedPlants across all subtypes
    });
  } catch (error) {
    console.error("Error fetching stats by plant type:", error);
    res.status(500).json({ message: "Internal server error.", error });
  }
};

export const getSlotsByPlantAndSubtype = async (req, res) => {
  try {
    const {
      plantId,
      subtypeId,
      year,
      status,
      page = 1,
      limit = 10,
    } = req.query;

    // Validate and convert inputs
    const query = {};
    if (plantId) query.plantId = new mongoose.Types.ObjectId(plantId);
    if (year) query.year = Number(year);

    const pageNumber = Number(page);
    const pageSize = Number(limit);

    // Subtype and slot status filters
    const slotStatusFilter =
      status !== undefined ? { "slots.status": status === "true" } : {};

    const results = await PlantSlot.aggregate([
      { $match: query }, // Match plantId and year
      {
        $project: {
          _id: 0,
          plantId: 1,
          year: 1,
          subtypeSlots: {
            $filter: {
              input: "$subtypeSlots",
              as: "subtypeSlot",
              cond: {
                $and: [
                  subtypeId
                    ? {
                        $eq: [
                          "$$subtypeSlot.subtypeId",
                          new mongoose.Types.ObjectId(subtypeId),
                        ],
                      }
                    : {},
                  { $ne: ["$$subtypeSlot", null] },
                ],
              },
            },
          },
        },
      },
      { $unwind: "$subtypeSlots" }, // Flatten filtered subtypeSlots
      {
        $project: {
          plantId: 1,
          year: 1,
          subtypeId: "$subtypeSlots.subtypeId",
          slots: {
            $filter: {
              input: "$subtypeSlots.slots",
              as: "slot",
              cond: {
                $and: [
                  slotStatusFilter["slots.status"]
                    ? {
                        $eq: [
                          "$$slot.status",
                          slotStatusFilter["slots.status"],
                        ],
                      }
                    : {},
                  { $ne: ["$$slot", null] },
                ],
              },
            },
          },
        },
      },
      { $unwind: "$slots" }, // Flatten slots array
      {
        $facet: {
          // Month-wise summary
          monthSummary: [
            {
              $group: {
                _id: "$slots.month",
                totalPlants: { $sum: "$slots.totalPlants" },
                totalBookedPlants: { $sum: "$slots.totalBookedPlants" },
              },
            },
            {
              $project: {
                _id: 0,
                month: "$_id",
                totalPlants: 1,
                totalBookedPlants: 1,
              },
            },
            { $sort: { month: 1 } }, // Sort by month
          ],
          // Paginated slots
          paginatedSlots: [
            {
              $group: {
                _id: {
                  plantId: "$plantId",
                  year: "$year",
                  subtypeId: "$subtypeId",
                },
                slots: { $push: "$slots" }, // Collect slots into an array
              },
            },
            { $skip: (pageNumber - 1) * pageSize }, // Apply pagination
            { $limit: pageSize }, // Limit results
          ],
        },
      },
    ]);

    const { monthSummary, paginatedSlots } = results[0];

    // Fetch plant and subtype information for buffer calculations
    let plantBuffer = 0;
    let subtypeBuffer = 0;
    
    if (plantId) {
      const plant = await PlantCms.findById(plantId);
      if (plant) {
        plantBuffer = plant.buffer || 0;
        
        // Find subtype buffer if subtypeId is provided
        if (subtypeId) {
          const subtype = plant.subtypes.find(sub => sub._id.toString() === subtypeId);
          if (subtype) {
            subtypeBuffer = subtype.buffer || 0;
          }
        }
      }
    }

    // Define months for the summary
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    // Build the month-wise summary with default values
    const monthwiseSummary = months.map((month) => ({
      month,
      totalPlants: 0,
      totalBookedPlants: 0,
    }));

    // Populate the month-wise summary from aggregation results
    monthSummary.forEach((item) => {
      const monthIndex = months.indexOf(item.month);
      if (monthIndex >= 0) {
        monthwiseSummary[monthIndex] = {
          month: item.month,
          totalPlants: item.totalPlants,
          totalBookedPlants: item.totalBookedPlants,
        };
      }
    });

    // Format paginatedSlots — buffer/available resolved after orders are loaded
    const slots = paginatedSlots.map((slot) => ({
      plantId: slot._id.plantId,
      year: slot._id.year,
      subtypeId: slot._id.subtypeId,
      slots: slot.slots.map((slotItem) => ({
        ...slotItem,
        originalTotalPlants: slotItem.totalPlants,
      })),
    }));

    // Populate slots with orders and recalculate totalBookedPlants
    const slotsWithOrders = await populateSlotsWithOrders(slots, {
      subtypeBuffer,
      plantBuffer,
    });

    // Recalculate month-wise summary with actual orders data
    for (const slotGroup of slotsWithOrders) {
      for (const slot of slotGroup.slots) {
        const monthIndex = months.indexOf(slot.month);
        if (monthIndex >= 0) {
          monthwiseSummary[monthIndex].totalPlants += slot.totalPlants;
          monthwiseSummary[monthIndex].totalBookedPlants += slot.totalBookedPlants;
        }
      }
    }

    // Return the filtered slots and the month-wise summary (even if empty)
    res.status(200).json({ 
      monthwiseSummary, 
      slots: slotsWithOrders,
      message: slotsWithOrders.length === 0 ? "No slots found for the given plant, subtype, and year." : null
    });
  } catch (error) {
    console.error("Error fetching slots:", error.message);
    res
      .status(500)
      .json({ message: "Internal server error.", error: error.message });
  }
};

export const updateSlotFieldById = async (req, res) => {
  try {
    const { slotId } = req.params; // Slot ID from request params
    const updates = req.body; // Key-value pair for the field to update, e.g., { totalPlants: 50 }
    const performedBy = req.user?._id; // Get user ID from request

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No update data provided." });
    }

    // Find the document containing the slot
    const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
    
    if (!plantSlot) {
      return res.status(404).json({ message: "Slot not found." });
    }

    // Find the specific slot and subtype
    let targetSlot = null;
    let targetSubtype = null;
    
    for (const subtype of plantSlot.subtypeSlots) {
      const slot = subtype.slots.find(s => s._id.toString() === slotId);
      if (slot) {
        targetSlot = slot;
        targetSubtype = subtype;
        break;
      }
    }

    if (!targetSlot) {
      return res.status(404).json({ message: "Slot not found." });
    }

    // Store original values for trail tracking
    const originalValues = {
      totalPlants: targetSlot.totalPlants,
      availablePlants: targetSlot.availablePlants,
      buffer: targetSlot.buffer,
      effectiveBuffer: targetSlot.effectiveBuffer
    };

    // Set performer for trail tracking
    if (performedBy) {
      targetSlot.setPerformer(performedBy);
    }

    const allowedSlotFields = new Set([
      "totalPlants",
      "availablePlants",
      "buffer",
      "effectiveBuffer",
      "status",
      "actualPlants",
      "closingStock",
      "plantsSowed",
      "officeSowed",
      "primarySowed",
    ]);

    const stockPayload = {};
    if (updates.actualPlants !== undefined) {
      stockPayload.actualPlants = updates.actualPlants;
    }
    if (updates.closingStock !== undefined) {
      stockPayload.closingStock = updates.closingStock;
    }
    if (updates.availablePlants !== undefined) {
      stockPayload.availablePlants = updates.availablePlants;
    }
    if (Object.keys(stockPayload).length > 0) {
      applyStockFieldUpdates(
        targetSlot,
        stockPayload,
        performedBy,
        "Slot update"
      );
    }

    // Update the slot fields (whitelist so new schema fields work on older documents)
    Object.keys(updates).forEach((key) => {
      if (
        allowedSlotFields.has(key) &&
        key !== "actualPlants" &&
        key !== "closingStock" &&
        key !== "availablePlants"
      ) {
        targetSlot[key] = updates[key];
      }
    });

    // Save the document to trigger middleware
    await plantSlot.save();

    const touchesCapacityOrBuffer =
      updates.totalPlants !== undefined ||
      updates.buffer !== undefined ||
      updates.effectiveBuffer !== undefined;

    let bufferUpdateResult = { success: true, skipped: true };
    if (touchesCapacityOrBuffer) {
      const bookedPlants = await getSlotBookedPlantCount(slotId);
      bufferUpdateResult = await updateSlotBufferCalculations(
        slotId,
        targetSlot.totalPlants,
        bookedPlants,
        targetSlot.buffer
      );
      if (!bufferUpdateResult.success) {
        console.error("Warning: Buffer calculations update failed:", bufferUpdateResult.error);
      }
    }

    res.status(200).json({
      message: "Slot updated successfully.",
      data: {
        ...plantSlot.toObject(),
        bufferCalculations: bufferUpdateResult
      },
    });
  } catch (error) {
    console.error("Error updating slot:", error);
    res
      .status(500)
      .json({ message: "Internal server error.", error: error.message });
  }
};

// Function to update slot buffer value specifically
export const updateSlotBuffer = async (req, res) => {
  try {
    const { slotId } = req.params;
    const { buffer } = req.body;
    const performedBy = req.user?._id; // Get user ID from request

    // Validate buffer value
    if (buffer === undefined || buffer === null) {
      return res.status(400).json({ 
        success: false,
        message: "Buffer value is required." 
      });
    }

    // Validate buffer is a number and within valid range (0-100)
    const bufferValue = Number(buffer);
    if (isNaN(bufferValue)) {
      return res.status(400).json({ 
        success: false,
        message: "Buffer must be a valid number." 
      });
    }

    if (bufferValue < 0 || bufferValue > 100) {
      return res.status(400).json({ 
        success: false,
        message: "Buffer must be between 0 and 100 percent." 
      });
    }

    // Find the document containing the slot
    const plantSlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotId });
    
    if (!plantSlot) {
      return res.status(404).json({ 
        success: false,
        message: "Slot not found." 
      });
    }

    // Find the specific slot
    let targetSlot = null;
    
    for (const subtype of plantSlot.subtypeSlots) {
      const slot = subtype.slots.find(s => s._id.toString() === slotId);
      if (slot) {
        targetSlot = slot;
        break;
      }
    }

    if (!targetSlot) {
      return res.status(404).json({ 
        success: false,
        message: "Slot not found." 
      });
    }

    // Set performer for trail tracking
    if (performedBy) {
      targetSlot.setPerformer(performedBy);
    }

    // Update the buffer field
    targetSlot.buffer = bufferValue;

    // Save the document to trigger middleware
    await plantSlot.save();

    // Update buffer calculations in the database (use live booked count from orders)
    const bookedPlants = await getSlotBookedPlantCount(slotId);
    const bufferUpdateResult = await updateSlotBufferCalculations(
      slotId,
      targetSlot.totalPlants,
      bookedPlants,
      bufferValue
    );

    if (!bufferUpdateResult.success) {
      console.error("Warning: Buffer calculations update failed:", bufferUpdateResult.error);
    }

    res.status(200).json({
      success: true,
      message: "Slot buffer updated successfully.",
      data: {
        slotId,
        buffer: bufferValue,
        slot: targetSlot,
        bufferCalculations: bufferUpdateResult
      }
    });

  } catch (error) {
    console.error("Error updating slot buffer:", error);
    res.status(500).json({ 
      success: false,
      message: "Internal server error.", 
      error: error.message 
    });
  }
};
// Controller function to get plant statistics
// Controller function to get plant statistics summary
export const getPlantStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Validate date format (dd-mm-yyyy)
    const dateFormatRegex = /^\d{2}-\d{2}-\d{4}$/;
    if (!dateFormatRegex.test(startDate) || !dateFormatRegex.test(endDate)) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Use dd-mm-yyyy",
      });
    }

    // Debug log to check the first few documents
    const sampleDocs = await PlantSlot.find().limit(1).lean();
    // console.log(
    //   "Sample PlantSlot document:",
    //   JSON.stringify(sampleDocs, null, 2)
    // );

    const stats = await PlantSlot.aggregate([
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $match: {
          "subtypeSlots.slots.startDay": { $gte: startDate },
          "subtypeSlots.slots.endDay": { $lte: endDate },
        },
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plant",
        },
      },
      {
        $lookup: {
          from: "plantsubtypeschemas", // Correct collection name based on schema name
          localField: "subtypeSlots.subtypeId",
          foreignField: "_id",
          as: "subtype",
        },
      },
      {
        $addFields: {
          subtypeName: {
            $ifNull: [
              { $first: { $arrayElemAt: ["$subtype.name", 0] } },
              "Unknown Subtype",
            ],
          },
        },
      },
      {
        $group: {
          _id: {
            plantId: "$plantId",
            subtypeId: "$subtypeSlots.subtypeId",
            month: "$subtypeSlots.slots.month",
          },
          plantName: { $first: { $arrayElemAt: ["$plant.name", 0] } },
          subtypeName: { $first: "$subtypeName" },
          totalPlants: { $sum: "$subtypeSlots.slots.totalPlants" },
          totalBookedPlants: { $sum: "$subtypeSlots.slots.totalBookedPlants" },
        },
      },
      {
        $group: {
          _id: {
            plantId: "$_id.plantId",
            month: "$_id.month",
          },
          plantName: { $first: "$plantName" },
          subtypes: {
            $push: {
              name: "$subtypeName",
              totalPlants: "$totalPlants",
              totalBookedPlants: "$totalBookedPlants",
              allPlants: { $add: ["$totalPlants", "$totalBookedPlants"] },
            },
          },
          monthlyTotalPlants: { $sum: "$totalPlants" },
          monthlyTotalBookedPlants: { $sum: "$totalBookedPlants" },
        },
      },
      {
        $group: {
          _id: "$_id.plantId",
          plantName: { $first: "$plantName" },
          monthlyData: {
            $push: {
              month: "$_id.month",
              subtypes: "$subtypes",
              totalPlants: "$monthlyTotalPlants",
              totalBookedPlants: "$monthlyTotalBookedPlants",
              allPlants: {
                $add: ["$monthlyTotalPlants", "$monthlyTotalBookedPlants"],
              },
            },
          },
          totalPlants: { $sum: "$monthlyTotalPlants" },
          totalBookedPlants: { $sum: "$monthlyTotalBookedPlants" },
        },
      },
      {
        $project: {
          _id: 1,
          plantName: 1,
          monthlyData: 1,
          totalPlants: 1,
          totalBookedPlants: 1,
          allPlants: { $add: ["$totalPlants", "$totalBookedPlants"] },
        },
      },
      {
        $sort: {
          plantName: 1,
        },
      },
    ]);

    // Calculate grand totals
    const grandTotals = stats.reduce(
      (acc, plant) => {
        return {
          totalPlants: acc.totalPlants + plant.totalPlants,
          totalBookedPlants: acc.totalBookedPlants + plant.totalBookedPlants,
          allPlants: acc.allPlants + plant.allPlants,
        };
      },
      { totalPlants: 0, totalBookedPlants: 0, allPlants: 0 }
    );

    // Get unique months across all data for X-axis
    const allMonths = [
      ...new Set(
        stats.flatMap((plant) => plant.monthlyData.map((data) => data.month))
      ),
    ].sort((a, b) => {
      const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      return months.indexOf(a) - months.indexOf(b);
    });

    // Format data for charts
    const chartData = {
      lineChart: allMonths.map((month) => {
        const monthData = {
          month,
          totalPlants: 0,
          totalBookedPlants: 0,
          allPlants: 0,
        };

        stats.forEach((plant) => {
          const monthlyData = plant.monthlyData.find(
            (data) => data.month === month
          );
          if (monthlyData) {
            monthData.totalPlants += monthlyData.totalPlants;
            monthData.totalBookedPlants += monthlyData.totalBookedPlants;
            monthData.allPlants += monthlyData.allPlants;
          }
        });

        return monthData;
      }),
      barChart: stats.map((plant) => ({
        plantName: plant.plantName,
        totalPlants: plant.totalPlants,
        totalBookedPlants: plant.totalBookedPlants,
        allPlants: plant.allPlants,
      })),
    };

    return res.status(200).json({
      success: true,
      data: {
        summary: stats,
        grandTotals,
        chartData,
      },
    });
  } catch (error) {
    console.error("Error in getPlantStats:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};



// Function to manually add a slot to a plant subtype
export const addManualSlot = async (req, res) => {
  try {
    const {
      plantId,
      subtypeId,
      startDay,
      endDay,
      totalPlants,
      buffer = 0,
      actualPlants: bodyActualPlants,
      closingStock: bodyClosingStock,
    } = req.body;
    const performedBy = req.user?._id;
    
    // Validate required fields
    if (!plantId || !subtypeId || !startDay || !endDay || totalPlants === undefined) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: plantId, subtypeId, startDay, endDay, and totalPlants are required' 
      });
    }
    
    // Validate buffer value if provided
    if (buffer !== undefined && buffer !== null) {
      const bufferValue = Number(buffer);
      if (isNaN(bufferValue)) {
        return res.status(400).json({ 
          success: false, 
          message: 'Buffer must be a valid number' 
        });
      }
      
      if (bufferValue < 0 || bufferValue > 100) {
        return res.status(400).json({ 
          success: false, 
          message: 'Buffer must be between 0 and 100 percent' 
        });
      }
    }
    
    // Validate date format (dd-mm-yyyy)
    const dateRegex = /^\d{2}-\d{2}-\d{4}$/;
    if (!dateRegex.test(startDay) || !dateRegex.test(endDay)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Dates must be in dd-mm-yyyy format' 
      });
    }
    
    // Validate dates are valid using moment
    if (!moment(startDay, "DD-MM-YYYY", true).isValid() || 
        !moment(endDay, "DD-MM-YYYY", true).isValid()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid date values' 
      });
    }
    
    // Ensure end date is after or equal to start date
    const startDate = moment(startDay, "DD-MM-YYYY");
    const endDate = moment(endDay, "DD-MM-YYYY");
    
    if (endDate.isBefore(startDate)) {
      return res.status(400).json({ 
        success: false, 
        message: 'End date must be after start date' 
      });
    }
    
    // Get the month name from the start date
    const month = startDate.format('MMMM');
    
    // Get the year from the date or use current year
    const year = startDate ? moment(startDay, "DD-MM-YYYY").year() : new Date().getFullYear();
    
    // Find the plant slot document
    let plantSlot = await PlantSlot.findOne({ 
      plantId, 
      year 
    });
    
    // If no plant slot exists for this plant and year, create one
    if (!plantSlot) {
      return res.status(404).json({ 
        success: false, 
        message: 'Plant slot not found for the specified plant and year' 
      });
    }
    
    // Find the subtype slot
    const subtypeSlotIndex = plantSlot.subtypeSlots.findIndex(
      slot => slot.subtypeId.toString() === subtypeId
    );
    
    if (subtypeSlotIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: 'Subtype not found for this plant' 
      });
    }
    
    const actualPlants = Math.max(0, Number(bodyActualPlants) || 0);
    const closingStock = Math.max(0, Number(bodyClosingStock) || 0);

    // Create the new slot with manual flag
    const newSlot = {
      startDay,
      endDay,
      totalPlants: totalPlants,
      totalBookedPlants: 0,
      buffer: Number(buffer) || 0, // Use provided buffer or default to 0
      orders: [],
      overflow: false,
      status: true,
      month,
      isManual: true, // Flag to identify manually added slots
      plantReadyDays: 0,
      actualPlants,
      closingStock,
      slotTrail: [],
    };

    if (actualPlants > 0) {
      logStockFieldChange(
        newSlot,
        "actualPlants",
        0,
        actualPlants,
        performedBy,
        "Manual slot create"
      );
    }
    if (closingStock > 0) {
      logStockFieldChange(
        newSlot,
        "closingStock",
        0,
        closingStock,
        performedBy,
        "Manual slot create"
      );
    }
    
    // Add the slot to the subtype slots array
    plantSlot.subtypeSlots[subtypeSlotIndex].slots.push(newSlot);
    
    // Save the updated plant slot
    await plantSlot.save();
    
    return res.status(201).json({
      success: true,
      message: 'Slot added successfully',
      data: newSlot
    });
    
  } catch (error) {
    console.error('Error adding manual slot:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
// Function to delete a manually added slot
// Function to delete a manually added slot
export const deleteManualSlot = async (req, res) => {
  try {
    const { slotId } = req.params;
    
    if (!slotId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: slotId'
      });
    }
    
    // First, find the slot document to check if it's a manual slot
    // We need to use aggregation to find the exact slot within the nested structure
    const result = await PlantSlot.aggregate([
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $match: { "subtypeSlots.slots._id": new mongoose.Types.ObjectId(slotId) } },
      { $project: {
          isManual: "$subtypeSlots.slots.isManual",
          totalBookedPlants: "$subtypeSlots.slots.totalBookedPlants",
          plantId: 1,
          subtypeSlotId: "$subtypeSlots._id",
          slot: "$subtypeSlots.slots"
        }
      }
    ]);
    
    if (!result || result.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Slot not found'
      });
    }
    
    const slotInfo = result[0];
    
    // Check if the slot is manually added
    if (!slotInfo.isManual) {
      return res.status(403).json({
        success: false,
        message: 'Only manually added slots can be deleted'
      });
    }
    
    // Check if the slot has booked plants
    if (slotInfo.totalBookedPlants > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete a slot that has booked plants'
      });
    }
    
    // Delete the slot
    const updated = await PlantSlot.updateOne(
      { "_id": slotInfo._id },
      { $pull: { "subtypeSlots.$[subtype].slots": { "_id": new mongoose.Types.ObjectId(slotId) } } },
      { arrayFilters: [{ "subtype._id": slotInfo.subtypeSlotId }] }
    );
    
    if (updated.modifiedCount === 0) {
      return res.status(500).json({
        success: false,
        message: 'Failed to delete the slot'
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Slot deleted successfully'
    });
    
  } catch (error) {
    console.error("Error deleting manual slot:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};
// Function to update slot salesmen restrictions
export const updateSlotSalesmenRestrictions = async (req, res) => {
  try {
    const { slotId } = req.params;
    const { restrictToSalesmen, allowedSalesmen } = req.body;
    
    if (!slotId) {
      return res.status(400).json({
        success: false,
        message: "Slot ID is required"
      });
    }
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(slotId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid slot ID format"
      });
    }
    
    // Validate allowedSalesmen array if provided
    if (allowedSalesmen && !Array.isArray(allowedSalesmen)) {
      return res.status(400).json({
        success: false,
        message: "allowedSalesmen must be an array"
      });
    }
    
    // Convert slotId to ObjectId
    const slotObjectId = new mongoose.Types.ObjectId(slotId);
    
    const updateData = {};
    if (restrictToSalesmen !== undefined) {
      updateData["subtypeSlots.$[].slots.$[slotElem].restrictToSalesmen"] = restrictToSalesmen;
    }
    if (allowedSalesmen !== undefined) {
      updateData["subtypeSlots.$[].slots.$[slotElem].allowedSalesmen"] = allowedSalesmen;
    }
    
    const result = await PlantSlot.findOneAndUpdate(
      { "subtypeSlots.slots._id": slotObjectId },
      { $set: updateData },
      {
        arrayFilters: [{ "slotElem._id": slotObjectId }],
        new: true,
        runValidators: true,
      }
    );
    
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Slot not found"
      });
    }
    
    return res.status(200).json({
      success: true,
      message: "Slot salesmen restrictions updated successfully",
      data: result
    });
    
  } catch (error) {
    console.error("Error updating slot salesmen restrictions:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Function to create slots for multiple years
export const createSlotsForMultipleYears = async (req, res) => {
  try {
    const { startYear, endYear, plantIds } = req.body;
    
    if (!startYear || !endYear) {
      return res.status(400).json({ 
        success: false, 
        message: 'Start year and end year are required' 
      });
    }
    
    if (startYear > endYear) {
      return res.status(400).json({ 
        success: false, 
        message: 'Start year must be less than or equal to end year' 
      });
    }
    
    const results = [];
    
    // Get plants to create slots for
    const plantsQuery = plantIds && plantIds.length > 0 
      ? { _id: { $in: plantIds } }
      : {};
    
    const plants = await PlantCms.find(plantsQuery);
    
    if (!plants || plants.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No plants found' 
      });
    }
    
    // Create slots for each year
    for (let year = startYear; year <= endYear; year++) {
      for (const plant of plants) {
        try {
          // Check if slots already exist for this plant and year
          const existingSlots = await PlantSlot.findOne({
            plantId: plant._id,
            year: year
          });
          
          if (existingSlots) {
            results.push({
              plantId: plant._id,
              plantName: plant.name,
              year: year,
              status: 'already_exists',
              message: `Slots already exist for ${plant.name} in ${year}`
            });
            continue;
          }
          
          // Create new slots for this plant and year
          const subtypeSlots = plant.subtypes.map((subtype) => ({
            subtypeId: subtype._id,
            slots: generateSlotsForYear(year, plant.slotSize || 7),
          }));
          
          const newPlantSlot = new PlantSlot({
            plantId: plant._id,
            year: year,
            subtypeSlots: subtypeSlots,
          });
          
          await newPlantSlot.save();
          
          results.push({
            plantId: plant._id,
            plantName: plant.name,
            year: year,
            status: 'created',
            slotsCount: subtypeSlots.reduce((total, st) => total + st.slots.length, 0)
          });
          
        } catch (error) {
          results.push({
            plantId: plant._id,
            plantName: plant.name,
            year: year,
            status: 'error',
            error: error.message
          });
        }
      }
    }
    
    return res.status(200).json({
      success: true,
      message: 'Slot creation process completed',
      results: results,
      summary: {
        totalPlants: plants.length,
        yearsProcessed: endYear - startYear + 1,
        created: results.filter(r => r.status === 'created').length,
        alreadyExists: results.filter(r => r.status === 'already_exists').length,
        errors: results.filter(r => r.status === 'error').length
      }
    });
    
  } catch (error) {
    console.error('Error creating slots for multiple years:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Release plants from buffer to available plants
export const releaseBufferPlantsController = async (req, res) => {
  try {
    const { slotId } = req.params;
    const { plantsToRelease } = req.body;

    if (!plantsToRelease || plantsToRelease <= 0) {
      return res.status(400).json({
        success: false,
        message: "Number of plants to release must be greater than 0"
      });
    }

    // Find the slot
    const plantSlot = await PlantSlot.findOne({ 'subtypeSlots.slots._id': slotId }).populate('plantId');
    if (!plantSlot) {
      return res.status(404).json({
        success: false,
        message: "Slot not found"
      });
    }

    // Find the specific slot
    let targetSlot = null;
    let targetSubtypeSlot = null;
    
    for (const subtypeSlot of plantSlot.subtypeSlots) {
      for (const slot of subtypeSlot.slots) {
        if (slot._id.toString() === slotId) {
          targetSlot = slot;
          targetSubtypeSlot = subtypeSlot;
          break;
        }
      }
      if (targetSlot) break;
    }

    if (!targetSlot) {
      return res.status(404).json({
        success: false,
        message: "Target slot not found"
      });
    }

    // Log current state before release
    console.log('🔍 Before Release:', {
      slotId,
      totalPlants: targetSlot.totalPlants,
      availablePlants: targetSlot.availablePlants,
      bufferAmount: targetSlot.bufferAmount,
      bufferPercentage: targetSlot.buffer
    });

    // Release plants from buffer
    const releaseResult = releaseBufferPlants(targetSlot, plantsToRelease);
    
    if (!releaseResult.success) {
      const storedBuffer = Number(targetSlot.bufferAmount) || 0;
      let message = releaseResult.message;
      if (storedBuffer <= 0) {
        message =
          "No releasable buffer in database for this slot. The UI may show a theoretical reserve from inherited buffer % — save buffer % on this slot (PUT /slots/:id/buffer) or run POST /slots/migrate-buffers.";
      }
      return res.status(400).json({
        success: false,
        message
      });
    }

    console.log('📊 After Release Calculation:', {
      released: releaseResult.released,
      newBufferAmount: releaseResult.newBufferAmount,
      newAvailablePlants: releaseResult.newAvailablePlants,
      newBufferPercentage: releaseResult.newBufferPercentage
    });

    // Directly update the slot with the calculated values
    // Do NOT use updateSlotBufferCalculations as it recalculates from scratch
    // Calculate bufferAdjustedCapacity: totalPlants - bufferAmount
    const newBufferAdjustedCapacity = targetSlot.totalPlants - releaseResult.newBufferAmount;

    const updateResult = await PlantSlot.updateOne(
      { _id: plantSlot._id },
      {
        $set: {
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].bufferAmount': releaseResult.newBufferAmount,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].availablePlants': releaseResult.newAvailablePlants,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].availablePlantsMaterialized': true,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].buffer': releaseResult.newBufferPercentage,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].effectiveBuffer': releaseResult.newBufferPercentage,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].bufferAdjustedCapacity': newBufferAdjustedCapacity,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].originalTotalPlants':
            targetSlot.originalTotalPlants || targetSlot.totalPlants,
        }
      },
      {
        arrayFilters: [
          { 'subtypeElem.subtypeId': targetSubtypeSlot.subtypeId },
          { 'slotElem._id': new mongoose.Types.ObjectId(slotId) }
        ]
      }
    );

    console.log('✅ Database Update Result:', {
      matched: updateResult.matchedCount,
      modified: updateResult.modifiedCount,
      acknowledged: updateResult.acknowledged
    });

    if (!updateResult.modifiedCount) {
      console.error('❌ Update failed - no documents modified');
      return res.status(500).json({
        success: false,
        message: "Failed to update slot after buffer release"
      });
    }

    res.status(200).json({
      success: true,
      message: releaseResult.message,
      data: {
        slotId,
        released: releaseResult.released,
        newBufferAmount: releaseResult.newBufferAmount,
        newAvailablePlants: releaseResult.newAvailablePlants,
        newBufferPercentage: releaseResult.newBufferPercentage
      }
    });

  } catch (error) {
    console.error("Error releasing buffer plants:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Add plants directly to available plants (reducing buffer)
export const addPlantsToCapacityController = async (req, res) => {
  try {
    const { slotId } = req.params;
    const { plantsToAdd } = req.body;

    if (!plantsToAdd || plantsToAdd <= 0) {
      return res.status(400).json({
        success: false,
        message: "Number of plants to add must be greater than 0"
      });
    }

    // Find the slot
    const plantSlot = await PlantSlot.findOne({ 'subtypeSlots.slots._id': slotId }).populate('plantId');
    if (!plantSlot) {
      return res.status(404).json({
        success: false,
        message: "Slot not found"
      });
    }

    // Find the specific slot
    let targetSlot = null;
    let targetSubtypeSlot = null;
    
    for (const subtypeSlot of plantSlot.subtypeSlots) {
      for (const slot of subtypeSlot.slots) {
        if (slot._id.toString() === slotId) {
          targetSlot = slot;
          targetSubtypeSlot = subtypeSlot;
          break;
        }
      }
      if (targetSlot) break;
    }

    if (!targetSlot) {
      return res.status(404).json({
        success: false,
        message: "Target slot not found"
      });
    }

    // Add plants directly to available plants (reducing buffer)
    const addResult = addPlantsToAvailable(targetSlot, plantsToAdd);
    
    if (!addResult.success) {
      return res.status(400).json({
        success: false,
        message: addResult.message
      });
    }

    // Directly update the slot with the calculated values
    // Do NOT use updateSlotBufferCalculations as it recalculates from scratch
    // Calculate bufferAdjustedCapacity: totalPlants - bufferAmount
    const newBufferAdjustedCapacity = addResult.newTotalPlants - addResult.newBufferAmount;
    
    const updateResult = await PlantSlot.updateOne(
      { _id: plantSlot._id },
      {
        $set: {
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].totalPlants': addResult.newTotalPlants,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].availablePlantsMaterialized': true,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].bufferAmount': addResult.newBufferAmount,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].availablePlants': addResult.newAvailablePlants,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].availablePlantsMaterialized': true,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].buffer': addResult.newBufferPercentage,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].effectiveBuffer': addResult.newBufferPercentage,
          'subtypeSlots.$[subtypeElem].slots.$[slotElem].bufferAdjustedCapacity': newBufferAdjustedCapacity
        }
      },
      {
        arrayFilters: [
          { 'subtypeElem.subtypeId': targetSubtypeSlot.subtypeId },
          { 'slotElem._id': slotId }
        ]
      }
    );

    if (!updateResult.modifiedCount) {
      return res.status(500).json({
        success: false,
        message: "Failed to update slot after adding plants"
      });
    }

    res.status(200).json({
      success: true,
      message: addResult.message,
      data: {
        slotId,
        added: plantsToAdd,
        newTotalPlants: addResult.newTotalPlants,
        newBufferAmount: addResult.newBufferAmount,
        newAvailablePlants: addResult.newAvailablePlants
      }
    });

  } catch (error) {
    console.error("Error adding plants to available:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Migration endpoint to update buffer calculations for all slots
export const migrateBufferCalculations = async (req, res) => {
  try {
    console.log('🔄 Starting buffer calculations migration via API...');
    
    const result = await updateAllSlotBuffers();
    
    if (result.success) {
      res.status(200).json({
        success: true,
        message: 'Buffer calculations migration completed successfully',
        updatedCount: result.updatedCount
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Buffer calculations migration failed',
        error: result.error
      });
    }
    
  } catch (error) {
    console.error('❌ Migration error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during migration',
      error: error.message
    });
  }
};

/** Backfill available + totalPlants for legacy slots (capacity = available + booked). Skips materialized slots. */
export const migrateSlotCapacityModel = async (req, res) => {
  try {
    const dryRun = String(req.query?.dryRun ?? "false") === "true";
    const plantSlots = await PlantSlot.find({});
    let updatedSlots = 0;
    let skippedMaterialized = 0;
    let unchanged = 0;
    const samples = [];

    for (const plantSlot of plantSlots) {
      let docDirty = false;

      for (const subtypeSlot of plantSlot.subtypeSlots || []) {
        for (const slot of subtypeSlot.slots || []) {
          const booked = Number(slot.totalBookedPlants) || 0;

          if (isAvailablePlantsMaterialized(slot)) {
            skippedMaterialized += 1;
            const available = Number(slot.availablePlants) || 0;
            const capacity = deriveSlotCapacity(available, booked);
            if (slot.totalPlants !== capacity) {
              slot.totalPlants = capacity;
              docDirty = true;
              updatedSlots += 1;
            } else {
              unchanged += 1;
            }
            continue;
          }

          const available = computeLegacyAvailableFromCapacity(slot, booked);
          const capacity = deriveSlotCapacity(available, booked);

          if (slot.availablePlants !== available || slot.totalPlants !== capacity) {
            if (samples.length < 5) {
              samples.push({
                slotId: slot._id,
                before: { availablePlants: slot.availablePlants, totalPlants: slot.totalPlants, booked },
                after: { availablePlants: available, totalPlants: capacity, booked },
              });
            }
            slot.availablePlants = available;
            slot.totalPlants = capacity;
            docDirty = true;
            updatedSlots += 1;
          } else {
            unchanged += 1;
          }
        }
      }

      if (docDirty && !dryRun) {
        await plantSlot.save();
      }
    }

    res.status(200).json({
      success: true,
      dryRun,
      message: dryRun
        ? "Dry run complete — no documents saved"
        : "Slot capacity model migration completed",
      updatedSlots,
      skippedMaterialized,
      unchanged,
      samples,
    });
  } catch (error) {
    console.error("migrateSlotCapacityModel error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error during capacity migration",
      error: error.message,
    });
  }
};

// Create slots for a specific subtype with custom configuration
export const createSlotsForSubtype = async (req, res) => {
  try {
    const { 
      plantId, 
      subtypeId, 
      startYear, 
      endYear, 
      slotSize, 
      totalPlantsPerSlot, 
      buffer,
      startMonth,
      endMonth,
      startDate,
      endDate
    } = req.body;

    if (!plantId || !subtypeId || !slotSize || !totalPlantsPerSlot) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: plantId, subtypeId, slotSize, totalPlantsPerSlot'
      });
    }

    // Validate date range - either use startDate/endDate or startMonth/endMonth/startYear/endYear
    if (!startDate || !endDate) {
      if (!startMonth || !endMonth || !startYear || !endYear) {
        return res.status(400).json({
          success: false,
          message: 'Either startDate/endDate or startMonth/endMonth/startYear/endYear must be provided'
        });
      }
    }

    // Validate plant exists
    const plant = await PlantCms.findById(plantId);
    if (!plant) {
      return res.status(404).json({
        success: false,
        message: 'Plant not found'
      });
    }

    // Validate subtype exists
    const subtype = plant.subtypes.find(st => st._id.toString() === subtypeId);
    if (!subtype) {
      return res.status(404).json({
        success: false,
        message: 'Subtype not found for this plant'
      });
    }

    // Generate slots based on date range (can span multiple years)
    const results = [];
    
    try {
      let startDateStr, endDateStr;
      
      if (startDate && endDate) {
        // Use provided startDate and endDate
        startDateStr = startDate;
        endDateStr = endDate;
      } else {
        // Use month/year combination
        startDateStr = `01-${getMonthNumber(startMonth)}-${startYear}`;
        endDateStr = `${getDaysInMonth(endMonth, endYear)}-${getMonthNumber(endMonth)}-${endYear}`;
      }

      // Parse dates and get year range
      const startMoment = moment(startDateStr, 'DD-MM-YYYY');
      const endMoment = moment(endDateStr, 'DD-MM-YYYY');
      const startYear = startMoment.year();
      const endYear = endMoment.year();

      // Handle multiple years if date range spans across years
      for (let year = startYear; year <= endYear; year++) {
        // Check if slots already exist for this plant, subtype, and year
        const existingSlots = await PlantSlot.findOne({
          plantId: plantId,
          year: year,
          "subtypeSlots.subtypeId": subtypeId
        });

        // Determine date range for this specific year
        let yearStartDate, yearEndDate;
        if (year === startYear && year === endYear) {
          // Same year - use full range
          yearStartDate = startDateStr;
          yearEndDate = endDateStr;
        } else if (year === startYear) {
          // First year - from start date to year end
          yearStartDate = startDateStr;
          yearEndDate = `31-12-${year}`;
        } else if (year === endYear) {
          // Last year - from year start to end date
          yearStartDate = `01-01-${year}`;
          yearEndDate = endDateStr;
        } else {
          // Middle year - full year
          yearStartDate = `01-01-${year}`;
          yearEndDate = `31-12-${year}`;
        }

        if (existingSlots) {
          // Update existing slots
          const subtypeSlotIndex = existingSlots.subtypeSlots.findIndex(
            ss => ss.subtypeId.toString() === subtypeId
          );

          if (subtypeSlotIndex !== -1) {
            // Generate new slots for this subtype and year
            const newSlots = generateSlotsForDateRange(
              yearStartDate,
              yearEndDate,
              slotSize,
              totalPlantsPerSlot
            );

            // Update the slots
            existingSlots.subtypeSlots[subtypeSlotIndex].slots = newSlots;
            await existingSlots.save();

            results.push({
              year: year,
              status: 'updated',
              slotsCount: newSlots.length,
              dateRange: `${yearStartDate} to ${yearEndDate}`
            });
          }
        } else {
          // Create new slots for this year
          const newSlots = generateSlotsForDateRange(
            yearStartDate,
            yearEndDate,
            slotSize,
            totalPlantsPerSlot
          );

          const newPlantSlot = new PlantSlot({
            plantId: plantId,
            year: year,
            subtypeSlots: [{
              subtypeId: subtypeId,
              subtypeName: subtype.name,
              slots: newSlots
            }]
          });

          await newPlantSlot.save();

          results.push({
            year: year,
            status: 'created',
            slotsCount: newSlots.length,
            dateRange: `${yearStartDate} to ${yearEndDate}`
          });
        }
      }
    } catch (error) {
      results.push({
        year: 'error',
        status: 'error',
        error: error.message
      });
    }

    res.status(200).json({
      success: true,
      message: 'Slots created/updated successfully for subtype',
      data: {
        plantId,
        subtypeId,
        subtypeName: subtype.name,
        results
      }
    });

  } catch (error) {
    console.error('Error creating slots for subtype:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Delete all slots for a plant or all plants
export const deleteAllSlots = async (req, res) => {
  try {
    const { plantId } = req.query;

    let deleteQuery = {};
    if (plantId) {
      deleteQuery.plantId = plantId;
    }

    const result = await PlantSlot.deleteMany(deleteQuery);

    res.status(200).json({
      success: true,
      message: plantId ? `All slots deleted for plant ${plantId}` : 'All slots deleted',
      deletedCount: result.deletedCount
    });

  } catch (error) {
    console.error('Error deleting slots:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// Enhanced slot generator for date ranges
const generateSlotsForDateRange = (startDate, endDate, slotSize = 7, capacity = 100000) => {
  const slots = [];
  let currentDate = moment(startDate, 'DD-MM-YYYY');
  const endMoment = moment(endDate, 'DD-MM-YYYY');

  // First pass: generate all slots to count them
  const tempSlots = [];
  let tempDate = currentDate.clone();
  
  while (tempDate.isSameOrBefore(endMoment)) {
    const slotStart = tempDate.clone();
    let slotEnd = tempDate.clone().add(slotSize - 1, 'days');

    // If slotEnd goes past the end date, adjust
    if (slotEnd.isAfter(endMoment)) {
      slotEnd = endMoment.clone();
    }

    // If slotEnd goes past month end, adjust to month end
    const monthEnd = slotStart.clone().endOf('month');
    if (slotEnd.isAfter(monthEnd)) {
      slotEnd = monthEnd.clone();
    }

    tempSlots.push({
      startDay: slotStart.format('DD-MM-YYYY'),
      endDay: slotEnd.format('DD-MM-YYYY'),
      month: slotStart.format('MMMM'),
      year: slotStart.year(),
    });

    tempDate = slotEnd.clone().add(1, 'days');
  }

  // Calculate capacity per slot (distribute evenly)
  const totalSlots = tempSlots.length;
  const capacityPerSlot = Math.floor(capacity / totalSlots);
  const remainingCapacity = capacity % totalSlots;

  // Second pass: create actual slots with distributed capacity
  let slotIndex = 0;
  while (currentDate.isSameOrBefore(endMoment)) {
    const slotStart = currentDate.clone();
    let slotEnd = currentDate.clone().add(slotSize - 1, 'days');

    // If slotEnd goes past the end date, adjust
    if (slotEnd.isAfter(endMoment)) {
      slotEnd = endMoment.clone();
    }

    // If slotEnd goes past month end, adjust to month end
    const monthEnd = slotStart.clone().endOf('month');
    if (slotEnd.isAfter(monthEnd)) {
      slotEnd = monthEnd.clone();
    }

    // Distribute remaining capacity to first few slots
    const slotCapacity = capacityPerSlot + (slotIndex < remainingCapacity ? 1 : 0);

    slots.push({
      startDay: slotStart.format('DD-MM-YYYY'),
      endDay: slotEnd.format('DD-MM-YYYY'),
      month: slotStart.format('MMMM'),
      year: slotStart.year(),
      totalPlants: slotCapacity,
      totalBookedPlants: 0,
      buffer: 0,
      orders: [],
      allowedSalesmen: [],
      restrictToSalesmen: false,
      overflow: false,
      status: true,
    });

    currentDate = slotEnd.clone().add(1, 'days');
    slotIndex++;
  }

  // Merge short last slot of each month with previous slot if needed
  let i = 1;
  while (i < slots.length) {
    const prev = slots[i - 1];
    const curr = slots[i];
    // If month changes, check if previous slot is short
    if (prev.month !== curr.month) {
      const prevStart = moment(prev.startDay, 'DD-MM-YYYY');
      const prevEnd = moment(prev.endDay, 'DD-MM-YYYY');
      const daysInPrevSlot = prevEnd.diff(prevStart, 'days') + 1;
      if (daysInPrevSlot < slotSize && i - 2 >= 0) {
        // Merge with the slot before previous
        slots[i - 2].endDay = prev.endDay;
        slots[i - 2].month = prev.month;
        // Redistribute capacity when merging slots
        slots[i - 2].totalPlants += prev.totalPlants;
        slots.splice(i - 1, 1); // Remove prev
        i--;
      }
    }
    i++;
  }

  // Also check the very last slot in the range
  if (slots.length > 1) {
    const last = slots[slots.length - 1];
    const secondLast = slots[slots.length - 2];
    const lastStart = moment(last.startDay, 'DD-MM-YYYY');
    const lastEnd = moment(last.endDay, 'DD-MM-YYYY');
    const daysInLastSlot = lastEnd.diff(lastStart, 'days') + 1;
    if (daysInLastSlot < slotSize) {
      secondLast.endDay = last.endDay;
      secondLast.month = last.month;
      // Redistribute capacity when merging slots
      secondLast.totalPlants += last.totalPlants;
      slots.pop();
    }
  }

  return slots;
};

// Function to calculate totalBookedPlants from orders array
const calculateTotalBookedPlantsFromOrders = async (slotId) => {
  try {
    const totalBookedPlants = await Order.aggregate([
      {
        $match: {
          bookingSlot: new mongoose.Types.ObjectId(slotId),
          orderStatus: { $nin: ['CANCELLED', 'REJECTED'] }, // Exclude cancelled and rejected orders - COMPLETED orders count in booked
          // Exclude dealer quota orders - exclude orders where quotaSource is "dealer"
          $and: [
            {
              $or: [
                { quotaSource: { $ne: "dealer" } }, // quotaSource is not "dealer"
                { quotaSource: { $exists: false } } // quotaSource field doesn't exist
              ]
            }
          ]
        }
      },
      {
        $group: {
          _id: null,
          totalBookedPlants: { $sum: '$numberOfPlants' }
        }
      }
    ]);

    return totalBookedPlants.length > 0 ? totalBookedPlants[0].totalBookedPlants : 0;
  } catch (error) {
    console.error('Error calculating totalBookedPlants from orders:', error);
    return 0;
  }
};

// Function to populate slots with orders and calculate totalBookedPlants
// OPTIMIZED: Batches all queries instead of N+1 queries
const populateSlotsWithOrders = async (slots, bufferContext = {}) => {
  const { subtypeBuffer = 0, plantBuffer = 0 } = bufferContext;
  try {
    // Collect all slot information for batch querying
    const slotIds = [];
    const slotDateMap = new Map(); // Map for date-based matching
    const slotMap = new Map(); // Map slotId -> slot for quick lookup
    
    for (const slotGroup of slots) {
      for (const slot of slotGroup.slots) {
        const slotId = slot._id?.toString ? slot._id.toString() : slot._id;
        slotIds.push(new mongoose.Types.ObjectId(slotId));
        slotMap.set(slotId, slot);
        
        // Store date-based lookup
        if (slot.startDay && slot.endDay) {
          const dateKey = `${slot.startDay}|${slot.endDay}`;
          if (!slotDateMap.has(dateKey)) {
            slotDateMap.set(dateKey, []);
          }
          slotDateMap.get(dateKey).push(slot);
        }
      }
    }

    // Batch query: Get all orders for all slots in one query
    // Exclude CANCELLED and REJECTED orders, and exclude dealer quota orders
    const orConditions = [
      { bookingSlot: { $in: slotIds } } // Direct ObjectId reference
    ];
    
    // Handle array format with slotId
    if (slotIds.length > 0) {
      orConditions.push({ "bookingSlot.slotId": { $in: slotIds.map(id => id.toString()) } });
    }
    
    // Handle array format with date matching
    const dateConditions = [];
    for (const dateKey of slotDateMap.keys()) {
      const [startDay, endDay] = dateKey.split('|');
      dateConditions.push({ "bookingSlot.startDay": startDay, "bookingSlot.endDay": endDay });
    }
    if (dateConditions.length > 0) {
      orConditions.push(...dateConditions);
    }
    
    const allOrders = await Order.find({
      $or: orConditions,
      orderStatus: { $nin: ['CANCELLED', 'REJECTED'] },
      $and: [
        {
          $or: [
            { quotaSource: { $ne: "dealer" } },
            { quotaSource: { $exists: false } }
          ]
        }
      ]
    })
      .select(
        "_id orderId numberOfPlants additionalPlants remainingPlants dispatchHistory orderStatus dealer quotaSource bookingSlot oldDeliveryDate originalBookingSlot dispatchedFromAnotherSlot pastDueSlotRollover pastDueSlotRolloverAt deliveryDate plantName plantSubtype sowingDone"
      )
      .lean();

    const deliveryRangeConditions = [];
    const plantIdsForDelivery = new Set();
    const subtypeIdsForDelivery = new Set();
    for (const slotGroup of slots) {
      if (slotGroup.plantId) plantIdsForDelivery.add(slotGroup.plantId.toString());
      if (slotGroup.subtypeId) subtypeIdsForDelivery.add(slotGroup.subtypeId.toString());
      for (const slot of slotGroup.slots || []) {
        const range = slotWindowToDeliveryUtcRange(slot);
        if (range) {
          deliveryRangeConditions.push({
            deliveryDate: { $gte: range.start, $lte: range.end },
          });
        }
      }
    }

    let deliveryDateOrders = [];
    if (deliveryRangeConditions.length > 0) {
      const deliveryMatch = {
        $or: deliveryRangeConditions,
        deliveryDate: { $exists: true, $ne: null },
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
        $and: [
          {
            $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
          },
        ],
      };
      if (plantIdsForDelivery.size === 1) {
        deliveryMatch.plantName = new mongoose.Types.ObjectId([...plantIdsForDelivery][0]);
      }
      if (subtypeIdsForDelivery.size === 1) {
        deliveryMatch.plantSubtype = new mongoose.Types.ObjectId([...subtypeIdsForDelivery][0]);
      }
      deliveryDateOrders = await Order.find(deliveryMatch)
        .select(
          "_id orderId numberOfPlants additionalPlants remainingPlants dispatchHistory orderStatus dealer quotaSource bookingSlot oldDeliveryDate originalBookingSlot dispatchedFromAnotherSlot pastDueSlotRollover pastDueSlotRolloverAt deliveryDate plantName plantSubtype sowingDone"
        )
        .lean();
    }

    const ordersById = new Map();
    for (const order of [...allOrders, ...deliveryDateOrders]) {
      ordersById.set(order._id?.toString?.() ?? String(order._id), order);
    }
    const mergedOrders = [...ordersById.values()];

    // Cross-slot dispatch aggregates (orders on other slots but dispatching here, or released from here)
    const crossSlotOrders = await Order.find({
      dispatchedFromAnotherSlot: true,
      orderStatus: { $nin: ["CANCELLED", "REJECTED", "TEMPORARY_CANCELLED"] },
      $or: [
        { bookingSlot: { $in: slotIds } },
        { originalBookingSlot: { $in: slotIds } },
      ],
      $and: [
        {
          $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
        },
      ],
    })
      .select(
        "_id orderId orderStatus numberOfPlants additionalPlants bookingSlot originalBookingSlot dispatchedFromAnotherSlot pastDueSlotRollover pastDueSlotRolloverAt deliveryDate"
      )
      .lean();

    const slotIdSet = new Set([...slotMap.keys()]);
    const crossSlotDetailBySlot = buildCrossSlotDetailBySlot(crossSlotOrders, slotMap);
    const dispatchedFromOtherBySlot = sumEarlyDispatchOntoSlot(crossSlotOrders, slotIdSet);
    const releasedForEarlyBySlot = new Map();
    for (const order of crossSlotOrders) {
      if (order.pastDueSlotRollover) continue;
      const qty =
        (Number(order.numberOfPlants) || 0) + (Number(order.additionalPlants) || 0);
      const originalId =
        order.originalBookingSlot?.toString?.() ?? String(order.originalBookingSlot);
      if (originalId && slotMap.has(originalId)) {
        releasedForEarlyBySlot.set(
          originalId,
          (releasedForEarlyBySlot.get(originalId) || 0) + qty
        );
      }
    }

    // Batch query: Get all dealer quota orders for all slots
    const dealerQuotaOrders = await Order.aggregate([
      {
        $match: {
          bookingSlot: { $in: slotIds },
          orderStatus: { $nin: ['CANCELLED', 'REJECTED'] },
          quotaSource: "dealer"
        }
      },
      {
        $group: {
          _id: "$bookingSlot",
          totalDealerQuotaUsed: { $sum: '$numberOfPlants' },
          dealerOrders: { $push: '$$ROOT' }
        }
      }
    ]);

    // Create a map for dealer quota by slotId
    const dealerQuotaMap = new Map();
    dealerQuotaOrders.forEach(item => {
      const slotId = item._id?.toString ? item._id.toString() : item._id;
      dealerQuotaMap.set(slotId, {
        totalDealerQuotaUsed: item.totalDealerQuotaUsed,
        dealerOrders: item.dealerOrders,
        hasDealerQuota: true
      });
    });

    const shedBySlot =
      slotIds.length > 0 ? await aggregateShedStockBySlotIds(slotIds) : new Map();

    // Group orders by slot
    const ordersBySlot = new Map();
    for (const order of allOrders) {
      let matchedSlotId = null;
      
      // Try to match by direct ObjectId
      if (order.bookingSlot) {
        const bookingSlotId = order.bookingSlot?.toString ? order.bookingSlot.toString() : order.bookingSlot;
        if (slotMap.has(bookingSlotId)) {
          matchedSlotId = bookingSlotId;
        }
      }
      
      // Try to match by slotId in array format
      if (!matchedSlotId && order.bookingSlot?.slotId) {
        const slotId = order.bookingSlot.slotId.toString();
        if (slotMap.has(slotId)) {
          matchedSlotId = slotId;
        }
      }
      
      // Try to match by date
      if (!matchedSlotId && order.bookingSlot?.startDay && order.bookingSlot?.endDay) {
        const dateKey = `${order.bookingSlot.startDay}|${order.bookingSlot.endDay}`;
        const matchingSlots = slotDateMap.get(dateKey);
        if (matchingSlots && matchingSlots.length > 0) {
          // Use first matching slot (in case of duplicates, all will get the order)
          matchedSlotId = matchingSlots[0]._id?.toString ? matchingSlots[0]._id.toString() : matchingSlots[0]._id;
        }
      }
      
      if (matchedSlotId) {
        if (!ordersBySlot.has(matchedSlotId)) {
          ordersBySlot.set(matchedSlotId, []);
        }
        ordersBySlot.get(matchedSlotId).push(order);
      }
    }

    const asOfToday = new Date();

    // Update slots with orders and calculate values
    for (const slotGroup of slots) {
      const ordersByDelivery = groupOrdersByDeliverySlot(mergedOrders, slotGroup.slots);
      const pastDueGroup = aggregatePastDueMetricsForSlotGroup(
        slotGroup.slots,
        ordersBySlot,
        asOfToday
      );
      const dispatchedCrossSlotBySlot = sumDispatchedCrossSlotOntoSlot(
        crossSlotOrders,
        slotIdSet,
        slotGroup.slots
      );

      for (const slot of slotGroup.slots) {
        const slotId = slot._id?.toString ? slot._id.toString() : slot._id;
        const orders = ordersBySlot.get(slotId) || [];
        const deliveryOrders = ordersByDelivery.get(slotId) || [];
        const nativeDelivery = getNativeDeliveryCohortOrders(deliveryOrders);
        const dispatchStats = computeSlotDispatchStatsFromOrders(orders, {
          bookedOrders: nativeDelivery,
          pipelineOrders: nativeDelivery,
        });
        addRolledRemainingToStats(dispatchStats, deliveryOrders);
        addRolledDispatchedToStats(dispatchStats, deliveryOrders);
        finalizeDispatchedBifurcation(
          dispatchStats,
          dispatchedCrossSlotBySlot.get(slotId) || 0
        );

        // Get dealer quota information for this slot
        const dealerQuota = dealerQuotaMap.get(slotId) || {
          totalDealerQuotaUsed: 0,
          dealerOrders: [],
          hasDealerQuota: false
        };
        
        slot.orders = orders;
        slot.dealerQuota = dealerQuota;
        Object.assign(
          slot,
          buildSlotOrderMetrics({
            slot,
            slotId,
            orders,
            dispatchStats,
            pastDueGroup,
            dispatchedFromOtherBySlot,
            releasedForEarlyBySlot,
            crossSlotDetailBySlot,
          })
        );

        const resolved = resolveSlotBufferFields(slot, { subtypeBuffer, plantBuffer });
        slot.effectiveBuffer = resolved.effectiveBuffer;
        slot.bufferAdjustedCapacity = resolved.bufferAdjustedCapacity;
        slot.availablePlants = resolved.availablePlants;
        slot.availableIncludingPastDue = resolved.availablePlants;
        slot.totalPlants = resolved.totalCapacity;
        slot.bufferAmount = resolved.bufferAmount;
        slot.displayBufferAmount = resolved.displayBufferAmount;
        slot.computedBufferAmount = resolved.computedBufferAmount;
        slot.inheritedBufferAmount = resolved.inheritedBufferAmount;
        slot.hasStoredBuffer = resolved.hasStoredBuffer;
        slot.bufferMaterialized = resolved.bufferMaterialized;
        slot.inheritedBufferOnly = resolved.inheritedBufferOnly;
        slot.availablePlantsMaterialized = resolved.availablePlantsMaterialized;

        const shed = shedBySlot.get(slotId) || {};
        slot.shedSyncedPlants = shed.shedSyncedPlants ?? 0;
        slot.shedAvailableInShed = shed.shedAvailableInShed ?? 0;
        slot.shedRollupReadyPlants = shed.actualReadyPlants ?? 0;
        slot.actualReadyPlants =
          Math.max(
            Number(slot.actualReadyPlants) || 0,
            shed.actualReadyPlants ?? 0
          );
        slot.shedReadyInShed = shed.shedReadyInShed ?? 0;
        slot.expectedMortality = Number(slot.expectedMortality) || 0;
        slot.lagwadRemaining = Number(slot.lagwadRemaining) || 0;
        slot.linkedBatchCount = shed.linkedBatchCount ?? 0;
        slot.shedLineCount = shed.lineCount ?? 0;

        slot.rolledInActualReadyPlants =
          Number(slot.rolledInActualReadyPlants) || 0;
        try {
          slot.readyRollSummary = await summarizeReadyRollForSlot(slotId);
        } catch {
          slot.readyRollSummary = {
            totalRolledReady: 0,
            overdueLines: 0,
            latestRollAt: null,
          };
        }

        slot.isOverflow = slot.availablePlants < 0;
        slot.overflow = slot.availablePlants < 0;
      }
    }
    
    return slots;
  } catch (error) {
    console.error('Error populating slots with orders:', error);
    return slots;
  }
};

// Function to get dealer quota information for a slot
const getDealerQuotaForSlot = async (slotId) => {
  try {
    const dealerQuotaOrders = await Order.aggregate([
      {
        $match: {
          bookingSlot: new mongoose.Types.ObjectId(slotId),
          orderStatus: { $nin: ['CANCELLED', 'REJECTED'] },
          quotaSource: "dealer" // Only dealer quota orders
        }
      },
      {
        $group: {
          _id: null,
          totalDealerQuotaUsed: { $sum: '$numberOfPlants' },
          dealerOrders: { $push: '$$ROOT' }
        }
      }
    ]);

    if (dealerQuotaOrders.length === 0) {
      return {
        totalDealerQuotaUsed: 0,
        dealerOrders: [],
        hasDealerQuota: false
      };
    }

    return {
      totalDealerQuotaUsed: dealerQuotaOrders[0].totalDealerQuotaUsed,
      dealerOrders: dealerQuotaOrders[0].dealerOrders,
      hasDealerQuota: true
    };
  } catch (error) {
    console.error('Error getting dealer quota for slot:', error);
    return {
      totalDealerQuotaUsed: 0,
      dealerOrders: [],
      hasDealerQuota: false
    };
  }
};

// Get slot details by ID
export const getSlotDetailsById = async (req, res) => {
  try {
    const { slotId } = req.params;
    const isFullEndpoint = req.path && req.path.includes('/full'); // Check if it's the /full endpoint
    const { full = false } = req.query; // Query parameter to get full DB document
    
    if (!slotId) {
      return res.status(400).json({ 
        success: false, 
        message: "Slot ID is required" 
      });
    }

    console.log("Getting slot details for slot ID:", slotId, "isFullEndpoint:", isFullEndpoint);

    // If full endpoint or full=true, return complete database document
    if (isFullEndpoint || req.query.full === 'true' || req.query.full === true) {
      const slotObjectId = new mongoose.Types.ObjectId(slotId);
      const plantSlotDoc = await PlantSlot.findOne({
        "subtypeSlots.slots._id": slotObjectId,
      }).lean();

      if (!plantSlotDoc) {
        return res.status(404).json({ 
          success: false, 
          message: "Slot not found" 
        });
      }

      // Find the specific slot
      let matchedSubtype = null;
      let matchedSlot = null;

      for (const subtype of plantSlotDoc.subtypeSlots || []) {
        const slot = (subtype.slots || []).find(
          (item) => item._id && item._id.toString() === slotObjectId.toString()
        );
        if (slot) {
          matchedSubtype = subtype;
          matchedSlot = slot;
          break;
        }
      }

      if (!matchedSlot) {
        return res.status(404).json({ 
          success: false, 
          message: "Slot not found in subtypeSlots" 
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          plantSlotDocument: plantSlotDoc,
          matchedSubtype: matchedSubtype,
          matchedSlot: matchedSlot
        }
      });
    }

    // Import the utility function
    const { getSlotInfoWithBookedPlants } = await import('../utility/slotBookedPlantsCalculator.js');
    
    // Get slot details
    const slotInfo = await getSlotInfoWithBookedPlants(slotId);
    
    if (!slotInfo) {
      return res.status(404).json({ 
        success: false, 
        message: "Slot not found" 
      });
    }

    // Format the response
    const response = {
      success: true,
      data: {
        slotId: slotInfo.slotId,
        startDay: slotInfo.startDay,
        endDay: slotInfo.endDay,
        month: slotInfo.month,
        totalPlants: slotInfo.totalPlants,
        totalBookedPlants: slotInfo.totalBookedPlants,
        availablePlants: slotInfo.availablePlants,
        isOverflow: slotInfo.isOverflow,
        buffer: slotInfo.buffer,
        effectiveBuffer: slotInfo.effectiveBuffer,
        bufferAdjustedCapacity: slotInfo.bufferAdjustedCapacity,
        bufferAmount: slotInfo.bufferAmount,
        originalTotalPlants: slotInfo.originalTotalPlants,
        dealerQuota: await getDealerQuotaForSlot(slotId) // Add dealer quota data
      }
    };

    console.log("Slot details response:", response);
    res.status(200).json(response);
    
  } catch (error) {
    console.error("Error getting slot details:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error", 
      error: error.message 
    });
  }
};

const sortSlotsByStartDay = (slots) => {
  return [...slots].sort((a, b) => {
    const ma = moment(a.startDay, "DD-MM-YYYY", true);
    const mb = moment(b.startDay, "DD-MM-YYYY", true);
    if (!ma.isValid() && !mb.isValid()) return 0;
    if (!ma.isValid()) return 1;
    if (!mb.isValid()) return -1;
    return ma.valueOf() - mb.valueOf();
  });
};

/** Keep slots whose delivery window has not ended (endDay >= today). */
const filterNonPastSlots = (slots) => {
  const today = moment().startOf("day");
  return (slots || []).filter((slot) => {
    const end = moment(slot.endDay, "DD-MM-YYYY", true);
    if (!end.isValid()) return true;
    return end.isSameOrAfter(today, "day");
  });
};

/** Flat slot list for stock entry panel */
export const getStockEntry = async (req, res) => {
  try {
    const { plantId, subtypeId, year, month } = req.query;

    if (!plantId || !subtypeId || !year) {
      return res.status(400).json({
        success: false,
        message: "plantId, subtypeId, and year are required.",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(plantId) ||
      !mongoose.Types.ObjectId.isValid(subtypeId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid plantId or subtypeId.",
      });
    }

    const plantSlot = await PlantSlot.findOne({
      plantId: new mongoose.Types.ObjectId(plantId),
      year: Number(year),
    }).lean();

    if (!plantSlot) {
      return res.status(200).json({
        success: true,
        slots: [],
        message: "No slots found for this plant and year.",
      });
    }

    const subtypeSlot = (plantSlot.subtypeSlots || []).find(
      (st) => st.subtypeId?.toString() === subtypeId.toString()
    );

    if (!subtypeSlot) {
      return res.status(200).json({
        success: true,
        slots: [],
        message: "No slots found for this subtype.",
      });
    }

    let slots = subtypeSlot.slots || [];
    if (month) {
      slots = slots.filter((s) => s.month === month);
    }
    slots = filterNonPastSlots(slots);
    slots = sortSlotsByStartDay(slots);

    const slotObjectIds = slots
      .map((s) => s._id)
      .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    let statsBySlot = new Map();
    if (slotObjectIds.length > 0) {
      const orders = await Order.find({
        bookingSlot: { $in: slotObjectIds },
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
        $or: [
          { quotaSource: { $ne: "dealer" } },
          { quotaSource: { $exists: false } },
        ],
      })
        .select(
          "bookingSlot numberOfPlants additionalPlants remainingPlants dispatchHistory orderStatus"
        )
        .lean();
      statsBySlot = aggregateSlotDispatchStats(orders);
    }

    const shedBySlot =
      slotObjectIds.length > 0
        ? await aggregateShedStockBySlotIds(slotObjectIds)
        : new Map();

    const payload = slots.map((slot) => {
      const dispatchStats = getSlotDispatchStats(statsBySlot, slot._id);
      const actualPlants = Number(slot.actualPlants) || 0;
      const remainingToDispatch = dispatchStats.remainingToDispatch;
      const actualAvailable = computeActualAvailable(
        actualPlants,
        remainingToDispatch
      );
      const shed = shedBySlot.get(String(slot._id)) || {};
      return {
        _id: slot._id,
        startDay: slot.startDay,
        endDay: slot.endDay,
        month: slot.month,
        totalPlants: Number(slot.totalPlants) || 0,
        totalBookedPlants: dispatchStats.totalBookedPlants,
        totalDispatchedPlants: dispatchStats.totalDispatchedPlants,
        remainingToDispatch,
        availablePlants: getSlotEffectiveAvailablePlants(slot),
        plantsSowed: Number(slot.plantsSowed) || 0,
        actualPlants,
        actualAvailable,
        closingStock: Number(slot.closingStock) || 0,
        shedSyncedPlants: shed.shedSyncedPlants ?? 0,
        shedAvailableInShed: shed.shedAvailableInShed ?? 0,
        actualReadyPlants: shed.actualReadyPlants ?? 0,
        shedReadyInShed: shed.shedReadyInShed ?? 0,
        linkedBatchCount: shed.linkedBatchCount ?? 0,
        shedLineCount: shed.lineCount ?? 0,
        status: slot.status,
        isManual: slot.isManual,
      };
    });

    return res.status(200).json({
      success: true,
      slots: payload,
      count: payload.length,
    });
  } catch (error) {
    console.error("Error fetching stock entry slots:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/**
 * GET /slots/lagwad-analysis
 * Combined lagwad view across any set of months / slot windows for one subtype.
 * `months` and `slotIds` accept comma-separated values; both are optional.
 */
export const getLagwadAnalysisHandler = async (req, res) => {
  try {
    const { plantId, subtypeId, year, months, slotIds, metaOnly } = req.query;
    if (!plantId || !subtypeId || !year) {
      return res.status(400).json({
        success: false,
        message: "plantId, subtypeId and year are required.",
      });
    }

    const data = await getLagwadAnalysis({
      plantId,
      subtypeId,
      year,
      months,
      slotIds,
      metaOnly: metaOnly === "1" || metaOnly === "true",
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("getLagwadAnalysisHandler:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to build lagwad analysis",
    });
  }
};

/** Secondary shed batches + sowing dates linked to a booking slot (ERP drill-down). */
export const getSlotSecondaryShedBreakdownHandler = async (req, res) => {
  try {
    const { slotId } = req.params;
    if (!slotId || !mongoose.Types.ObjectId.isValid(String(slotId))) {
      return res.status(400).json({
        success: false,
        message: "Valid slotId is required.",
      });
    }

    const data = await getSlotSecondaryShedBreakdown(slotId);
    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Slot not found.",
      });
    }

    return res.status(200).json({
      success: true,
      ...data,
    });
  } catch (error) {
    console.error("Error fetching slot secondary shed breakdown:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/** Transfer expected mortality → actual ready (plants survived). */
export const transferSlotExpectedMortalityHandler = async (req, res) => {
  try {
    const { slotId } = req.params;
    const quantity = req.body?.quantity;
    if (!slotId || !mongoose.Types.ObjectId.isValid(String(slotId))) {
      return res.status(400).json({
        success: false,
        message: "Valid slotId is required.",
      });
    }

    const performedBy = req.user?._id;
    const result = await transferSlotExpectedMortalityToReady({
      slotId,
      quantity,
      performedBy,
      source: "Expected mortality → ready (ERP)",
    });

    if (result.skipped === "slot_not_found") {
      return res.status(404).json({ success: false, message: "Slot not found." });
    }
    if (result.skipped === "no_expected_mortality") {
      return res.status(400).json({
        success: false,
        message: "No expected mortality on this slot to transfer.",
      });
    }
    if (result.transferred < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid transfer quantity.",
      });
    }

    return res.status(200).json({
      success: true,
      transferred: result.transferred,
      slotId: result.slotId,
      message: `Transferred ${result.transferred} plants from expected mortality to actual ready.`,
    });
  } catch (error) {
    console.error("Error transferring expected mortality:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/** Bulk update actualPlants / closingStock with per-field trail */
export const bulkStockEntry = async (req, res) => {
  try {
    const { updates } = req.body;
    const performedBy = req.user?._id;

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "updates array is required.",
      });
    }

    let updatedCount = 0;
    const errors = [];
    const plantSlotsToSave = new Map();

    for (const row of updates) {
      const { slotId, actualPlants, closingStock, availablePlants, status } = row || {};

      if (!slotId || !mongoose.Types.ObjectId.isValid(slotId)) {
        errors.push({ slotId, message: "Invalid slotId" });
        continue;
      }

      const stockPayload = {};
      if (actualPlants !== undefined) {
        const n = Number(actualPlants);
        if (!Number.isFinite(n) || n < 0) {
          errors.push({ slotId, message: "actualPlants must be a non-negative number" });
          continue;
        }
        stockPayload.actualPlants = Math.floor(n);
      }
      if (closingStock !== undefined) {
        const n = Number(closingStock);
        if (!Number.isFinite(n) || n < 0) {
          errors.push({ slotId, message: "closingStock must be a non-negative number" });
          continue;
        }
        stockPayload.closingStock = Math.floor(n);
      }
      if (availablePlants !== undefined) {
        const n = Number(availablePlants);
        if (!Number.isFinite(n) || n < 0) {
          errors.push({ slotId, message: "availablePlants must be a non-negative number" });
          continue;
        }
        stockPayload.availablePlants = Math.floor(n);
      }

      if (Object.keys(stockPayload).length === 0 && status === undefined) {
        errors.push({ slotId, message: "No fields to update" });
        continue;
      }

      try {
        let plantSlot = null;
        for (const doc of plantSlotsToSave.values()) {
          const found = doc.subtypeSlots.some((st) =>
            (st.slots || []).some((s) => s._id.toString() === slotId)
          );
          if (found) {
            plantSlot = doc;
            break;
          }
        }

        if (!plantSlot) {
          plantSlot = await PlantSlot.findOne({
            "subtypeSlots.slots._id": new mongoose.Types.ObjectId(slotId),
          });
          if (!plantSlot) {
            errors.push({ slotId, message: "Slot not found" });
            continue;
          }
        }

        let targetSlot = null;
        for (const subtype of plantSlot.subtypeSlots) {
          const slot = subtype.slots.find((s) => s._id.toString() === slotId);
          if (slot) {
            targetSlot = slot;
            break;
          }
        }

        if (!targetSlot) {
          errors.push({ slotId, message: "Slot not found" });
          continue;
        }

        if (performedBy && typeof targetSlot.setPerformer === "function") {
          targetSlot.setPerformer(performedBy);
        }

        let changed = false;
        if (Object.keys(stockPayload).length > 0) {
          changed = applyStockFieldUpdates(
            targetSlot,
            stockPayload,
            performedBy,
            "Stock entry panel"
          );
        }

        if (status !== undefined) {
          const nextStatus = status === true || status === "true";
          if (Boolean(targetSlot.status) !== nextStatus) {
            targetSlot.status = nextStatus;
            changed = true;
          }
        }

        if (changed) {
          updatedCount += 1;
        }

        plantSlotsToSave.set(plantSlot._id.toString(), plantSlot);
      } catch (rowError) {
        errors.push({ slotId, message: rowError.message });
      }
    }

    for (const plantSlot of plantSlotsToSave.values()) {
      await plantSlot.save();
    }

    return res.status(200).json({
      success: errors.length === 0,
      updatedCount,
      errors,
      message:
        errors.length === 0
          ? `Updated ${updatedCount} slot(s).`
          : `Updated ${updatedCount} slot(s) with ${errors.length} error(s).`,
    });
  } catch (error) {
    console.error("Error in bulk stock entry:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

/** Attach display order # and farmer for trail rows that reference an order. */
async function enrichTrailEntriesWithOrderInfo(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return entries;

  const idSet = new Set();
  for (const entry of entries) {
    const raw = entry.orderId?._id ?? entry.orderId;
    if (raw) idSet.add(String(raw));
    const metaIds = entry.metadata?.orderIds;
    if (Array.isArray(metaIds)) {
      metaIds.forEach((id) => {
        if (id) idSet.add(String(id));
      });
    }
  }

  if (idSet.size === 0) {
    return entries.map((entry) => ({
      ...entry,
      orderMongoId: entry.orderId?._id?.toString?.() ?? entry.orderId?.toString?.() ?? null,
      orderNumber: null,
      farmerName: null,
      farmerMobile: null,
    }));
  }

  const orderDocs = await Order.find({
    _id: { $in: [...idSet].map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .select("_id orderId orderFor farmer")
    .populate("farmer", "name mobileNumber")
    .lean();

  const orderMap = new Map(
    orderDocs.map((o) => {
      const of =
        o.orderFor && typeof o.orderFor === "object" && !Array.isArray(o.orderFor)
          ? o.orderFor
          : null;
      const bookingName = o.farmer?.name ? String(o.farmer.name).trim() : "";
      const orderForName = of?.name ? String(of.name).trim() : "";
      const displayName = orderForName
        ? `${orderForName} · Booking: ${bookingName || "Unknown"}`
        : bookingName || null;
      const orderForMobile =
        of?.mobileNumber != null && of.mobileNumber !== "" && of.mobileNumber !== 0
          ? String(of.mobileNumber)
          : null;
      return [
        String(o._id),
        {
          orderNumber: o.orderId ?? null,
          farmerName: bookingName || null,
          farmerMobile: o.farmer?.mobileNumber ?? null,
          orderForName: orderForName || null,
          bookingFarmerName: bookingName || null,
          orderForMobile,
          customerDisplayName: displayName,
        },
      ];
    })
  );

  return entries.map((entry) => {
    const orderMongoId =
      entry.orderId?._id?.toString?.() ?? entry.orderId?.toString?.() ?? null;
    const meta = entry.metadata || {};
    const info = orderMongoId ? orderMap.get(orderMongoId) : null;

    const customerDisplayName =
      meta.customerDisplayName ?? info?.customerDisplayName ?? null;
    const orderForName = meta.orderForName ?? info?.orderForName ?? null;
    const bookingFarmerName =
      meta.bookingFarmerName ?? meta.farmerName ?? info?.bookingFarmerName ?? info?.farmerName ?? null;
    const farmerName = bookingFarmerName;
    const farmerMobile = meta.farmerMobile ?? info?.farmerMobile ?? null;
    const orderForMobile = meta.orderForMobile ?? info?.orderForMobile ?? null;

    const whoParts = [];
    if (orderForName) whoParts.push(orderForName);
    if (bookingFarmerName) {
      whoParts.push(`Booking: ${bookingFarmerName}`);
    } else if (farmerName) {
      whoParts.push(farmerName);
    }
    const mobileParts = [farmerMobile, orderForMobile].filter(Boolean);
    if (mobileParts.length) {
      whoParts.push(mobileParts.join(" / "));
    }

    return {
      ...entry,
      orderMongoId,
      orderNumber: meta.orderNumber ?? info?.orderNumber ?? null,
      farmerName,
      farmerMobile,
      orderForName,
      bookingFarmerName,
      orderForMobile,
      customerDisplayName,
      customerLine: customerDisplayName || whoParts.join(" · ") || null,
    };
  });
}

// Get slot trail history with populated user info
export const getSlotTrail = async (req, res) => {
  try {
    const { slotId } = req.params;
    const { types } = req.query;
    
    if (!slotId) {
      return res.status(400).json({ 
        success: false, 
        message: "Slot ID is required" 
      });
    }

    const slotObjectId = new mongoose.Types.ObjectId(slotId);

    // Use aggregation to get slot trail with populated user info
    const result = await PlantSlot.aggregate([
      {
        $match: {
          "subtypeSlots.slots._id": slotObjectId,
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $match: {
          "subtypeSlots.slots._id": slotObjectId,
        },
      },
      {
        $addFields: {
          slotTrail: "$subtypeSlots.slots.slotTrail",
        },
      },
      {
        $unwind: {
          path: "$slotTrail",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "slotTrail.performedBy",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      {
        $addFields: {
          "slotTrail.performedByInfo": {
            $cond: {
              if: { $gt: [{ $size: "$userInfo" }, 0] },
              then: {
                $arrayElemAt: ["$userInfo", 0],
              },
              else: null,
            },
          },
        },
      },
      {
        $project: {
          slotTrail: 1,
          _id: 0,
        },
      },
      {
        $sort: {
          "slotTrail.createdAt": -1,
        },
      },
    ]);

    // Filter primary sowing entries (reason contains "Primary sowing")
    const primarySowingEntries = result
      .filter((entry) => entry.slotTrail && entry.slotTrail.reason && entry.slotTrail.reason.includes("Primary sowing"))
      .map((entry) => {
        const trail = entry.slotTrail;
        return {
          // Core fields
          action: trail.action,
          activityName: trail.activityName,
          quantity: trail.quantity,
          // Plus values
          plus: trail.plus || {},
          // Minus values
          minus: trail.minus || {},
          // Before state
          before: trail.before || {},
          // After state
          after: trail.after || {},
          // Legacy fields (for backward compatibility)
          previousTotalPlants: trail.previousTotalPlants,
          newTotalPlants: trail.newTotalPlants,
          previousAvailablePlants: trail.previousAvailablePlants,
          newAvailablePlants: trail.newAvailablePlants,
          bufferPercentage: trail.bufferPercentage,
          bufferAmount: trail.bufferAmount,
          reason: trail.reason,
          notes: trail.notes,
          // Sowing-specific fields
          sowingId: trail.sowingId,
          sowingLocation: trail.sowingLocation,
          batchNumber: trail.batchNumber,
          sowingDate: trail.sowingDate,
          plantReadyDate: trail.plantReadyDate,
          isExcessiveSowing: trail.isExcessiveSowing,
          orderId: trail.orderId,
          sowingRequestId: trail.sowingRequestId,
          requestNumber: trail.requestNumber,
          gapCoverageDetails: trail.gapCoverageDetails,
          // Metadata
          metadata: trail.metadata || {},
          // Timestamps
          createdAt: trail.createdAt,
          updatedAt: trail.updatedAt,
          // Performed by info
          performedBy: trail.performedByInfo
            ? {
                _id: trail.performedByInfo._id,
                name: trail.performedByInfo.name,
                phoneNumber: trail.performedByInfo.phoneNumber,
              }
            : trail.performedBy || null,
          // Also include raw performedBy for reference
          performedById: trail.performedBy,
        };
      });

    // Get all trail entries with user info for general trail
    const allTrailEntries = result
      .filter((entry) => entry.slotTrail)
      .map((entry) => {
        const trail = entry.slotTrail;

        return {
          // Core fields with defaults
          action: trail.action || 'UPDATE',
          activityName: trail.activityName || getSlotTrailActivityName(trail.action),
          quantity: trail.quantity ?? 0,
          // Plus values with defaults
          plus: {
            primarySowed: trail.plus?.primarySowed ?? 0,
            officeSowed: trail.plus?.officeSowed ?? 0,
            totalPlants: trail.plus?.totalPlants ?? 0,
            availablePlants: trail.plus?.availablePlants ?? 0,
            excessivePlants: trail.plus?.excessivePlants ?? 0,
            packetsUsed: trail.plus?.packetsUsed ?? 0,
            plantsSowed: trail.plus?.plantsSowed ?? 0,
            gapCovered: trail.plus?.gapCovered ?? 0,
          },
          // Minus values with defaults
          minus: {
            packetsRemaining: trail.minus?.packetsRemaining ?? 0,
            inProgressEntries: trail.minus?.inProgressEntries ?? 0,
          },
          // Before state with defaults
          before: {
            primarySowed: trail.before?.primarySowed ?? 0,
            officeSowed: trail.before?.officeSowed ?? 0,
            totalPlants: trail.before?.totalPlants ?? trail.previousTotalPlants ?? 0,
            availablePlants: trail.before?.availablePlants ?? trail.previousAvailablePlants ?? 0,
            excessivePlants: trail.before?.excessivePlants ?? 0,
            plantsSowed: trail.before?.plantsSowed ?? 0,
            totalBookedPlants: trail.before?.totalBookedPlants ?? 0,
            inProgressCount: trail.before?.inProgressCount ?? 0,
            actualPlants: trail.before?.actualPlants ?? 0,
            closingStock: trail.before?.closingStock ?? 0,
          },
          // After state with defaults
          after: {
            primarySowed: trail.after?.primarySowed ?? 0,
            officeSowed: trail.after?.officeSowed ?? 0,
            totalPlants: trail.after?.totalPlants ?? trail.newTotalPlants ?? 0,
            availablePlants: trail.after?.availablePlants ?? trail.newAvailablePlants ?? 0,
            excessivePlants: trail.after?.excessivePlants ?? 0,
            plantsSowed: trail.after?.plantsSowed ?? 0,
            totalBookedPlants: trail.after?.totalBookedPlants ?? 0,
            inProgressCount: trail.after?.inProgressCount ?? 0,
            actualPlants: trail.after?.actualPlants ?? 0,
            closingStock: trail.after?.closingStock ?? 0,
          },
          // Legacy fields (for backward compatibility)
          previousTotalPlants: trail.previousTotalPlants ?? trail.before?.totalPlants ?? 0,
          newTotalPlants: trail.newTotalPlants ?? trail.after?.totalPlants ?? 0,
          previousAvailablePlants: trail.previousAvailablePlants ?? trail.before?.availablePlants ?? 0,
          newAvailablePlants: trail.newAvailablePlants ?? trail.after?.availablePlants ?? 0,
          bufferPercentage: trail.bufferPercentage ?? 0,
          bufferAmount: trail.bufferAmount ?? 0,
          reason: trail.reason || 'Slot activity',
          notes: trail.notes || '',
          // Sowing-specific fields
          sowingId: trail.sowingId || null,
          sowingLocation: trail.sowingLocation || null,
          batchNumber: trail.batchNumber || null,
          sowingDate: trail.sowingDate || null,
          plantReadyDate: trail.plantReadyDate || null,
          isExcessiveSowing: trail.isExcessiveSowing ?? false,
          orderId: trail.orderId || null,
          sowingRequestId: trail.sowingRequestId || null,
          requestNumber: trail.requestNumber || null,
          gapCoverageDetails: trail.gapCoverageDetails || null,
          // Metadata
          metadata: trail.metadata || {},
          // Timestamps
          createdAt: trail.createdAt || new Date(),
          updatedAt: trail.updatedAt || new Date(),
          // Performed by info
          performedBy: trail.performedByInfo
            ? {
                _id: trail.performedByInfo._id,
                name: trail.performedByInfo.name,
                phoneNumber: trail.performedByInfo.phoneNumber,
              }
            : trail.performedBy || null,
          // Also include raw performedBy for reference
          performedById: trail.performedBy || null,
        };
      });

    let trailResponse = allTrailEntries;
    if (types === "stock") {
      trailResponse = allTrailEntries.filter((entry) =>
        STOCK_TRAIL_ACTION_LIST.includes(entry.action)
      );
    } else if (types === "rolls") {
      trailResponse = allTrailEntries.filter((entry) =>
        ROLL_TRAIL_ACTION_LIST.includes(entry.action) ||
        entry?.metadata?.transferType === "expired_available_roll"
      );
    } else if (types === "transfer") {
      trailResponse = allTrailEntries.filter((entry) =>
        TRANSFER_TRAIL_ACTION_LIST.includes(entry.action)
      );
    }

    const hasSowingTransferTrail = allTrailEntries.some(
      (e) =>
        e.action === SLOT_TRAIL_ACTIONS.SOWING_TRANSFER_OUT ||
        e.action === SLOT_TRAIL_ACTIONS.SOWING_TRANSFER_IN
    );

    if (!hasSowingTransferTrail && types !== "stock") {
      const slotOid = slotObjectId;
      const transferLogs = await SlotTransferLog.find({
        $or: [{ sourceSlotId: slotOid }, { targetSlotId: slotOid }],
        transferType: "sowing",
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .populate("performedBy", "name phoneNumber")
        .lean();

      const synthesized = [];
      for (const log of transferLogs) {
        const isSource = log.sourceSlotId?.toString() === slotId;
        const isTarget = log.targetSlotId?.toString() === slotId;
        const peerId = isSource ? log.targetSlotId : log.sourceSlotId;
        const snapBefore = isSource ? log.sourceBefore : log.targetBefore;
        const snapAfter = isSource ? log.sourceAfter : log.targetAfter;
        const action = isSource
          ? SLOT_TRAIL_ACTIONS.SOWING_TRANSFER_OUT
          : SLOT_TRAIL_ACTIONS.SOWING_TRANSFER_IN;

        if (!isSource && !isTarget) continue;

        synthesized.push({
          action,
          activityName: getSlotTrailActivityName(action),
          quantity: log.quantity ?? 0,
          plus: {},
          minus: {},
          before: {
            primarySowed: snapBefore?.primarySowed ?? 0,
            officeSowed: snapBefore?.officeSowed ?? 0,
            totalPlants: snapBefore?.totalPlants ?? 0,
            availablePlants: snapBefore?.availablePlants ?? 0,
            plantsSowed: snapBefore?.plantsSowed ?? 0,
            totalBookedPlants: snapBefore?.totalBookedPlants ?? 0,
            excessivePlants: 0,
            inProgressCount: 0,
            actualPlants: 0,
            closingStock: 0,
          },
          after: {
            primarySowed: snapAfter?.primarySowed ?? 0,
            officeSowed: snapAfter?.officeSowed ?? 0,
            totalPlants: snapAfter?.totalPlants ?? 0,
            availablePlants: snapAfter?.availablePlants ?? 0,
            plantsSowed: snapAfter?.plantsSowed ?? 0,
            totalBookedPlants: snapAfter?.totalBookedPlants ?? 0,
            excessivePlants: 0,
            inProgressCount: 0,
            actualPlants: 0,
            closingStock: 0,
          },
          previousTotalPlants: snapBefore?.totalPlants ?? 0,
          newTotalPlants: snapAfter?.totalPlants ?? 0,
          previousAvailablePlants: snapBefore?.availablePlants ?? 0,
          newAvailablePlants: snapAfter?.availablePlants ?? 0,
          bufferPercentage: 0,
          bufferAmount: 0,
          reason: log.reason || getSlotTrailActivityName(action),
          notes: log.reason || "",
          metadata: {
            transferType: "sowing",
            peerSlotId: peerId?.toString(),
            backfilledFromLog: true,
          },
          createdAt: log.createdAt,
          updatedAt: log.updatedAt,
          performedBy: log.performedBy
            ? {
                _id: log.performedBy._id,
                name: log.performedBy.name,
                phoneNumber: log.performedBy.phoneNumber,
              }
            : null,
          performedById: log.performedBy?._id || log.performedBy,
          orderId: null,
        });
      }

      if (types === "transfer") {
        trailResponse = [...synthesized, ...trailResponse].filter((entry) =>
          TRANSFER_TRAIL_ACTION_LIST.includes(entry.action)
        );
      } else {
        trailResponse = [...synthesized, ...trailResponse].sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
      }
    }

    const enrichedTrail = await enrichTrailEntriesWithOrderInfo(trailResponse);

    res.status(200).json({
      success: true,
      data: enrichedTrail,
      primarySowingEntries,
      message:
        enrichedTrail.length > 0
          ? "Slot trail retrieved successfully"
          : "No trail entries found",
    });
    
  } catch (error) {
    console.error("Error getting slot trail:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error", 
      error: error.message 
    });
  }
};

export const getSlotTransferOptions = async (req, res) => {
  try {
    const { slotId } = req.query;
    const backDays = Number(req.query.backDays) || 4;
    const forwardDays = Number(req.query.forwardDays) || 10;

    if (!slotId) {
      return res.status(400).json({
        success: false,
        message: "slotId query parameter is required",
      });
    }

    const sourceDetails = await findSlotDetails(slotId);

    if (!sourceDetails) {
      return res.status(404).json({
        success: false,
        message: "Source slot not found",
      });
    }

    const sourceStart = moment(sourceDetails.slot.startDay, "DD-MM-YYYY", true);
    if (!sourceStart.isValid()) {
      return res.status(400).json({
        success: false,
        message: "Source slot start day is invalid",
      });
    }

    const backWindow = Number(backDays) || 0;
    const forwardWindow = Number(forwardDays) || 0;

    const minDate = sourceStart.clone().subtract(backWindow, "days").startOf("day");
    const maxDate = sourceStart.clone().add(forwardWindow, "days").endOf("day");

    const plantInfo = await PlantCms.findById(sourceDetails.plantId)
      .select("name subtypes")
      .lean();

    const subtypeNameMap = new Map(
      safeArray(plantInfo?.subtypes).map((subtype) => [subtype._id.toString(), subtype.name])
    );

    const plantSlots = await PlantSlot.find({ plantId: sourceDetails.plantId }).lean();
    const options = [];

    plantSlots.forEach((plantSlotDoc) => {
      safeArray(plantSlotDoc.subtypeSlots).forEach((subtypeSlot) => {
        const subtypeIdStr = subtypeSlot.subtypeId.toString();
        const subtypeName = subtypeNameMap.get(subtypeIdStr) || "Subtype";

        safeArray(subtypeSlot.slots).forEach((slot) => {
          if (slot._id?.toString() === slotId) {
            return;
          }

          const slotStart = moment(slot.startDay, "DD-MM-YYYY", true);
          if (!slotStart.isValid()) {
            return;
          }

          if (slotStart.isBefore(minDate) || slotStart.isAfter(maxDate)) {
            return;
          }

          const gap = (Number(slot.totalBookedPlants) || 0) - (Number(slot.primarySowed) || 0);
          if (gap <= 0) {
            return;
          }

          options.push({
            slotId: slot._id.toString(),
            plantSlotId: plantSlotDoc._id.toString(),
            subtypeId: subtypeIdStr,
            subtypeName,
            startDay: slot.startDay,
            endDay: slot.endDay,
            month: slot.month,
            year: plantSlotDoc.year,
            gap,
            primarySowed: Number(slot.primarySowed) || 0,
            totalBookedPlants: Number(slot.totalBookedPlants) || 0,
            daysDifference: slotStart.diff(sourceStart, "days"),
          });
        });
      });
    });

    options.sort((a, b) => {
      const diff = Math.abs(a.daysDifference) - Math.abs(b.daysDifference);
      if (diff !== 0) return diff;
      return b.gap - a.gap;
    });

    const sourceGap = (Number(sourceDetails.slot.totalBookedPlants) || 0) - (Number(sourceDetails.slot.primarySowed) || 0);
    const surplus = Math.max(0, (Number(sourceDetails.slot.primarySowed) || 0) - (Number(sourceDetails.slot.totalBookedPlants) || 0));

    return res.status(200).json({
      success: true,
      data: {
        source: {
          slotId: sourceDetails.slot._id.toString(),
          subtypeId: sourceDetails.subtypeId.toString(),
          subtypeName: subtypeNameMap.get(sourceDetails.subtypeId.toString()) || "Subtype",
          startDay: sourceDetails.slot.startDay,
          endDay: sourceDetails.slot.endDay,
          month: sourceDetails.slot.month,
          year: sourceDetails.plantSlotYear,
          totalBookedPlants: Number(sourceDetails.slot.totalBookedPlants) || 0,
          primarySowed: Number(sourceDetails.slot.primarySowed) || 0,
          gap: sourceGap,
          surplus,
        },
        options,
      },
    });
  } catch (error) {
    console.error("Error fetching transfer options:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transfer options",
      error: error.message,
    });
  }
};

export const transferSlotPlants = async (req, res) => {
  const session = await PlantSlot.startSession();

  try {
    const {
      sourceSlotId,
      targetSlotId,
      quantity,
      reason = "",
      backDays = 4,
      forwardDays = 10,
    } = req.body;

    if (!sourceSlotId || !targetSlotId || !quantity) {
      return res.status(400).json({
        success: false,
        message: "sourceSlotId, targetSlotId and quantity are required",
      });
    }

    if (sourceSlotId === targetSlotId) {
      return res.status(400).json({
        success: false,
        message: "Cannot transfer to the same slot",
      });
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a positive number",
      });
    }

    const [sourceDetails, targetDetails] = await Promise.all([
      findSlotDetails(sourceSlotId),
      findSlotDetails(targetSlotId),
    ]);

    if (!sourceDetails || !targetDetails) {
      return res.status(404).json({
        success: false,
        message: "Source or target slot not found",
      });
    }

    if (sourceDetails.plantId.toString() !== targetDetails.plantId.toString()) {
      return res.status(400).json({
        success: false,
        message: "Transfers are only allowed within the same plant",
      });
    }

    const plantInfo = await PlantCms.findById(sourceDetails.plantId)
      .select("name subtypes")
      .lean();
    const subtypeNameMap = new Map(
      safeArray(plantInfo?.subtypes).map((subtype) => [subtype._id.toString(), subtype.name])
    );

    const sourcePrimary = Number(sourceDetails.slot.primarySowed) || 0;
    const sourcePlantsSowed =
      Number(sourceDetails.slot.plantsSowed) ||
      sourcePrimary + (Number(sourceDetails.slot.officeSowed) || 0);
    const sourceBooked = Number(sourceDetails.slot.totalBookedPlants) || 0;
    const sourceGap = sourceBooked - sourcePrimary;

    if (sourceGap >= 0) {
      return res.status(400).json({
        success: false,
        message: "Transfer allowed only when source slot has surplus (negative gap)",
      });
    }

    const sourceSurplus = Math.min(sourcePrimary - sourceBooked, sourcePrimary);
    if (qty > sourceSurplus) {
      return res.status(400).json({
        success: false,
        message: `Maximum transferable quantity is ${sourceSurplus}`,
      });
    }

    const targetPrimary = Number(targetDetails.slot.primarySowed) || 0;
    const targetPlantsSowed =
      Number(targetDetails.slot.plantsSowed) ||
      targetPrimary + (Number(targetDetails.slot.officeSowed) || 0);
    const targetBooked = Number(targetDetails.slot.totalBookedPlants) || 0;
    const targetGap = targetBooked - targetPrimary;

    if (targetGap <= 0) {
      return res.status(400).json({
        success: false,
        message: "Target slot does not require additional plants",
      });
    }

    if (qty > targetGap) {
      return res.status(400).json({
        success: false,
        message: `Target slot can accept up to ${targetGap} plants`,
      });
    }

    const sourceStart = moment(sourceDetails.slot.startDay, "DD-MM-YYYY", true);
    const targetStart = moment(targetDetails.slot.startDay, "DD-MM-YYYY", true);

    if (!sourceStart.isValid() || !targetStart.isValid()) {
      return res.status(400).json({
        success: false,
        message: "Invalid slot start dates",
      });
    }

    const diffDays = targetStart.diff(sourceStart, "days");
    const allowedBack = Number(backDays) || 0;
    const allowedForward = Number(forwardDays) || 0;

    if (diffDays < -allowedBack || diffDays > allowedForward) {
      return res.status(400).json({
        success: false,
        message: `Target slot must be within ${allowedBack} days before and ${allowedForward} days after the source slot`,
      });
    }

    session.startTransaction();

    const updatedSourcePrimary = sourcePrimary - qty;
    const updatedSourcePlants = Math.max(0, sourcePlantsSowed - qty);
    const updatedTargetPrimary = targetPrimary + qty;
    const updatedTargetPlants = targetPlantsSowed + qty;

    await PlantSlot.updateOne(
      { _id: sourceDetails.plantSlotId },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].primarySowed": updatedSourcePrimary,
          "subtypeSlots.$[st].slots.$[sl].plantsSowed": updatedSourcePlants,
        },
      },
      {
        arrayFilters: [
          { "st.subtypeId": sourceDetails.subtypeId },
          { "sl._id": new mongoose.Types.ObjectId(sourceSlotId) },
        ],
        session,
      }
    );

    await PlantSlot.updateOne(
      { _id: targetDetails.plantSlotId },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].primarySowed": updatedTargetPrimary,
          "subtypeSlots.$[st].slots.$[sl].plantsSowed": updatedTargetPlants,
        },
      },
      {
        arrayFilters: [
          { "st.subtypeId": targetDetails.subtypeId },
          { "sl._id": new mongoose.Types.ObjectId(targetSlotId) },
        ],
        session,
      }
    );

    const performedBy = req.user?._id || null;
    const sourceBeforeSnap = buildSlotSnapshot({
      ...sourceDetails.slot,
      primarySowed: sourcePrimary,
      plantsSowed: sourcePlantsSowed,
    });
    const targetBeforeSnap = buildSlotSnapshot({
      ...targetDetails.slot,
      primarySowed: targetPrimary,
      plantsSowed: targetPlantsSowed,
    });
    const sourceAfterSnap = buildSlotSnapshot({
      ...sourceDetails.slot,
      primarySowed: updatedSourcePrimary,
      plantsSowed: updatedSourcePlants,
    });
    const targetAfterSnap = buildSlotSnapshot({
      ...targetDetails.slot,
      primarySowed: updatedTargetPrimary,
      plantsSowed: updatedTargetPlants,
    });

    const peerMeta = {
      transferType: "sowing",
      peerSlotId: targetSlotId,
      daysDifference: diffDays,
    };

    await appendTransferSlotTrail({
      slotId: sourceSlotId,
      action: SLOT_TRAIL_ACTIONS.SOWING_TRANSFER_OUT,
      quantity: qty,
      performedBy,
      notes: reason || `Sowing surplus transfer to ${targetDetails.slot.startDay}-${targetDetails.slot.endDay}`,
      reason: `Sowing surplus transferred to slot ${targetDetails.slot.startDay}-${targetDetails.slot.endDay}`,
      metadata: { ...peerMeta, peerSlotId: targetSlotId },
      before: sourceBeforeSnap,
      after: sourceAfterSnap,
      session,
    });

    await appendTransferSlotTrail({
      slotId: targetSlotId,
      action: SLOT_TRAIL_ACTIONS.SOWING_TRANSFER_IN,
      quantity: qty,
      performedBy,
      notes: reason || `Sowing surplus transfer from ${sourceDetails.slot.startDay}-${sourceDetails.slot.endDay}`,
      reason: `Sowing surplus received from slot ${sourceDetails.slot.startDay}-${sourceDetails.slot.endDay}`,
      metadata: { ...peerMeta, peerSlotId: sourceSlotId },
      before: targetBeforeSnap,
      after: targetAfterSnap,
      session,
    });

    await SlotTransferLog.create(
      [
        {
          transferType: "sowing",
          plantId: sourceDetails.plantId,
          plantName: plantInfo?.name || "",
          sourceSlotId: new mongoose.Types.ObjectId(sourceSlotId),
          sourceSubtypeId: sourceDetails.subtypeId,
          sourceSubtypeName: subtypeNameMap.get(sourceDetails.subtypeId.toString()) || "Subtype",
          targetSlotId: new mongoose.Types.ObjectId(targetSlotId),
          targetSubtypeId: targetDetails.subtypeId,
          targetSubtypeName: subtypeNameMap.get(targetDetails.subtypeId.toString()) || "Subtype",
          quantity: qty,
          reason,
          performedBy,
          sourceBefore: {
            primarySowed: sourcePrimary,
            plantsSowed: sourcePlantsSowed,
            officeSowed: Number(sourceDetails.slot.officeSowed) || 0,
            totalBookedPlants: sourceBooked,
          },
          sourceAfter: {
            primarySowed: updatedSourcePrimary,
            plantsSowed: updatedSourcePlants,
            officeSowed: Number(sourceDetails.slot.officeSowed) || 0,
            totalBookedPlants: sourceBooked,
          },
          targetBefore: {
            primarySowed: targetPrimary,
            plantsSowed: targetPlantsSowed,
            officeSowed: Number(targetDetails.slot.officeSowed) || 0,
            totalBookedPlants: targetBooked,
          },
          targetAfter: {
            primarySowed: updatedTargetPrimary,
            plantsSowed: updatedTargetPlants,
            officeSowed: Number(targetDetails.slot.officeSowed) || 0,
            totalBookedPlants: targetBooked,
          },
          metadata: {
            sourceSlotStartDay: sourceDetails.slot.startDay,
            sourceSlotEndDay: sourceDetails.slot.endDay,
            targetSlotStartDay: targetDetails.slot.startDay,
            targetSlotEndDay: targetDetails.slot.endDay,
            daysDifference: diffDays,
          },
        },
      ],
      { session }
    );

    await session.commitTransaction();

    return res.status(200).json({
      success: true,
      message: "Plants transferred successfully",
      data: {
        quantity: qty,
        source: {
          slotId: sourceSlotId,
          primarySowed: updatedSourcePrimary,
          gap: sourceBooked - updatedSourcePrimary,
        },
        target: {
          slotId: targetSlotId,
          primarySowed: updatedTargetPrimary,
          gap: targetBooked - updatedTargetPrimary,
        },
      },
    });
  } catch (error) {
    console.error("Error transferring plants between slots:", error);
    await session.abortTransaction();
    return res.status(500).json({
      success: false,
      message: "Failed to transfer plants",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

// ========== Capacity Transfer (SlotsView) ==========
export const getTransferCapacityOptions = async (req, res) => {
  try {
    const { slotId } = req.query;
    const backDays = Number(req.query.backDays) || 14;
    const forwardDays = Number(req.query.forwardDays) || 14;

    if (!slotId) {
      return res.status(400).json({
        success: false,
        message: "slotId query parameter is required",
      });
    }

    const sourceDetails = await findSlotDetails(slotId);
    if (!sourceDetails) {
      return res.status(404).json({
        success: false,
        message: "Source slot not found",
      });
    }

    const sourceAvailable = getSlotEffectiveAvailablePlants(sourceDetails.slot);
    if (sourceAvailable <= 0) {
      return res.status(400).json({
        success: false,
        message: "Source slot has no available plants to transfer",
      });
    }

    const sourceStart = moment(sourceDetails.slot.startDay, "DD-MM-YYYY", true);
    if (!sourceStart.isValid()) {
      return res.status(400).json({
        success: false,
        message: "Source slot start day is invalid",
      });
    }

    const minDate = sourceStart.clone().subtract(backDays, "days").startOf("day");
    const maxDate = sourceStart.clone().add(forwardDays, "days").endOf("day");

    const plantInfo = await PlantCms.findById(sourceDetails.plantId).select("name subtypes").lean();
    const subtypeNameMap = new Map(
      safeArray(plantInfo?.subtypes).map((s) => [s._id.toString(), s.name])
    );

    const plantSlots = await PlantSlot.find({ plantId: sourceDetails.plantId }).lean();
    const options = [];
    const targetSlotIds = [];

    plantSlots.forEach((plantSlotDoc) => {
      safeArray(plantSlotDoc.subtypeSlots).forEach((subtypeSlot) => {
        if (subtypeSlot.subtypeId.toString() !== sourceDetails.subtypeId.toString()) return;
        safeArray(subtypeSlot.slots).forEach((slot) => {
          if (slot._id?.toString() === slotId) return;
          const slotStart = moment(slot.startDay, "DD-MM-YYYY", true);
          if (!slotStart.isValid()) return;
          if (slotStart.isBefore(minDate) || slotStart.isAfter(maxDate)) return;
          targetSlotIds.push(slot._id);
        });
      });
    });

    const bookingsMap = {};
    if (targetSlotIds.length > 0) {
      const ordersAgg = await Order.aggregate([
        {
          $match: {
            bookingSlot: { $in: targetSlotIds },
            orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
            $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
          },
        },
        { $group: { _id: "$bookingSlot", totalBookedPlants: { $sum: "$numberOfPlants" } } },
      ]);
      ordersAgg.forEach((r) => {
        bookingsMap[r._id.toString()] = r.totalBookedPlants || 0;
      });
    }

    plantSlots.forEach((plantSlotDoc) => {
      safeArray(plantSlotDoc.subtypeSlots).forEach((subtypeSlot) => {
        if (subtypeSlot.subtypeId.toString() !== sourceDetails.subtypeId.toString()) return;
        safeArray(subtypeSlot.slots).forEach((slot) => {
          if (slot._id?.toString() === slotId) return;
          const slotStart = moment(slot.startDay, "DD-MM-YYYY", true);
          if (!slotStart.isValid()) return;
          if (slotStart.isBefore(minDate) || slotStart.isAfter(maxDate)) return;

          const totalPlants = Number(slot.totalPlants) || 0;
          const totalBooked = bookingsMap[slot._id.toString()] || 0;
          const bufferAmount = Number(slot.bufferAmount) || 0;
          const effectiveAvailable = Math.max(0, totalPlants - totalBooked - bufferAmount);

          options.push({
            slotId: slot._id.toString(),
            plantSlotId: plantSlotDoc._id.toString(),
            subtypeId: subtypeSlot.subtypeId.toString(),
            subtypeName: subtypeNameMap.get(subtypeSlot.subtypeId.toString()) || "Subtype",
            startDay: slot.startDay,
            endDay: slot.endDay,
            month: slot.month,
            year: plantSlotDoc.year,
            availableCapacity: effectiveAvailable,
            daysDifference: moment(slot.startDay, "DD-MM-YYYY").diff(sourceStart, "days"),
          });
        });
      });
    });

    options.sort((a, b) => Math.abs(a.daysDifference) - Math.abs(b.daysDifference));

    return res.status(200).json({
      success: true,
      data: {
        source: {
          slotId: sourceDetails.slot._id.toString(),
          subtypeId: sourceDetails.subtypeId.toString(),
          subtypeName: subtypeNameMap.get(sourceDetails.subtypeId.toString()) || "Subtype",
          startDay: sourceDetails.slot.startDay,
          endDay: sourceDetails.slot.endDay,
          month: sourceDetails.slot.month,
          year: sourceDetails.plantSlotYear,
          availablePlants: sourceAvailable,
        },
        options,
      },
    });
  } catch (error) {
    console.error("Error fetching transfer capacity options:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transfer options",
      error: error.message,
    });
  }
};

const endSessionSafe = async (session, abort = false) => {
  try {
    if (abort && session.inTransaction()) await session.abortTransaction();
  } catch (e) {
    console.error("Session abort error:", e);
  }
  try {
    await session.endSession();
  } catch (e) {
    console.error("Session end error:", e);
  }
};

export const transferCapacity = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  const sendError = async (status, message, abort = true) => {
    await endSessionSafe(session, abort);
    return res.status(status).json({ success: false, message });
  };

  try {
    const { sourceSlotId, targetSlotId, quantity, reason = "" } = req.body;

    if (!sourceSlotId || !targetSlotId || !quantity) {
      return await sendError(400, "sourceSlotId, targetSlotId and quantity are required");
    }

    if (sourceSlotId === targetSlotId) {
      return await sendError(400, "Cannot transfer to the same slot");
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return await sendError(400, "Quantity must be a positive number");
    }

    const [sourceDetails, targetDetails] = await Promise.all([
      findSlotDetails(sourceSlotId),
      findSlotDetails(targetSlotId),
    ]);

    if (!sourceDetails || !targetDetails) {
      return await sendError(404, "Source or target slot not found");
    }

    if (sourceDetails.plantId.toString() !== targetDetails.plantId.toString()) {
      return await sendError(400, "Transfers are only allowed within the same plant");
    }

    if (sourceDetails.subtypeId.toString() !== targetDetails.subtypeId.toString()) {
      return await sendError(400, "Transfers are only allowed within the same subtype");
    }

    const sourceTotal = Number(sourceDetails.slot.totalPlants) || 0;
    const sourceAvailable = getSlotEffectiveAvailablePlants(sourceDetails.slot);
    const sourceBooked = Number(sourceDetails.slot.totalBookedPlants) || 0;
    const sourceBuffer = Number(sourceDetails.slot.effectiveBuffer || sourceDetails.slot.buffer) || 0;
    const sourceBufferAmount = Number(sourceDetails.slot.bufferAmount) || 0;

    if (qty > sourceAvailable) {
      return await sendError(400, `Maximum transferable quantity is ${sourceAvailable}`);
    }

    const targetTotal = Number(targetDetails.slot.totalPlants) || 0;
    const targetBooked = Number(targetDetails.slot.totalBookedPlants) || 0;
    const targetBufferAmount = Number(targetDetails.slot.bufferAmount) || 0;

    // Transfer: only available plants move. Buffer is unchanged (manual apply/release only).
    const newSourceTotal = sourceTotal - qty;
    const newSourceAvailable = Math.max(0, newSourceTotal - sourceBooked - sourceBufferAmount);

    const newTargetTotal = targetTotal + qty;
    const newTargetAvailable = Math.max(0, newTargetTotal - targetBooked - targetBufferAmount);

    const plantInfo = await PlantCms.findById(sourceDetails.plantId).select("name subtypes").lean();
    const subtypeNameMap = new Map(
      safeArray(plantInfo?.subtypes).map((s) => [s._id.toString(), s.name])
    );

    const sourceSubtypeOid = new mongoose.Types.ObjectId(sourceDetails.subtypeId.toString());
    const targetSubtypeOid = new mongoose.Types.ObjectId(targetDetails.subtypeId.toString());
    const sourceSlotOid = new mongoose.Types.ObjectId(sourceSlotId);
    const targetSlotOid = new mongoose.Types.ObjectId(targetSlotId);

    const updateSourceResult = await PlantSlot.updateOne(
      { _id: sourceDetails.plantSlotId },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].totalPlants": newSourceTotal,
          "subtypeSlots.$[st].slots.$[sl].availablePlants": newSourceAvailable,
        },
      },
      {
        arrayFilters: [
          { "st.subtypeId": sourceSubtypeOid },
          { "sl._id": sourceSlotOid },
        ],
        session,
      }
    );

    if (updateSourceResult.matchedCount === 0 || updateSourceResult.modifiedCount === 0) {
      throw new Error("Source slot update failed: slot or subtype not found");
    }

    const updateTargetResult = await PlantSlot.updateOne(
      { _id: targetDetails.plantSlotId },
      {
        $set: {
          "subtypeSlots.$[st].slots.$[sl].totalPlants": newTargetTotal,
          "subtypeSlots.$[st].slots.$[sl].availablePlants": newTargetAvailable,
        },
      },
      {
        arrayFilters: [
          { "st.subtypeId": targetSubtypeOid },
          { "sl._id": targetSlotOid },
        ],
        session,
      }
    );

    if (updateTargetResult.matchedCount === 0 || updateTargetResult.modifiedCount === 0) {
      throw new Error("Target slot update failed: slot or subtype not found");
    }

    const performedBy = req.user?._id || null;
    const sourceBeforeCap = buildSlotSnapshot({
      ...sourceDetails.slot,
      totalPlants: sourceTotal,
      availablePlants: sourceAvailable,
    });
    const sourceAfterCap = buildSlotSnapshot({
      ...sourceDetails.slot,
      totalPlants: newSourceTotal,
      availablePlants: newSourceAvailable,
    });
    const targetBeforeCap = buildSlotSnapshot({
      ...targetDetails.slot,
      totalPlants: targetTotal,
      availablePlants: Number(targetDetails.slot.availablePlants) ?? 0,
    });
    const targetAfterCap = buildSlotSnapshot({
      ...targetDetails.slot,
      totalPlants: newTargetTotal,
      availablePlants: newTargetAvailable,
    });

    await appendTransferSlotTrail({
      slotId: sourceSlotId,
      action: SLOT_TRAIL_ACTIONS.CAPACITY_TRANSFER_OUT,
      quantity: qty,
      performedBy,
      notes: reason || "Capacity transfer from SlotsView",
      reason: `Capacity transferred to slot ${targetDetails.slot.startDay}-${targetDetails.slot.endDay}`,
      metadata: { transferType: "capacity", peerSlotId: targetSlotId },
      before: sourceBeforeCap,
      after: sourceAfterCap,
      bufferPercentage: sourceBuffer,
      bufferAmount: sourceBufferAmount,
      session,
    });

    await appendTransferSlotTrail({
      slotId: targetSlotId,
      action: SLOT_TRAIL_ACTIONS.CAPACITY_TRANSFER_IN,
      quantity: qty,
      performedBy,
      notes: reason || "Capacity transfer from SlotsView",
      reason: `Capacity received from slot ${sourceDetails.slot.startDay}-${sourceDetails.slot.endDay}`,
      metadata: { transferType: "capacity", peerSlotId: sourceSlotId },
      before: targetBeforeCap,
      after: targetAfterCap,
      bufferPercentage: Number(targetDetails.slot.effectiveBuffer || targetDetails.slot.buffer) || 0,
      bufferAmount: targetBufferAmount,
      session,
    });

    await SlotTransferLog.create(
      [
        {
          transferType: "capacity",
          plantId: sourceDetails.plantId,
          plantName: plantInfo?.name || "",
          sourceSlotId: new mongoose.Types.ObjectId(sourceSlotId),
          sourceSubtypeId: sourceDetails.subtypeId,
          sourceSubtypeName: subtypeNameMap.get(sourceDetails.subtypeId.toString()) || "Subtype",
          targetSlotId: new mongoose.Types.ObjectId(targetSlotId),
          targetSubtypeId: targetDetails.subtypeId,
          targetSubtypeName: subtypeNameMap.get(targetDetails.subtypeId.toString()) || "Subtype",
          quantity: qty,
          reason,
          performedBy: req.user?._id || null,
          sourceBefore: {
            primarySowed: Number(sourceDetails.slot.primarySowed) || 0,
            plantsSowed: Number(sourceDetails.slot.plantsSowed) || 0,
            officeSowed: Number(sourceDetails.slot.officeSowed) || 0,
            totalBookedPlants: sourceBooked,
            totalPlants: sourceTotal,
            availablePlants: sourceAvailable,
          },
          sourceAfter: {
            primarySowed: Number(sourceDetails.slot.primarySowed) || 0,
            plantsSowed: Number(sourceDetails.slot.plantsSowed) || 0,
            officeSowed: Number(sourceDetails.slot.officeSowed) || 0,
            totalBookedPlants: sourceBooked,
            totalPlants: newSourceTotal,
            availablePlants: newSourceAvailable,
          },
          targetBefore: {
            primarySowed: Number(targetDetails.slot.primarySowed) || 0,
            plantsSowed: Number(targetDetails.slot.plantsSowed) || 0,
            officeSowed: Number(targetDetails.slot.officeSowed) || 0,
            totalBookedPlants: targetBooked,
            totalPlants: targetTotal,
            availablePlants: Number(targetDetails.slot.availablePlants) ?? 0,
          },
          targetAfter: {
            primarySowed: Number(targetDetails.slot.primarySowed) || 0,
            plantsSowed: Number(targetDetails.slot.plantsSowed) || 0,
            officeSowed: Number(targetDetails.slot.officeSowed) || 0,
            totalBookedPlants: targetBooked,
            totalPlants: newTargetTotal,
            availablePlants: newTargetAvailable,
          },
          metadata: {
            sourceSlotStartDay: sourceDetails.slot.startDay,
            sourceSlotEndDay: sourceDetails.slot.endDay,
            targetSlotStartDay: targetDetails.slot.startDay,
            targetSlotEndDay: targetDetails.slot.endDay,
            daysDifference: moment(targetDetails.slot.startDay, "DD-MM-YYYY").diff(moment(sourceDetails.slot.startDay, "DD-MM-YYYY"), "days"),
          },
        },
      ],
      { session }
    );

    await session.commitTransaction();
    await endSessionSafe(session, false);

    return res.status(200).json({
      success: true,
      message: "Capacity transferred successfully",
      data: {
        quantity: qty,
        source: { slotId: sourceSlotId, totalPlants: newSourceTotal, availablePlants: newSourceAvailable },
        target: { slotId: targetSlotId, totalPlants: newTargetTotal, availablePlants: newTargetAvailable },
      },
    });
  } catch (error) {
    console.error("Error transferring capacity:", error);
    await endSessionSafe(session, true);
    const errMsg = error?.message || "Unknown error";
    return res.status(500).json({
      success: false,
      message: "Failed to transfer capacity",
      error: errMsg,
    });
  }
};

// ========== Mass Order Transfer (SlotsView) ==========
export const getOrdersTransferTargets = async (req, res) => {
  try {
    const { slotId } = req.query;
    const backDays = Number(req.query.backDays) || 14;
    const forwardDays = Number(req.query.forwardDays) || 14;

    if (!slotId) {
      return res.status(400).json({
        success: false,
        message: "slotId query parameter is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(slotId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid slotId",
      });
    }

    const sourceDetails = await findSlotDetails(slotId);
    if (!sourceDetails) {
      return res.status(404).json({
        success: false,
        message: "Source slot not found",
      });
    }

    const orders = await Order.find({
      bookingSlot: new mongoose.Types.ObjectId(slotId),
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
      $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
    })
      .select("_id orderId numberOfPlants farmer")
      .populate({ path: "farmer", select: "name mobileNumber" })
      .lean();

    const totalPlantsToTransfer = orders.reduce((sum, o) => sum + (Number(o.numberOfPlants) || 0), 0);
    if (totalPlantsToTransfer <= 0 || orders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Source slot has no orders to transfer",
      });
    }

    const sourceStart = moment(sourceDetails.slot.startDay, "DD-MM-YYYY", true);
    if (!sourceStart.isValid()) {
      return res.status(400).json({
        success: false,
        message: "Source slot start day is invalid",
      });
    }

    const minDate = sourceStart.clone().subtract(backDays, "days").startOf("day");
    const maxDate = sourceStart.clone().add(forwardDays, "days").endOf("day");

    const plantInfo = await PlantCms.findById(sourceDetails.plantId).select("name subtypes").lean();
    const subtypeNameMap = new Map(
      safeArray(plantInfo?.subtypes).map((s) => [s._id.toString(), s.name])
    );

    const plantSlots = await PlantSlot.find({ plantId: sourceDetails.plantId }).lean();
    const options = [];
    const targetSlotIds = [];

    plantSlots.forEach((plantSlotDoc) => {
      safeArray(plantSlotDoc.subtypeSlots).forEach((subtypeSlot) => {
        if (subtypeSlot.subtypeId.toString() !== sourceDetails.subtypeId.toString()) return;
        safeArray(subtypeSlot.slots).forEach((slot) => {
          if (slot._id?.toString() === slotId) return;
          const slotStart = moment(slot.startDay, "DD-MM-YYYY", true);
          if (!slotStart.isValid()) return;
          if (slotStart.isBefore(minDate) || slotStart.isAfter(maxDate)) return;
          targetSlotIds.push(slot._id);
        });
      });
    });

    const bookingsMap = {};
    if (targetSlotIds.length > 0) {
      const ordersAgg = await Order.aggregate([
        {
          $match: {
            bookingSlot: { $in: targetSlotIds },
            orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
            $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
          },
        },
        { $group: { _id: "$bookingSlot", totalBookedPlants: { $sum: "$numberOfPlants" } } },
      ]);
      ordersAgg.forEach((r) => {
        bookingsMap[r._id.toString()] = r.totalBookedPlants || 0;
      });
    }

    plantSlots.forEach((plantSlotDoc) => {
      safeArray(plantSlotDoc.subtypeSlots).forEach((subtypeSlot) => {
        if (subtypeSlot.subtypeId.toString() !== sourceDetails.subtypeId.toString()) return;
        safeArray(subtypeSlot.slots).forEach((slot) => {
          if (slot._id?.toString() === slotId) return;
          const slotStart = moment(slot.startDay, "DD-MM-YYYY", true);
          if (!slotStart.isValid()) return;
          if (slotStart.isBefore(minDate) || slotStart.isAfter(maxDate)) return;

          const totalPlants = Number(slot.totalPlants) || 0;
          const totalBooked = bookingsMap[slot._id.toString()] || 0;
          const bufferAmount = Number(slot.bufferAmount) || 0;
          const effectiveAvailable = totalPlants - totalBooked - bufferAmount;

          options.push({
            slotId: slot._id.toString(),
            plantSlotId: plantSlotDoc._id.toString(),
            subtypeId: subtypeSlot.subtypeId.toString(),
            subtypeName: subtypeNameMap.get(subtypeSlot.subtypeId.toString()) || "Subtype",
            startDay: slot.startDay,
            endDay: slot.endDay,
            month: slot.month,
            year: plantSlotDoc.year,
            availableCapacity: effectiveAvailable,
            isOverflow: effectiveAvailable < 0,
            daysDifference: moment(slot.startDay, "DD-MM-YYYY").diff(sourceStart, "days"),
          });
        });
      });
    });

    options.sort((a, b) => Math.abs(a.daysDifference) - Math.abs(b.daysDifference));

    return res.status(200).json({
      success: true,
      data: {
        source: {
          slotId: sourceDetails.slot._id.toString(),
          subtypeId: sourceDetails.subtypeId.toString(),
          subtypeName: subtypeNameMap.get(sourceDetails.subtypeId.toString()) || "Subtype",
          startDay: sourceDetails.slot.startDay,
          endDay: sourceDetails.slot.endDay,
          month: sourceDetails.slot.month,
          year: sourceDetails.plantSlotYear,
          ordersCount: orders.length,
          totalPlantsToTransfer,
        },
        orders: orders.map((order) => ({
          _id: order._id?.toString(),
          orderId: order.orderId ?? "",
          numberOfPlants: Number(order.numberOfPlants) || 0,
          farmerName: order.farmer?.name || "",
          farmerMobileNumber: order.farmer?.mobileNumber || "",
        })),
        options,
      },
    });
  } catch (error) {
    console.error("Error fetching order transfer targets:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch order transfer targets",
      error: error.message,
    });
  }
};

export const transferOrders = async (req, res) => {
  try {
    const { sourceSlotId, targetSlotId, orderIds, reason = "" } = req.body;

    if (!sourceSlotId || !targetSlotId) {
      return res.status(400).json({
        success: false,
        message: "sourceSlotId and targetSlotId are required",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(sourceSlotId) ||
      !mongoose.Types.ObjectId.isValid(targetSlotId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid sourceSlotId or targetSlotId",
      });
    }

    if (sourceSlotId === targetSlotId) {
      return res.status(400).json({
        success: false,
        message: "Cannot transfer to the same slot",
      });
    }

    if (orderIds !== undefined && !Array.isArray(orderIds)) {
      return res.status(400).json({
        success: false,
        message: "orderIds must be an array when provided",
      });
    }

    const [sourceDetails, targetDetails] = await Promise.all([
      findSlotDetails(sourceSlotId),
      findSlotDetails(targetSlotId),
    ]);

    if (!sourceDetails || !targetDetails) {
      return res.status(404).json({
        success: false,
        message: "Source or target slot not found",
      });
    }

    if (sourceDetails.plantId.toString() !== targetDetails.plantId.toString()) {
      return res.status(400).json({
        success: false,
        message: "Transfers are only allowed within the same plant",
      });
    }

    if (sourceDetails.subtypeId.toString() !== targetDetails.subtypeId.toString()) {
      return res.status(400).json({
        success: false,
        message: "Transfers are only allowed within the same subtype",
      });
    }

    const orderFilter = {
      bookingSlot: new mongoose.Types.ObjectId(sourceSlotId),
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
      $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }],
    };

    let uniqueOrderIds = [];
    if (Array.isArray(orderIds) && orderIds.length > 0) {
      const invalidOrderId = orderIds.find((id) => !mongoose.Types.ObjectId.isValid(id));
      if (invalidOrderId) {
        return res.status(400).json({
          success: false,
          message: "orderIds contains an invalid order id",
        });
      }
      uniqueOrderIds = [...new Set(orderIds.map((id) => String(id)))];
      orderFilter._id = { $in: uniqueOrderIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    let skippedDealerQuota = 0;
    if (Array.isArray(orderIds) && uniqueOrderIds.length > 0) {
      const dealerSkipped = await Order.countDocuments({
        _id: { $in: uniqueOrderIds.map((id) => new mongoose.Types.ObjectId(id)) },
        bookingSlot: new mongoose.Types.ObjectId(sourceSlotId),
        orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
        quotaSource: "dealer",
      });
      skippedDealerQuota = dealerSkipped;
    }

    const orders = await Order.find(orderFilter)
      .select(
        "_id orderId numberOfPlants productMappingId productName dispatchedFromAnotherSlot originalBookingSlot bookingSlot"
      )
      .lean();
    const totalPlantsToTransfer = orders.reduce((sum, o) => sum + (Number(o.numberOfPlants) || 0), 0);

    if (orders.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          skippedDealerQuota > 0
            ? `No transferable orders found (${skippedDealerQuota} dealer-quota order(s) excluded)`
            : "No orders found to transfer",
      });
    }

    const plantInfo = await PlantCms.findById(sourceDetails.plantId).select("name subtypes").lean();
    const subtypeNameMap = new Map(
      safeArray(plantInfo?.subtypes).map((s) => [s._id.toString(), s.name])
    );

    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const performedBy = req.user?._id || null;

      const transferResult = await executeMassOrderSlotTransfer({
        sourceSlotId,
        targetSlotId,
        orders,
        sourceDetails,
        targetDetails,
        plantInfo,
        subtypeNameMap,
        reason,
        performedBy,
        session,
      });

      await session.commitTransaction();

      const responseData = {
        ordersCount: transferResult.ordersCount,
        totalPlants: transferResult.totalPlants,
        source: transferResult.source || { slotId: sourceSlotId },
        target: transferResult.target || { slotId: targetSlotId },
      };
      if (skippedDealerQuota > 0) {
        responseData.skippedDealerQuota = skippedDealerQuota;
      }

      return res.status(200).json({
        success: true,
        message:
          skippedDealerQuota > 0
            ? `Transferred ${transferResult.ordersCount} order(s); ${skippedDealerQuota} dealer-quota order(s) were skipped`
            : "Orders transferred successfully",
        data: responseData,
      });
    } catch (innerErr) {
      await session.abortTransaction();
      throw innerErr;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Error transferring orders:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to transfer orders",
      error: error.message,
    });
  }
};

// New simplified function to get only slot dates
// OPTIMIZED endpoint for sowing - returns ALL required fields FAST
export const getSimpleSlots = async (req, res) => {
  try {
    const { plantId, subtypeId, year } = req.query;

    console.log('\n📊 getSimpleSlots called with:', { plantId, subtypeId, year });

    if (!plantId || !subtypeId || !year) {
      return res.status(400).json({
        success: false,
        message: "plantId, subtypeId, and year are required"
      });
    }

    const query = {
      plantId: new mongoose.Types.ObjectId(plantId),
      year: Number(year),
      "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId)
    };

    console.log('🔍 Query:', JSON.stringify(query, null, 2));

    // FAST query with lean() - no Mongoose overhead
    // Include orders to calculate totalBookedPlants
    const result = await PlantSlot.findOne(query)
      .select('subtypeSlots')
      .lean();

    console.log('📦 Query result:', result ? `Found document with ${result.subtypeSlots?.length} subtypeSlots` : 'No document found');

    if (!result) {
      console.log('❌ No PlantSlot document found for query');
      return res.status(200).json({
        success: true,
        data: { year: Number(year), slots: [], total_available: 0 },
        message: "No slots found"
      });
    }

    // Find the specific subtype
    console.log('📋 All subtypeIds in document:',
      result.subtypeSlots.map(s => s.subtypeId.toString())
    );
    console.log('🔎 Looking for subtypeId:', subtypeId);
    
    const subtypeSlot = result.subtypeSlots.find(
      s => s.subtypeId.toString() === subtypeId
    );

    console.log('🎯 Found subtype slot:', subtypeSlot ? `Yes, with ${subtypeSlot.slots?.length} slots` : 'No');

    if (!subtypeSlot || !subtypeSlot.slots) {
      console.log('❌ No slots found for subtype');
      console.log('   Available subtypes:', result.subtypeSlots.map(s => ({
        id: s.subtypeId.toString(),
        slotsCount: s.slots?.length || 0
      })));
      return res.status(200).json({
        success: true,
        data: { year: Number(year), slots: [], total_available: 0 },
        message: "No slots found for subtype"
      });
    }

    console.log(`✅ Returning ${subtypeSlot.slots.length} slots for subtype\n`);

    // Map to simplified structure - ALWAYS include all fields
    // Return ALL slots for the year for month-wise grouping in UI
    
    // Get slot IDs for querying orders
    const slotIds = subtypeSlot.slots.map(s => s._id);
    
    // Fetch orders for all slots in one query (FAST)
    // Include COMPLETED orders in booked plants - only exclude CANCELLED and REJECTED
    const orders = await Order.find({
      bookingSlot: { $in: slotIds },
      orderStatus: { $nin: ["CANCELLED", "REJECTED"] } // COMPLETED orders count in booked
    }).select('bookingSlot numberOfPlants orderStatus').lean();
    
    // Create a map of slotId → totalBookedPlants
    const bookingsMap = {};
    orders.forEach(order => {
      const slotId = order.bookingSlot.toString();
      bookingsMap[slotId] = (bookingsMap[slotId] || 0) + (Number(order.numberOfPlants) || 0);
    });
    
    // Return ALL active slots for the year (for month-wise grouping in UI)
    console.log('🔧 Before filter - Total slots:', subtypeSlot.slots.length);
    console.log('🔧 Sample slot status values:', subtypeSlot.slots.slice(0, 3).map(s => ({ 
      _id: s._id, 
      status: s.status, 
      statusType: typeof s.status 
    })));
    
    const simplifiedSlots = subtypeSlot.slots
      .filter(slot => slot.status !== false) // Only filter out inactive slots
      .map(slot => {
        const actualBookings = bookingsMap[slot._id.toString()] || 0;
        const primarySowed = Number(slot.primarySowed) || 0;
        const plantReadyDays = Number(slot.plantReadyDays) || 0;
        
        return {
          _id: slot._id,
          startDay: slot.startDay || "",
          endDay: slot.endDay || "",
          month: slot.month || "",
          totalPlants: Number(slot.totalPlants) || 0, // Total capacity
          totalBookedPlants: actualBookings, // Use calculated value from orders
          plantsSowed: Number(slot.plantsSowed) || 0,
          officeSowed: Number(slot.officeSowed) || 0,
          primarySowed: primarySowed,
          plantReadyDays,
          // Gap = booked plants - primary sowed (not booked - total capacity)
          gap: actualBookings - primarySowed,
          availablePlants: Number(slot.availablePlants || slot.totalPlants) || 0,
          status: slot.status !== false,
          isManual: Boolean(slot.isManual),
          // Include productStock for products ordered from other nurseries
          productStock: (slot.productStock || []).map(ps => ({
            productName: ps.productName,
            available: Number(ps.available || 0),
            booked: Number(ps.booked || 0),
            poQuantity: Number(ps.poQuantity || 0),
            received: Boolean(ps.received || false)
          }))
        };
      });

    console.log('🔧 After filter - Simplified slots count:', simplifiedSlots.length);
    if (simplifiedSlots.length === 0 && subtypeSlot.slots.length > 0) {
      console.log('⚠️  All slots were filtered out due to status field!');
    }

    res.status(200).json({
      success: true,
      data: {
        year: Number(year),
        slots: simplifiedSlots,
        total_available: simplifiedSlots.reduce((sum, slot) => sum + slot.availablePlants, 0)
      },
      message: "Slots retrieved successfully"
    });

  } catch (error) {
    console.error("Error in getSimpleSlots:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

/** All plants × subtypes × slots for dashboard Available Stock tab (central report engine). */
export const getAvailabilityOverview = async (req, res) => {
  try {
    const { year: yearParam, month, plantId, search, onlyAvailable } = req.query;
    const result = await fetchSlotAvailabilityReport(null, null, {
      year: Number(yearParam) || 2026,
      month,
      plantId,
      search,
      onlyAvailable,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      message: "Availability overview retrieved successfully",
    });
  } catch (error) {
    console.error("Error in getAvailabilityOverview:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

function canRunPastDueSlotRollover(user) {
  const role = String(user?.role || user?.jobTitle || "").toUpperCase();
  return ["SUPER_ADMIN", "SUPERADMIN", "OFFICE_ADMIN", "ADMIN"].includes(role);
}

/** POST /slots/past-due-rollover/run — manual past-due slot rollover (admin). */
export const runPastDueSlotRolloverController = async (req, res) => {
  try {
    if (!canRunPastDueSlotRollover(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only SUPER_ADMIN or OFFICE_ADMIN may run past-due slot rollover",
      });
    }

    const dryRun =
      req.body?.dryRun === true ||
      String(req.query?.dryRun || "").toLowerCase() === "true";
    const asOfRaw = req.body?.asOfDate || req.query?.asOfDate;
    const asOfDate = asOfRaw ? new Date(asOfRaw) : undefined;

    const plantId = req.body?.plantId || req.query?.plantId;
    const subtypeId = req.body?.subtypeId || req.query?.subtypeId;
    const summary = await runPastDueSlotRollover({
      asOfDate,
      dryRun,
      plantId: plantId ? String(plantId) : undefined,
      subtypeId: subtypeId ? String(subtypeId) : undefined,
    });

    return res.status(200).json({
      success: true,
      message: dryRun
        ? "Past-due slot rollover dry-run completed"
        : "Past-due slot rollover completed",
      data: summary,
    });
  } catch (error) {
    console.error("Error in runPastDueSlotRolloverController:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Past-due slot rollover failed",
    });
  }
};

/** GET /slots/roll-expired-available/sources */
export const getRollExpiredAvailableSources = async (req, res) => {
  try {
    if (!canRunPastDueSlotRollover(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only admins may roll expired slot available",
      });
    }

    const { targetSlotId } = req.query;
    if (!targetSlotId) {
      return res.status(400).json({ success: false, message: "targetSlotId is required" });
    }

    const asOfRaw = req.query?.asOfDate;
    const asOfDate = asOfRaw ? new Date(asOfRaw) : undefined;
    const data = await listRollExpiredAvailableSources(targetSlotId, asOfDate);

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("getRollExpiredAvailableSources:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to load expired slot sources",
    });
  }
};

/** POST /slots/roll-expired-available */
export const postRollExpiredAvailable = async (req, res) => {
  try {
    if (!canRunPastDueSlotRollover(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only admins may roll expired slot available",
      });
    }

    const { targetSlotId, transfers, reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: "reason is required" });
    }

    const asOfRaw = req.body?.asOfDate;
    const asOfDate = asOfRaw ? new Date(asOfRaw) : undefined;

    const data = await runRollExpiredSlotAvailable({
      targetSlotId,
      transfers,
      reason: String(reason).trim(),
      performedBy: req.user?._id || null,
      asOfDate,
    });

    return res.status(200).json({
      success: true,
      message: "Expired slot available rolled successfully",
      data,
    });
  } catch (error) {
    console.error("postRollExpiredAvailable:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Roll expired available failed",
    });
  }
};

/** GET /slots/:slotId/order-dispatch-by-batch */
export const getSlotOrderDispatchByBatchHandler = async (req, res) => {
  try {
    const { slotId } = req.params;
    if (!slotId) {
      return res.status(400).json({ success: false, message: "slotId is required" });
    }
    const data = await getSlotOrderDispatchByBatch(slotId);
    if (!data) {
      return res.status(404).json({ success: false, message: "Slot not found or invalid id" });
    }
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("getSlotOrderDispatchByBatch:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to load order dispatch by batch",
    });
  }
};

/** GET /slots/:slotId/ready-roll-log */
export const getSlotReadyRollLog = async (req, res) => {
  try {
    const { slotId } = req.params;
    if (!slotId) {
      return res.status(400).json({ success: false, message: "slotId is required" });
    }
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 100));
    const entries = await listReadyRollLogForSlot(slotId, { limit });
    const summary = await summarizeReadyRollForSlot(slotId);
    return res.status(200).json({
      success: true,
      data: { entries, summary },
    });
  } catch (error) {
    console.error("getSlotReadyRollLog:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to load ready roll log",
    });
  }
};
