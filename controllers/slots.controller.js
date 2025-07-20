import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import mongoose from "mongoose";
import moment from "moment"; // Optional: Use moment.js or other libraries for date validation/formatting
import { calculateEffectiveBuffer, calculateBufferAdjustedCapacity, releaseBufferPlants, addPlantsToCapacity } from "../utility/bufferUtils.js";
import { updateSlotBufferCalculations, updateAllSlotBuffers } from "../utility/slotBufferUpdater.js";

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
    const PlantCms = mongoose.model('PlantCms');
    const allPlants = await PlantCms.find({}).select('_id name subtypes');
    
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
          hasSlots: !!plantWithSlots
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
        hasSlots: false
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
          totalPlants: 1, // Include the sum of totalPlants
          totalBookedPlants: 1, // Include the sum of totalBookedPlants
        },
      },
      {
        $sort: { subtypeName: 1 }, // Sort by subtype name for consistent ordering
      },
    ]);

    if (stats.length === 0) {
      return res
        .status(404)
        .json({ message: "No slots found for the specified plant and year." });
    }

    // Calculate the overall totals for all subtypes
    const overallTotals = stats.reduce(
      (totals, subtype) => {
        totals.totalPlants += subtype.totalPlants;
        totals.totalBookedPlants += subtype.totalBookedPlants;
        return totals;
      },
      { totalPlants: 0, totalBookedPlants: 0 }
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

    // Format paginatedSlots for the response and apply buffer calculations
    const slots = paginatedSlots.map((slot) => ({
      plantId: slot._id.plantId,
      year: slot._id.year,
      subtypeId: slot._id.subtypeId,
      slots: slot.slots.map(slotItem => {
        // Calculate effective buffer for this slot
        const effectiveBuffer = calculateEffectiveBuffer(
          slotItem.buffer || 0,
          subtypeBuffer,
          plantBuffer
        );

        // Calculate buffer-adjusted capacity
        const bufferAdjusted = calculateBufferAdjustedCapacity(
          slotItem.totalPlants,
          slotItem.totalBookedPlants,
          effectiveBuffer
        );

        return {
          ...slotItem,
          effectiveBuffer,
          bufferAdjustedCapacity: bufferAdjusted.bufferAdjustedCapacity,
          availablePlants: bufferAdjusted.availablePlants,
          bufferAmount: bufferAdjusted.bufferAmount,
          // Keep original totalPlants unchanged - this is the actual capacity
          originalTotalPlants: slotItem.totalPlants,
          // Keep totalPlants as the original capacity, don't overwrite with buffer-adjusted value
          totalPlants: slotItem.totalPlants
        };
      }),
    }));

    // Populate slots with orders and recalculate totalBookedPlants
    const slotsWithOrders = await populateSlotsWithOrders(slots);

    // Recalculate month-wise summary with actual orders data
    for (const slotGroup of slotsWithOrders) {
      for (const slot of slotGroup.slots) {
        const monthIndex = months.indexOf(slot.month);
        if (monthIndex >= 0) {
          monthwiseSummary[monthIndex].totalBookedPlants = slot.totalBookedPlants;
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

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No update data provided." });
    }

    // First, update the specific field in the slot using array filters
    const result = await PlantSlot.findOneAndUpdate(
      { "subtypeSlots.slots._id": slotId }, // Find the document containing the slot
      {
        $set: Object.fromEntries(
          Object.entries(updates).map(([key, value]) => [
            `subtypeSlots.$[].slots.$[slotElem].${key}`,
            value,
          ])
        ),
      },
      {
        arrayFilters: [{ "slotElem._id": slotId }], // Filter for the slot ID
        new: true, // Return the updated document
        runValidators: true, // Run schema validators
      }
    );

    if (!result) {
      return res.status(404).json({ message: "Slot not found." });
    }

    // Find the updated slot to get current values
    const updatedSlot = result.subtypeSlots
      .flatMap(subtype => subtype.slots)
      .find(slot => slot._id.toString() === slotId);

    if (!updatedSlot) {
      return res.status(404).json({ message: "Updated slot not found." });
    }

    // Update buffer calculations in the database
    const bufferUpdateResult = await updateSlotBufferCalculations(
      slotId,
      updatedSlot.totalPlants,
      updatedSlot.totalBookedPlants,
      updatedSlot.buffer
    );

    if (!bufferUpdateResult.success) {
      console.error("Warning: Buffer calculations update failed:", bufferUpdateResult.error);
    }

    res.status(200).json({
      message: "Slot updated successfully.",
      data: {
        ...result.toObject(),
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

    // Update the buffer field in the slot
    const result = await PlantSlot.findOneAndUpdate(
      { "subtypeSlots.slots._id": slotId },
      {
        $set: {
          "subtypeSlots.$[].slots.$[slotElem].buffer": bufferValue
        }
      },
      {
        arrayFilters: [{ "slotElem._id": slotId }],
        new: true,
        runValidators: true,
      }
    );

    if (!result) {
      return res.status(404).json({ 
        success: false,
        message: "Slot not found." 
      });
    }

    // Find the updated slot to get current values
    const updatedSlot = result.subtypeSlots
      .flatMap(subtype => subtype.slots)
      .find(slot => slot._id.toString() === slotId);

    if (!updatedSlot) {
      return res.status(404).json({ 
        success: false,
        message: "Updated slot not found." 
      });
    }

    // Update buffer calculations in the database
    const bufferUpdateResult = await updateSlotBufferCalculations(
      slotId,
      updatedSlot.totalPlants,
      updatedSlot.totalBookedPlants,
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
        slot: updatedSlot,
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
    const { plantId, subtypeId, startDay, endDay, totalPlants, buffer = 0 } = req.body;
    
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
      isManual: true // Flag to identify manually added slots
    };
    
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

    // Release plants from buffer
    const releaseResult = releaseBufferPlants(targetSlot, plantsToRelease);
    
    if (!releaseResult.success) {
      return res.status(400).json({
        success: false,
        message: releaseResult.message
      });
    }

    // Update the slot with new buffer values
    const updateResult = await updateSlotBufferCalculations(
      slotId,
      targetSlot.totalPlants,
      targetSlot.totalBookedPlants,
      releaseResult.newBufferPercentage
    );

    if (!updateResult.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to update slot after buffer release",
        error: updateResult.error
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

// Add plants directly to capacity (ignoring buffer)
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

    // Add plants to capacity
    const addResult = addPlantsToCapacity(targetSlot, plantsToAdd);
    
    if (!addResult.success) {
      return res.status(400).json({
        success: false,
        message: addResult.message
      });
    }

    // Update the slot with new total plants
    const updateResult = await updateSlotBufferCalculations(
      slotId,
      addResult.newTotalPlants,
      targetSlot.totalBookedPlants,
      targetSlot.buffer
    );

    if (!updateResult.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to update slot after adding plants",
        error: updateResult.error
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
    console.error("Error adding plants to capacity:", error);
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

    slots.push({
      startDay: slotStart.format('DD-MM-YYYY'),
      endDay: slotEnd.format('DD-MM-YYYY'),
      month: slotStart.format('MMMM'),
      year: slotStart.year(),
      totalPlants: capacity,
      totalBookedPlants: 0,
      buffer: 0,
      orders: [],
      allowedSalesmen: [],
      restrictToSalesmen: false,
      overflow: false,
      status: true,
    });

    currentDate = slotEnd.clone().add(1, 'days');
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
      slots.pop();
    }
  }

  return slots;
};

// Function to calculate totalBookedPlants from orders array
const calculateTotalBookedPlantsFromOrders = async (slotId) => {
  try {
    const Order = mongoose.model('Order');
    const totalBookedPlants = await Order.aggregate([
      {
        $match: {
          bookingSlot: new mongoose.Types.ObjectId(slotId),
          orderStatus: { $ne: 'CANCELLED' } // Exclude cancelled orders
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
const populateSlotsWithOrders = async (slots) => {
  try {
    const Order = mongoose.model('Order');
    
    for (const slotGroup of slots) {
      for (const slot of slotGroup.slots) {
        // Get orders for this slot - handle both ObjectId and array formats
        const orders = await Order.find({
          $or: [
            { bookingSlot: slot._id }, // Direct ObjectId reference
            { "bookingSlot.slotId": slot._id.toString() }, // Array format with slotId
            { "bookingSlot.startDay": slot.startDay, "bookingSlot.endDay": slot.endDay } // Array format with date matching
          ],
          orderStatus: { $ne: 'CANCELLED' }
        }).select('_id orderId numberOfPlants farmer salesPerson orderStatus');

        // Calculate totalBookedPlants from orders
        const totalBookedPlants = orders.reduce((sum, order) => sum + order.numberOfPlants, 0);
        
        // Update slot with calculated values
        slot.orders = orders;
        slot.totalBookedPlants = totalBookedPlants;
        
        // Calculate available plants considering buffer
        const effectiveBuffer = slot.effectiveBuffer || 0;
        const bufferAmount = Math.round((slot.totalPlants * effectiveBuffer) / 100);
        const bufferAdjustedCapacity = slot.totalPlants - bufferAmount;
        slot.availablePlants = Math.max(0, bufferAdjustedCapacity - totalBookedPlants);
        
        // Ensure totalPlants remains as the original capacity
        // Don't modify totalPlants here - it should always represent the actual slot capacity
        
        // Set overflow flag
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

// Get slot details by ID
export const getSlotDetailsById = async (req, res) => {
  try {
    const { slotId } = req.params;
    
    if (!slotId) {
      return res.status(400).json({ 
        success: false, 
        message: "Slot ID is required" 
      });
    }

    console.log("Getting slot details for slot ID:", slotId);

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
        originalTotalPlants: slotInfo.originalTotalPlants
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

// Example API route setup
import express from "express";
const router = express.Router();

router.get("/plant-stats", getPlantStats);

export default router;
