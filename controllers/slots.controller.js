import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js"
// Helper function to generate slots for a year
export const generateSlotsForYear = (year, slotSize = 5) => {
  const slots = [];
  const daysInMonths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
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
      slots.push({
        startDay,
        endDay,
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


// Function to create slots for all plants and subtypes for a specific year
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

    console.log(`Slots created successfully for the year ${year} for all plants and subtypes.`);
  } catch (error) {
    console.error('Error creating slots:', error);
  }
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
    if (subtypeId) query['subtypeSlots.subtypeId'] = subtypeId;

    // Fetch slots with optimized query
    const slots = await PlantSlot.find(query)
      .populate({
        path: 'plantId',
        select: 'name', // Populate only the plant name
      })
      .select('year plantId subtypeSlots') // Fetch only necessary fields
      .lean() // Use lean queries for faster performance
      .skip((pageNumber - 1) * pageSize) // Pagination
      .limit(pageSize);

    if (!slots.length) {
      return res.status(404).json({ message: 'No slots found.' });
    }

    res.status(200).json(slots);
  } catch (error) {
    console.error('Error fetching slots:', error);
    res.status(500).json({ message: 'Internal server error.', error });
  }
};


export const getPlantNames = async (req, res) => {
  try {
    // Fetch all plantId references and return both plant name and plantId fields
    const slots = await PlantSlot.aggregate([
      {
        $unwind: "$subtypeSlots", // Unwind the subtypeSlots array
      },
      {
        $unwind: "$subtypeSlots.slots", // Unwind the slots array within subtypeSlots
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
        $unwind: "$plantDetails", // Unwind to access plant details in the next stage
      },
      {
        $group: {
          _id: "$plantId", // Group by plantId to ensure unique plant names
          plantName: { $first: "$plantDetails.name" }, // Get the name of the plant
        },
      },
      {
        $project: {
          _id: 0,
          plantId: "$_id", // Include the plantId in the response
          name: "$plantName", // Include the plant name in the response
        },
      },
    ]);

    // Check if no plant names were found
    if (slots.length === 0) {
      return res.status(404).json({ message: "No plants found." });
    }

    // Return the plant names and their IDs as an array of objects
    res.status(200).json(slots);
  } catch (error) {
    console.error("Error fetching plant names:", error);
    res.status(500).json({ message: "Internal server error.", error });
  }
};



export const getSubtypesByPlant = async (req, res) => {
  try {
    const { plantId, plantName, year } = req.query;
console.log(year)
    if (!year) {
      return res.status(400).json({ message: "Year is required." });
    }

    // Construct the query based on the provided plantId or plantName
    let query = {};
    if (plantId) {
      query._id = plantId; // Search by plantId
    } else if (plantName) {
      query.name = plantName; // Search by plantName
    }

    // Fetch the plant from the database, including its subtypes
    const plant = await PlantCms.findOne(query).populate("subtypes");

    if (!plant) {
      return res.status(404).json({ message: "Plant not found." });
    }

    // Fetch the slot summary for the specified year and plant
    const slotSummary = await PlantSlot.aggregate([
      { $match: { plantId: plant._id, year: parseInt(year) } }, // Match plant and year
      { $unwind: "$subtypeSlots" }, // Deconstruct the subtypeSlots array
      { $unwind: "$subtypeSlots.slots" }, // Deconstruct the nested slots array
      {
        $group: {
          _id: null, // Group all slots together
          totalPlants: { $sum: "$subtypeSlots.slots.totalPlants" },
          totalBookedPlants: { $sum: "$subtypeSlots.slots.totalBookedPlants" },
        },
      },
      {
        $project: {
          _id: 0, // Exclude the _id field
          totalPlants: 1,
          totalBookedPlants: 1,
        },
      },
    ]);

    // Prepare the response
    const totals = slotSummary.length > 0 ? slotSummary[0] : { totalPlants: 0, totalBookedPlants: 0 };

    res.status(200).json({
      plant,
      totals,
    });
  } catch (error) {
    console.error("Error fetching plant subtypes and slot summary:", error);
    res.status(500).json({ message: "Internal server error.", error });
  }
};

export const getSlotsByPlantAndSubtype = async (req, res) => {
  try {
    const { plantId, subtypeId, year, status, page = 1, limit = 10 } = req.query;

    // Build the query to filter by plantId, subtypeId, and year
    const query = {};
    if (plantId) query.plantId = plantId;
    if (year) query.year = Number(year);

    // Pagination settings
    const pageNumber = Number(page);
    const pageSize = Number(limit);

    // Filter for subtypeId and status
    const subtypeFilter = {};
    if (subtypeId) subtypeFilter["subtypeSlots.subtypeId"] = subtypeId;
    if (status !== undefined) {
      // If status is provided, filter slots by status
      subtypeFilter["subtypeSlots.slots.status"] = status === "true";
    }
    console.log('Query:', subtypeFilter); // Log the query used in the aggregation

    // Fetch the month-wise summary and matching slots for the provided subtypeId
    const [summary, slots] = await Promise.all([
      PlantSlot.aggregate([
        { $match: query }, // Match plantId and year
        
        { $unwind: "$subtypeSlots" }, // Flatten subtypeSlots array
        { $match: subtypeFilter }, // Apply the subtypeId and status filters
        { $unwind: "$subtypeSlots.slots" }, // Flatten slots array
        {
          $group: {
            _id: "$subtypeSlots.slots.month", // Group by month
            totalPlants: { $sum: "$subtypeSlots.slots.totalPlants" },
            totalBookedPlants: { $sum: "$subtypeSlots.slots.totalBookedPlants" },
          },
        },
        {
          $project: {
            _id: 0,
            month: "$_id", // Rename _id to month
            totalPlants: 1,
            totalBookedPlants: 1,
          },
        },
        { $sort: { month: 1 } }, // Sort by month
      ]),
      PlantSlot.find(query)
        .populate({
          path: "plantId",
          select: "name",
        })
        .lean()
        .skip((pageNumber - 1) * pageSize) // Skip for pagination
        .limit(pageSize) // Limit for pagination
        .exec(),
    ]);

    // Check if there are any slots or summary results
    if (!slots.length) {
      return res
        .status(404)
        .json({ message: "No slots found for the given plant, subtype, and year." });
    }

    // Define months for the summary
    const months = [
      "January", "February", "March", "April", "May", "June", "July", "August", 
      "September", "October", "November", "December"
    ];

    // Initialize month-wise summary with default values (0 for both plants)
    const monthwiseSummary = months.map(month => ({
      month,
      totalPlants: 0,
      totalBookedPlants: 0
    }));

    // Populate the monthwiseSummary with the actual data from aggregation
    summary.forEach(item => {
      const monthIndex = months.indexOf(item.month);
      if (monthIndex >= 0) {
        monthwiseSummary[monthIndex] = {
          month: item.month,
          totalPlants: item.totalPlants,
          totalBookedPlants: item.totalBookedPlants,
        };
      }
    });

    console.log('Monthwise Summary:', monthwiseSummary); // Debugging the final summary

    // Return the fetched slots and the month-wise summary
    res.status(200).json({ monthwiseSummary, slots });
  } catch (error) {
    console.error("Error fetching slots:", error.message);
    res.status(500).json({ message: "Internal server error.", error: error.message });
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
    res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

