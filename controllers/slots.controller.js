import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
// Helper function to generate slots for a year
import moment from "moment"; // Optional: Use moment.js or other libraries for date validation/formatting

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

    console.log(
      `Slots created successfully for the year ${year} for all plants and subtypes.`
    );
  } catch (error) {
    console.error("Error creating slots:", error);
  }
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

    while (startDay <= daysInMonth) {
      const endDay = Math.min(startDay + slotSize - 1, daysInMonth);

      // Convert startDay and endDay to `dd-mm-yyyy` format
      const startDate = moment(
        `${year}-${monthIndex + 1}-${startDay}`,
        "YYYY-M-D"
      ).format("DD-MM-YYYY");
      const endDate = moment(
        `${year}-${monthIndex + 1}-${endDay}`,
        "YYYY-M-D"
      ).format("DD-MM-YYYY");

      slots.push({
        startDay: startDate, // Formatted date
        endDay: endDate, // Formatted date
        month: monthName, // Add the month name
        totalPlants: 0,
        totalBookedPlants: 0,
        orders: [],
        overflow: false,
        status: true,
      });

      startDay += slotSize;
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
    const plantDetails = await PlantSlot.aggregate([
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

    if (plantDetails.length === 0) {
      return res.status(404).json({ message: "No plant data found." });
    }

    res.status(200).json(plantDetails);
  } catch (error) {
    console.error("Error fetching plant details with summary:", error);
    res.status(500).json({ message: "Internal server error.", error });
  }
};

import mongoose from "mongoose";
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

    // Format paginatedSlots for the response
    const slots = paginatedSlots.map((slot) => ({
      plantId: slot._id.plantId,
      year: slot._id.year,
      subtypeId: slot._id.subtypeId,
      slots: slot.slots,
    }));

    if (!slots.length) {
      return res.status(404).json({
        message: "No slots found for the given plant, subtype, and year.",
      });
    }

    // Return the filtered slots and the month-wise summary
    res.status(200).json({ monthwiseSummary, slots });
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

    // Update the specific field in the slot using array filters
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

    res.status(200).json({
      message: "Slot updated successfully.",
      data: result,
    });
  } catch (error) {
    console.error("Error updating slot:", error);
    res
      .status(500)
      .json({ message: "Internal server error.", error: error.message });
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
    console.log('Sample PlantSlot document:', JSON.stringify(sampleDocs, null, 2));

    const stats = await PlantSlot.aggregate([
      {
        $unwind: "$subtypeSlots"
      },
      {
        $unwind: "$subtypeSlots.slots"
      },
      {
        $match: {
          "subtypeSlots.slots.startDay": { $gte: startDate },
          "subtypeSlots.slots.endDay": { $lte: endDate }
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plant"
        }
      },
      {
        $lookup: {
          from: "plantsubtypeschemas", // Correct collection name based on schema name
          localField: "subtypeSlots.subtypeId",
          foreignField: "_id",
          as: "subtype"
        }
      },
      {
        $addFields: {
          subtypeName: {
            $ifNull: [
              { $first: { $arrayElemAt: ["$subtype.name", 0] } },
              "Unknown Subtype"
            ]
          }
        }
      },
      {
        $group: {
          _id: {
            plantId: "$plantId",
            subtypeId: "$subtypeSlots.subtypeId",
            month: "$subtypeSlots.slots.month"
          },
          plantName: { $first: { $arrayElemAt: ["$plant.name", 0] } },
          subtypeName: { $first: "$subtypeName" },
          totalPlants: { $sum: "$subtypeSlots.slots.totalPlants" },
          totalBookedPlants: { $sum: "$subtypeSlots.slots.totalBookedPlants" }
        }
      },
      {
        $group: {
          _id: {
            plantId: "$_id.plantId",
            month: "$_id.month"
          },
          plantName: { $first: "$plantName" },
          subtypes: {
            $push: {
              name: "$subtypeName",
              totalPlants: "$totalPlants",
              totalBookedPlants: "$totalBookedPlants",
              allPlants: { $add: ["$totalPlants", "$totalBookedPlants"] }
            }
          },
          monthlyTotalPlants: { $sum: "$totalPlants" },
          monthlyTotalBookedPlants: { $sum: "$totalBookedPlants" }
        }
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
              allPlants: { $add: ["$monthlyTotalPlants", "$monthlyTotalBookedPlants"] }
            }
          },
          totalPlants: { $sum: "$monthlyTotalPlants" },
          totalBookedPlants: { $sum: "$monthlyTotalBookedPlants" }
        }
      },
      {
        $project: {
          _id: 1,
          plantName: 1,
          monthlyData: 1,
          totalPlants: 1,
          totalBookedPlants: 1,
          allPlants: { $add: ["$totalPlants", "$totalBookedPlants"] }
        }
      },
      {
        $sort: {
          "plantName": 1
        }
      }
    ]);

    // Calculate grand totals
    const grandTotals = stats.reduce((acc, plant) => {
      return {
        totalPlants: acc.totalPlants + plant.totalPlants,
        totalBookedPlants: acc.totalBookedPlants + plant.totalBookedPlants,
        allPlants: acc.allPlants + plant.allPlants
      };
    }, { totalPlants: 0, totalBookedPlants: 0, allPlants: 0 });

    // Get unique months across all data for X-axis
    const allMonths = [...new Set(stats.flatMap(plant => 
      plant.monthlyData.map(data => data.month)
    ))].sort((a, b) => {
      const months = ["January", "February", "March", "April", "May", "June", 
                     "July", "August", "September", "October", "November", "December"];
      return months.indexOf(a) - months.indexOf(b);
    });

    // Format data for charts
    const chartData = {
      lineChart: allMonths.map(month => {
        const monthData = {
          month,
          totalPlants: 0,
          totalBookedPlants: 0,
          allPlants: 0
        };

        stats.forEach(plant => {
          const monthlyData = plant.monthlyData.find(data => data.month === month);
          if (monthlyData) {
            monthData.totalPlants += monthlyData.totalPlants;
            monthData.totalBookedPlants += monthlyData.totalBookedPlants;
            monthData.allPlants += monthlyData.allPlants;
          }
        });

        return monthData;
      }),
      barChart: stats.map(plant => ({
        plantName: plant.plantName,
        totalPlants: plant.totalPlants,
        totalBookedPlants: plant.totalBookedPlants,
        allPlants: plant.allPlants
      }))
    };

    return res.status(200).json({
      success: true,
      data: {
        summary: stats,
        grandTotals,
        chartData
      }
    });

  } catch (error) {
    console.error('Error in getPlantStats:', error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Example API route setup
import express from 'express';
const router = express.Router();

router.get('/plant-stats', getPlantStats);

export default router;


// Example API route setup
