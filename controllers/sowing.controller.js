import Sowing from "../models/sowing.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import moment from "moment";

// Create a new sowing record
export const createSowing = async (req, res) => {
  try {
    const {
      plantId,
      subtypeId,
      sowingDate,
      totalQuantityRequired,
      slotId,
      orderId,
      orderNumber,
      reminderBeforeDays,
      notes,
      createdBy,
      sowingLocation, // OFFICE or PRIMARY
    } = req.body;

    // Validate plant and subtype
    const plant = await PlantCms.findById(plantId);
    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    if (!plant.sowingAllowed) {
      return res.status(400).json({ 
        message: "Sowing is not allowed for this plant. Please enable 'Sowing Allowed' in plant settings." 
      });
    }

    const subtype = plant.subtypes.id(subtypeId);
    if (!subtype) {
      return res.status(404).json({ message: "Subtype not found" });
    }

    if (!subtype.plantReadyDays || subtype.plantReadyDays === 0) {
      return res.status(400).json({ 
        message: "Plant Ready Days not set for this subtype. Please update plant settings." 
      });
    }

    // Calculate expected ready date
    const sowingMoment = moment(sowingDate, "DD-MM-YYYY");
    const expectedReadyDate = sowingMoment
      .clone()
      .add(subtype.plantReadyDays, "days")
      .format("DD-MM-YYYY");

    // Create sowing record
    const sowing = new Sowing({
      plantId,
      plantName: plant.name,
      subtypeId,
      subtypeName: subtype.name,
      slotId,
      sowingDate,
      plantReadyDays: subtype.plantReadyDays,
      expectedReadyDate,
      totalQuantityRequired,
      sowingLocation: sowingLocation || "OFFICE", // Default to OFFICE
      orderId,
      orderNumber,
      reminderBeforeDays: reminderBeforeDays || 5,
      notes,
      createdBy,
    });

    const savedSowing = await sowing.save();

    // Update the slot's officeSowed or primarySowed based on location
    if (slotId) {
      try {
        const slot = await PlantSlot.findOne({
          "subtypeSlots.slots._id": slotId
        });

        if (slot) {
          // Find the subtype and slot
          const subtypeSlot = slot.subtypeSlots.find(st => 
            st.slots.some(s => s._id.toString() === slotId.toString())
          );

          if (subtypeSlot) {
            const slotToUpdate = subtypeSlot.slots.find(s => s._id.toString() === slotId.toString());
            
            if (slotToUpdate) {
              const location = sowingLocation || "OFFICE";
              
              // Update the appropriate field based on location
              if (location === "PRIMARY") {
                slotToUpdate.primarySowed = (slotToUpdate.primarySowed || 0) + totalQuantityRequired;
                
                // ADD to totalPlants (total capacity) when PRIMARY sowing is done
                slotToUpdate.totalPlants = (slotToUpdate.totalPlants || 0) + totalQuantityRequired;
                
                console.log(`Updated slot ${slotId}: primarySowed += ${totalQuantityRequired}, totalPlants (capacity) += ${totalQuantityRequired}`);
              } else {
                // OFFICE sowing - just track seeds outward from office
                slotToUpdate.officeSowed = (slotToUpdate.officeSowed || 0) + totalQuantityRequired;
                console.log(`Updated slot ${slotId}: officeSowed += ${totalQuantityRequired} (seed outward)`);
              }
              
              // plantsSowed = ONLY primarySowed (actual plants in field)
              slotToUpdate.plantsSowed = slotToUpdate.primarySowed || 0;
              
              await slot.save();
            }
          }
        }
      } catch (slotError) {
        console.error("Error updating slot:", slotError);
        // Don't fail the whole request if slot update fails
      }
    }

    return res.status(201).json({
      message: "Sowing record created successfully",
      data: savedSowing,
    });
  } catch (error) {
    console.error("Error creating sowing:", error);
    return res.status(500).json({
      message: "Error creating sowing record",
      error: error.message,
    });
  }
};

// Get all sowing records with filters
export const getSowings = async (req, res) => {
  try {
    const {
      plantId,
      status,
      fromDate,
      toDate,
      showPendingOnly,
      showOverdueOnly,
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (plantId) query.plantId = plantId;
    if (status) query.status = status;

    // Date range filter
    if (fromDate && toDate) {
      query.sowingDate = {
        $gte: fromDate,
        $lte: toDate,
      };
    }

    // Filter for pending sowing (not fully sowed)
    if (showPendingOnly === "true") {
      query.status = { $in: ["PENDING", "PARTIALLY_SOWED", "OVERDUE"] };
    }

    // Filter for overdue sowing
    if (showOverdueOnly === "true") {
      query.status = "OVERDUE";
    }

    const sowings = await Sowing.find(query)
      .populate("plantId", "name sowingAllowed")
      .populate("createdBy", "name phoneNumber")
      .populate("updatedBy", "name phoneNumber")
      .sort({ sowingDate: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const count = await Sowing.countDocuments(query);

    return res.status(200).json({
      success: true,
      data: sowings,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      total: count,
    });
  } catch (error) {
    console.error("Error fetching sowings:", error);
    return res.status(500).json({
      message: "Error fetching sowing records",
      error: error.message,
    });
  }
};

// Get sowing by ID
export const getSowingById = async (req, res) => {
  try {
    const { id } = req.params;

    const sowing = await Sowing.findById(id)
      .populate("plantId", "name sowingAllowed")
      .populate("createdBy", "name phoneNumber")
      .populate("updatedBy", "name phoneNumber")
      .populate("sowingHistory.performedBy", "name phoneNumber");

    if (!sowing) {
      return res.status(404).json({ message: "Sowing record not found" });
    }

    return res.status(200).json({
      success: true,
      data: sowing,
    });
  } catch (error) {
    console.error("Error fetching sowing:", error);
    return res.status(500).json({
      message: "Error fetching sowing record",
      error: error.message,
    });
  }
};

// Update office sowed quantity
export const updateOfficeSowed = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, performedBy, notes, date } = req.body;

    const sowing = await Sowing.findById(id);
    if (!sowing) {
      return res.status(404).json({ message: "Sowing record not found" });
    }

    // Update office sowed
    sowing.officeSowed = (sowing.officeSowed || 0) + quantity;
    sowing.updatedBy = performedBy;

    // Add to history
    sowing.sowingHistory.push({
      date: date || moment().format("DD-MM-YYYY"),
      location: "OFFICE",
      quantity,
      performedBy,
      notes,
    });

    await sowing.save();

    return res.status(200).json({
      message: "Office sowing updated successfully",
      data: sowing,
    });
  } catch (error) {
    console.error("Error updating office sowing:", error);
    return res.status(500).json({
      message: "Error updating office sowing",
      error: error.message,
    });
  }
};

// Update primary sowed quantity
export const updatePrimarySowed = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, performedBy, notes, date } = req.body;

    const sowing = await Sowing.findById(id);
    if (!sowing) {
      return res.status(404).json({ message: "Sowing record not found" });
    }

    // Update primary sowed
    sowing.primarySowed = (sowing.primarySowed || 0) + quantity;
    sowing.updatedBy = performedBy;

    // Add to history
    sowing.sowingHistory.push({
      date: date || moment().format("DD-MM-YYYY"),
      location: "PRIMARY",
      quantity,
      performedBy,
      notes,
    });

    await sowing.save();

    return res.status(200).json({
      message: "Primary sowing updated successfully",
      data: sowing,
    });
  } catch (error) {
    console.error("Error updating primary sowing:", error);
    return res.status(500).json({
      message: "Error updating primary sowing",
      error: error.message,
    });
  }
};

// Update harvest information
export const updateHarvest = async (req, res) => {
  try {
    const { id } = req.params;
    const { harvestedQuantity, harvestDate, notes, updatedBy } = req.body;

    const sowing = await Sowing.findById(id);
    if (!sowing) {
      return res.status(404).json({ message: "Sowing record not found" });
    }

    sowing.harvestedQuantity = harvestedQuantity;
    sowing.harvestDate = harvestDate || moment().format("DD-MM-YYYY");
    sowing.notes = notes || sowing.notes;
    sowing.updatedBy = updatedBy;

    await sowing.save();

    return res.status(200).json({
      message: "Harvest information updated successfully",
      data: sowing,
    });
  } catch (error) {
    console.error("Error updating harvest:", error);
    return res.status(500).json({
      message: "Error updating harvest information",
      error: error.message,
    });
  }
};

// Get dynamic sowing reminders based on slot gaps
export const getPendingReminders = async (req, res) => {
  try {
    const today = moment();
    const nextWeek = moment().add(7, "days");

    // Get both slot-wise and order-wise reminders
    const [slotWiseReminders, orderWiseReminders] = await Promise.all([
      // SLOT-WISE REMINDERS (existing system)
      PlantSlot.aggregate([
        {
          $unwind: "$subtypeSlots"
        },
        {
          $unwind: "$subtypeSlots.slots"
        },
        {
          $match: {
            "subtypeSlots.slots.totalBookedPlants": { $gt: 0 },
            $expr: {
              $gt: [
                { $subtract: ["$subtypeSlots.slots.totalBookedPlants", { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] }] },
                0
              ]
            }
          }
        },
        {
          $lookup: {
            from: "plantcms",
            localField: "plantId",
            foreignField: "_id",
            as: "plantInfo"
          }
        },
        {
          $addFields: {
            plantSowingAllowed: { $arrayElemAt: ["$plantInfo.sowingAllowed", 0] }
          }
        },
        {
          $match: {
            plantSowingAllowed: true
          }
        },
        {
          $lookup: {
            from: "plantcms",
            let: { plantId: "$plantId", subtypeId: "$subtypeSlots.subtypeId" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$_id", "$$plantId"] }
                }
              },
              {
                $unwind: "$subtypes"
              },
              {
                $match: {
                  $expr: { $eq: ["$subtypes._id", "$$subtypeId"] }
                }
              },
              {
                $project: {
                  subtypeName: "$subtypes.name",
                  plantReadyDays: "$subtypes.plantReadyDays"
                }
              }
            ],
            as: "subtypeInfo"
          }
        },
        {
          $addFields: {
            plantName: { $arrayElemAt: ["$plantInfo.name", 0] },
            subtypeName: { $arrayElemAt: ["$subtypeInfo.subtypeName", 0] },
            plantReadyDays: { $arrayElemAt: ["$subtypeInfo.plantReadyDays", 0] },
            gap: {
              $subtract: [
                "$subtypeSlots.slots.totalBookedPlants",
                { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] }
              ]
            },
            sowByDate: {
              $dateFromString: {
                dateString: {
                  $concat: [
                    { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                    "-",
                    { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                    "-",
                    { $substr: ["$subtypeSlots.slots.endDay", 0, 2] }
                  ]
                },
                format: "%Y-%m-%d"
              }
            }
          }
        },
        {
          $addFields: {
            sowByDate: {
              $dateSubtract: {
                startDate: "$sowByDate",
                unit: "day",
                amount: { $ifNull: ["$plantReadyDays", 0] }
              }
            }
          }
        },
        {
          $addFields: {
            sowByDateString: {
              $dateToString: {
                date: "$sowByDate",
                format: "%d-%m-%Y"
              }
            },
            daysUntilSow: {
              $divide: [
                { $subtract: ["$sowByDate", new Date()] },
                1000 * 60 * 60 * 24
              ]
            }
          }
        },
        {
          $match: {
            daysUntilSow: { $lte: 5 }
          }
        },
        {
          $project: {
            _id: "$subtypeSlots.slots._id",
            plantId: "$plantId",
            plantName: { name: { $arrayElemAt: ["$plantInfo.name", 0] } },
            subtypeId: "$subtypeSlots.subtypeId",
            subtypeName: { $arrayElemAt: ["$subtypeInfo.subtypeName", 0] },
            slotId: "$subtypeSlots.slots._id",
            slotStartDay: "$subtypeSlots.slots.startDay",
            slotEndDay: "$subtypeSlots.slots.endDay",
            month: "$subtypeSlots.slots.month",
            totalQuantityRequired: "$gap",
            remainingToSow: "$gap",
            sowingDate: "$sowByDateString",
            daysUntilSow: { $round: ["$daysUntilSow", 0] },
            priority: {
              $cond: [
                { $lt: ["$daysUntilSow", 0] },
                "overdue",
                {
                  $cond: [
                    { $lte: ["$daysUntilSow", 2] },
                    "urgent",
                    "upcoming"
                  ]
                }
              ]
            },
            plantReadyDays: 1,
            totalBookedPlants: "$subtypeSlots.slots.totalBookedPlants",
            primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
            officeSowed: { $ifNull: ["$subtypeSlots.slots.officeSowed", 0] },
            reminderType: "SLOT"
          }
        },
        { $sort: { daysUntilSow: 1 } }
      ]),

      // ORDER-WISE REMINDERS (new system)
      Order.aggregate([
        {
          $match: {
            deliveryDate: { $exists: true, $ne: null },
            status: { $in: ["PENDING", "PROCESSING"] }
          }
        },
        {
          $unwind: "$items"
        },
        {
          $lookup: {
            from: "plantcms",
            localField: "items.plantId",
            foreignField: "_id",
            as: "plantInfo"
          }
        },
        {
          $match: {
            "plantInfo.sowingAllowed": true
          }
        },
        {
          $lookup: {
            from: "plantcms",
            let: { 
              plantId: "$items.plantId", 
              subtypeId: "$items.subtypeId" 
            },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$_id", "$$plantId"] }
                }
              },
              {
                $unwind: "$subtypes"
              },
              {
                $match: {
                  $expr: { $eq: ["$subtypes._id", "$$subtypeId"] }
                }
              },
              {
                $project: {
                  subtypeName: "$subtypes.name",
                  plantReadyDays: "$subtypes.plantReadyDays"
                }
              }
            ],
            as: "subtypeInfo"
          }
        },
        {
          $addFields: {
            plantName: { $arrayElemAt: ["$plantInfo.name", 0] },
            subtypeName: { $arrayElemAt: ["$subtypeInfo.subtypeName", 0] },
            plantReadyDays: { $arrayElemAt: ["$subtypeInfo.plantReadyDays", 0] },
            sowByDate: {
              $dateSubtract: {
                startDate: "$deliveryDate",
                unit: "day",
                amount: { $ifNull: ["$subtypeInfo.plantReadyDays", 0] }
              }
            }
          }
        },
        {
          $match: {
            sowByDate: {
              $gte: today.toDate(),
              $lte: nextWeek.toDate()
            }
          }
        },
        {
          $group: {
            _id: {
              plantId: "$items.plantId",
              subtypeId: "$items.subtypeId",
              deliveryDate: "$deliveryDate",
              sowByDate: "$sowByDate"
            },
            plantName: { $first: "$plantName" },
            subtypeName: { $first: "$subtypeName" },
            plantReadyDays: { $first: "$plantReadyDays" },
            totalQuantityRequired: { $sum: "$items.numberOfPlants" },
            orderCount: { $sum: 1 },
            orders: { $push: "$_id" }
          }
        },
        {
          $lookup: {
            from: "sowings",
            let: { 
              plantId: "$_id.plantId", 
              subtypeId: "$_id.subtypeId",
              sowByDate: "$_id.sowByDate"
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$plantId", "$$plantId"] },
                      { $eq: ["$subtypeId", "$$subtypeId"] },
                      { $eq: ["$sowingDate", "$$sowByDate"] }
                    ]
                  }
                }
              }
            ],
            as: "existingSowings"
          }
        },
        {
          $addFields: {
            alreadySowed: {
              $sum: "$existingSowings.totalQuantityRequired"
            },
            remainingToSow: {
              $subtract: ["$totalQuantityRequired", { $sum: "$existingSowings.totalQuantityRequired" }]
            }
          }
        },
        {
          $match: {
            remainingToSow: { $gt: 0 }
          }
        },
        {
          $addFields: {
            daysUntilSow: {
              $divide: [
                { $subtract: ["$_id.sowByDate", new Date()] },
                1000 * 60 * 60 * 24
              ]
            }
          }
        },
        {
          $addFields: {
            priority: {
              $cond: [
                { $lt: ["$daysUntilSow", 0] },
                "overdue",
                {
                  $cond: [
                    { $lte: ["$daysUntilSow", 1] },
                    "urgent",
                    "upcoming"
                  ]
                }
              ]
            }
          }
        },
        {
          $project: {
            _id: { $concat: ["$_id.plantId", "_", "$_id.subtypeId", "_", { $dateToString: { date: "$_id.sowByDate", format: "%Y-%m-%d" } }] },
            plantId: "$_id.plantId",
            plantName: { name: "$plantName" },
            subtypeId: "$_id.subtypeId",
            subtypeName: "$subtypeName",
            deliveryDate: "$_id.deliveryDate",
            sowByDate: { $dateToString: { date: "$_id.sowByDate", format: "%d-%m-%Y" } },
            totalQuantityRequired: "$totalQuantityRequired",
            alreadySowed: "$alreadySowed",
            remainingToSow: "$remainingToSow",
            orderCount: "$orderCount",
            daysUntilSow: { $round: ["$daysUntilSow", 0] },
            priority: 1,
            plantReadyDays: 1,
            reminderType: "ORDER"
          }
        },
        { $sort: { daysUntilSow: 1 } }
      ])
    ]);

    // Combine both types of reminders
    const allReminders = [...slotWiseReminders, ...orderWiseReminders].sort((a, b) => a.daysUntilSow - b.daysUntilSow);

    res.status(200).json({
      success: true,
      data: allReminders,
      count: allReminders.length,
      slotWiseCount: slotWiseReminders.length,
      orderWiseCount: orderWiseReminders.length
    });

  } catch (error) {
    console.error("Error fetching hybrid sowing reminders:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching hybrid sowing reminders",
      error: error.message
    });
  }
};

// Get sowing dashboard stats - Day-wise based on delivery dates
export const getSowingStats = async (req, res) => {
  try {
    const today = moment();
    const nextWeek = moment().add(7, "days");

    // Get day-wise statistics from orders (only for sowing-allowed plants)
    const dayWiseStats = await Order.aggregate([
      // Only get orders with delivery dates
      {
        $match: {
          deliveryDate: { $exists: true, $ne: null },
          status: { $in: ["PENDING", "PROCESSING"] }
        }
      },
      // Unwind items to process each plant separately
      {
        $unwind: "$items"
      },
      // Lookup plant information
      {
        $lookup: {
          from: "plantcms",
          localField: "items.plantId",
          foreignField: "_id",
          as: "plantInfo"
        }
      },
      // Filter only sowing-allowed plants
      {
        $match: {
          "plantInfo.sowingAllowed": true
        }
      },
      // Lookup subtype information
      {
        $lookup: {
          from: "plantcms",
          let: { 
            plantId: "$items.plantId", 
            subtypeId: "$items.subtypeId" 
          },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$plantId"] }
              }
            },
            {
              $unwind: "$subtypes"
            },
            {
              $match: {
                $expr: { $eq: ["$subtypes._id", "$$subtypeId"] }
              }
            },
            {
              $project: {
                subtypeName: "$subtypes.name",
                plantReadyDays: "$subtypes.plantReadyDays"
              }
            }
          ],
          as: "subtypeInfo"
        }
      },
      // Calculate sowing date (delivery date - plant ready days)
      {
        $addFields: {
          plantName: { $arrayElemAt: ["$plantInfo.name", 0] },
          subtypeName: { $arrayElemAt: ["$subtypeInfo.subtypeName", 0] },
          plantReadyDays: { $arrayElemAt: ["$subtypeInfo.plantReadyDays", 0] },
          sowByDate: {
            $dateSubtract: {
              startDate: "$deliveryDate",
              unit: "day",
              amount: { $ifNull: ["$subtypeInfo.plantReadyDays", 0] }
            }
          }
        }
      },
      // Group by plant, subtype, and delivery date to calculate totals
      {
        $group: {
          _id: {
            plantId: "$items.plantId",
            subtypeId: "$items.subtypeId",
            deliveryDate: "$deliveryDate",
            sowByDate: "$sowByDate"
          },
          plantName: { $first: "$plantName" },
          subtypeName: { $first: "$subtypeName" },
          plantReadyDays: { $first: "$plantReadyDays" },
          totalQuantityRequired: { $sum: "$items.numberOfPlants" },
          orderCount: { $sum: 1 }
        }
      },
      // Lookup existing sowing records for this plant/subtype combination
      {
        $lookup: {
          from: "sowings",
          let: { 
            plantId: "$_id.plantId", 
            subtypeId: "$_id.subtypeId",
            sowByDate: "$_id.sowByDate"
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$plantId", "$$plantId"] },
                    { $eq: ["$subtypeId", "$$subtypeId"] },
                    { $eq: ["$sowingDate", "$$sowByDate"] }
                  ]
                }
              }
            }
          ],
          as: "existingSowings"
        }
      },
      // Calculate remaining quantity to sow
      {
        $addFields: {
          alreadySowed: {
            $sum: "$existingSowings.totalQuantityRequired"
          },
          remainingToSow: {
            $subtract: ["$totalQuantityRequired", { $sum: "$existingSowings.totalQuantityRequired" }]
          }
        }
      }
    ]);

    // Calculate overall statistics
    const overallStats = dayWiseStats.reduce((acc, item) => {
      acc.totalBookedPlants += item.totalQuantityRequired;
      acc.totalSowed += item.alreadySowed;
      acc.totalGap += item.remainingToSow;
      acc.daysWithGap += item.remainingToSow > 0 ? 1 : 0;
      return acc;
    }, {
      totalBookedPlants: 0,
      totalSowed: 0,
      totalGap: 0,
      daysWithGap: 0
    });

    // Get plant-wise statistics
    const plantWiseStats = await Order.aggregate([
      {
        $match: {
          deliveryDate: { $exists: true, $ne: null },
          status: { $in: ["PENDING", "PROCESSING"] }
        }
      },
      {
        $unwind: "$items"
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "items.plantId",
          foreignField: "_id",
          as: "plantInfo"
        }
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true
        }
      },
      {
        $group: {
          _id: "$items.plantId",
          plantName: { $first: { $arrayElemAt: ["$plantInfo.name", 0] } },
          totalBookedPlants: { $sum: "$items.numberOfPlants" },
          orderCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: "sowings",
          localField: "_id",
          foreignField: "plantId",
          as: "sowings"
        }
      },
      {
        $addFields: {
          totalSowed: { $sum: "$sowings.totalQuantityRequired" },
          totalGap: { $subtract: ["$totalBookedPlants", { $sum: "$sowings.totalQuantityRequired" }] }
        }
      },
      {
        $addFields: {
          completionPercentage: {
            $cond: [
              { $gt: ["$totalBookedPlants", 0] },
              { $multiply: [{ $divide: ["$totalSowed", "$totalBookedPlants"] }, 100] },
              0
            ]
          }
        }
      },
      {
        $sort: { totalGap: -1 }
      }
    ]);

    // Get subtype-wise statistics
    const subtypeWiseStats = await Order.aggregate([
      {
        $match: {
          deliveryDate: { $exists: true, $ne: null },
          status: { $in: ["PENDING", "PROCESSING"] }
        }
      },
      {
        $unwind: "$items"
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "items.plantId",
          foreignField: "_id",
          as: "plantInfo"
        }
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true
        }
      },
      {
        $lookup: {
          from: "plantcms",
          let: { 
            plantId: "$items.plantId", 
            subtypeId: "$items.subtypeId" 
          },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$plantId"] }
              }
            },
            {
              $unwind: "$subtypes"
            },
            {
              $match: {
                $expr: { $eq: ["$subtypes._id", "$$subtypeId"] }
              }
            },
            {
              $project: {
                subtypeName: "$subtypes.name",
                plantReadyDays: "$subtypes.plantReadyDays"
              }
            }
          ],
          as: "subtypeInfo"
        }
      },
      {
        $group: {
          _id: {
            plantId: "$items.plantId",
            subtypeId: "$items.subtypeId"
          },
          plantName: { $first: { $arrayElemAt: ["$plantInfo.name", 0] } },
          subtypeName: { $first: { $arrayElemAt: ["$subtypeInfo.subtypeName", 0] } },
          plantReadyDays: { $first: { $arrayElemAt: ["$subtypeInfo.plantReadyDays", 0] } },
          totalBookedPlants: { $sum: "$items.numberOfPlants" },
          orderCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: "sowings",
          let: { 
            plantId: "$_id.plantId", 
            subtypeId: "$_id.subtypeId" 
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$plantId", "$$plantId"] },
                    { $eq: ["$subtypeId", "$$subtypeId"] }
                  ]
                }
              }
            }
          ],
          as: "sowings"
        }
      },
      {
        $addFields: {
          totalSowed: { $sum: "$sowings.totalQuantityRequired" },
          totalGap: { $subtract: ["$totalBookedPlants", { $sum: "$sowings.totalQuantityRequired" }] }
        }
      },
      {
        $addFields: {
          completionPercentage: {
            $cond: [
              { $gt: ["$totalBookedPlants", 0] },
              { $multiply: [{ $divide: ["$totalSowed", "$totalBookedPlants"] }, 100] },
              0
            ]
          }
        }
      },
      {
        $sort: { totalGap: -1 }
      }
    ]);

    // Get upcoming sowings (next 7 days) - day-wise
    const upcomingSowings = dayWiseStats
      .filter(item => {
        const sowByDate = moment(item._id.sowByDate);
        return sowByDate.isBetween(today, nextWeek, null, '[]') && item.remainingToSow > 0;
      })
      .sort((a, b) => moment(a._id.sowByDate).diff(moment(b._id.sowByDate)))
      .slice(0, 10)
      .map(item => ({
        _id: item._id,
        plantId: item._id.plantId,
        plantName: item.plantName,
        subtypeName: item.subtypeName,
        totalQuantityRequired: item.remainingToSow,
        sowingDate: moment(item._id.sowByDate).format("DD-MM-YYYY"),
        daysUntilSow: moment(item._id.sowByDate).diff(today, 'days')
      }));

    return res.status(200).json({
      success: true,
      stats: {
        total: dayWiseStats.length,
        pending: dayWiseStats.filter(item => item.remainingToSow > 0).length,
        overdue: dayWiseStats.filter(item => {
          const sowByDate = moment(item._id.sowByDate);
          return sowByDate.isBefore(today) && item.remainingToSow > 0;
        }).length,
        ready: dayWiseStats.filter(item => item.remainingToSow === 0).length,
        todayReminders: dayWiseStats.filter(item => {
          const sowByDate = moment(item._id.sowByDate);
          return sowByDate.isSame(today, 'day') && item.remainingToSow > 0;
        }).length,
        // Day-wise gap statistics
        totalBookedPlants: overallStats.totalBookedPlants,
        totalSowed: overallStats.totalSowed,
        totalGap: overallStats.totalGap,
        daysWithGap: overallStats.daysWithGap,
        totalPlants: overallStats.totalBookedPlants // In day-wise, total plants = total booked
      },
      plantWiseStats,
      subtypeWiseStats,
      upcomingSowings,
    });
  } catch (error) {
    console.error("Error fetching sowing stats:", error);
    return res.status(500).json({
      message: "Error fetching sowing statistics",
      error: error.message,
    });
  }
};

// Delete sowing record
export const deleteSowing = async (req, res) => {
  try {
    const { id } = req.params;

    const sowing = await Sowing.findByIdAndDelete(id);

    if (!sowing) {
      return res.status(404).json({ message: "Sowing record not found" });
    }

    return res.status(200).json({
      message: "Sowing record deleted successfully",
      data: sowing,
    });
  } catch (error) {
    console.error("Error deleting sowing:", error);
    return res.status(500).json({
      message: "Error deleting sowing record",
      error: error.message,
    });
  }
};

// Update sowing record
export const updateSowing = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const sowing = await Sowing.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!sowing) {
      return res.status(404).json({ message: "Sowing record not found" });
    }

    return res.status(200).json({
      message: "Sowing record updated successfully",
      data: sowing,
    });
  } catch (error) {
    console.error("Error updating sowing:", error);
    return res.status(500).json({
      message: "Error updating sowing record",
      error: error.message,
    });
  }
};

// Get comprehensive sowing insights for CEO dashboard
export const getSowingInsights = async (req, res) => {
  try {
    const today = moment();
    const startOfMonth = moment().startOf('month');
    const endOfMonth = moment().endOf('month');
    const lastMonth = moment().subtract(1, 'month');
    const nextMonth = moment().add(1, 'month');

    // 1. OVERALL SOWING PERFORMANCE METRICS
    const overallStats = await Promise.all([
      // Total sowing records this month
      Sowing.countDocuments({
        createdAt: {
          $gte: startOfMonth.toDate(),
          $lte: endOfMonth.toDate()
        }
      }),
      
      // Total plants sowed this month
      Sowing.aggregate([
        {
          $match: {
            createdAt: {
              $gte: startOfMonth.toDate(),
              $lte: endOfMonth.toDate()
            }
          }
        },
        {
          $group: {
            _id: null,
            totalSowed: { $sum: { $add: ["$officeSowed", "$primarySowed"] } },
            totalRequired: { $sum: "$totalQuantityRequired" }
          }
        }
      ]),

      // Pending sowings count
      Sowing.countDocuments({
        status: { $in: ["PENDING", "PARTIALLY_SOWED"] }
      }),

      // Overdue sowings count
      Sowing.countDocuments({
        status: "OVERDUE"
      })
    ]);

    // 2. VARIETY-WISE SOWING ANALYTICS
    const varietyStats = await Sowing.aggregate([
      {
        $match: {
          createdAt: {
            $gte: startOfMonth.toDate(),
            $lte: endOfMonth.toDate()
          }
        }
      },
      {
        $group: {
          _id: {
            plantName: "$plantName",
            subtypeName: "$subtypeName"
          },
          totalRequired: { $sum: "$totalQuantityRequired" },
          totalSowed: { $sum: { $add: ["$officeSowed", "$primarySowed"] } },
          sowingCount: { $sum: 1 },
          avgPlantReadyDays: { $avg: "$plantReadyDays" }
        }
      },
      {
        $addFields: {
          completionRate: {
            $cond: [
              { $gt: ["$totalRequired", 0] },
              { $multiply: [{ $divide: ["$totalSowed", "$totalRequired"] }, 100] },
              0
            ]
          }
        }
      },
      { $sort: { totalRequired: -1 } },
      { $limit: 10 }
    ]);

    // 3. MONTHLY SOWING TRENDS
    const monthlyTrends = await Sowing.aggregate([
      {
        $match: {
          createdAt: {
            $gte: lastMonth.startOf('month').toDate(),
            $lte: nextMonth.endOf('month').toDate()
          }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" }
          },
          totalSowings: { $sum: 1 },
          totalPlantsSowed: { $sum: { $add: ["$officeSowed", "$primarySowed"] } },
          totalRequired: { $sum: "$totalQuantityRequired" }
        }
      },
      {
        $addFields: {
          monthName: {
            $switch: {
              branches: [
                { case: { $eq: ["$_id.month", 1] }, then: "January" },
                { case: { $eq: ["$_id.month", 2] }, then: "February" },
                { case: { $eq: ["$_id.month", 3] }, then: "March" },
                { case: { $eq: ["$_id.month", 4] }, then: "April" },
                { case: { $eq: ["$_id.month", 5] }, then: "May" },
                { case: { $eq: ["$_id.month", 6] }, then: "June" },
                { case: { $eq: ["$_id.month", 7] }, then: "July" },
                { case: { $eq: ["$_id.month", 8] }, then: "August" },
                { case: { $eq: ["$_id.month", 9] }, then: "September" },
                { case: { $eq: ["$_id.month", 10] }, then: "October" },
                { case: { $eq: ["$_id.month", 11] }, then: "November" },
                { case: { $eq: ["$_id.month", 12] }, then: "December" }
              ],
              default: "Unknown"
            }
          },
          completionRate: {
            $cond: [
              { $gt: ["$totalRequired", 0] },
              { $multiply: [{ $divide: ["$totalPlantsSowed", "$totalRequired"] }, 100] },
              0
            ]
          }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);

    // 4. SOWING LOCATION ANALYSIS
    const locationStats = await Sowing.aggregate([
      {
        $match: {
          createdAt: {
            $gte: startOfMonth.toDate(),
            $lte: endOfMonth.toDate()
          }
        }
      },
      {
        $group: {
          _id: "$sowingLocation",
          totalSowings: { $sum: 1 },
          totalPlantsSowed: { $sum: { $add: ["$officeSowed", "$primarySowed"] } },
          totalRequired: { $sum: "$totalQuantityRequired" }
        }
      },
      {
        $addFields: {
          completionRate: {
            $cond: [
              { $gt: ["$totalRequired", 0] },
              { $multiply: [{ $divide: ["$totalPlantsSowed", "$totalRequired"] }, 100] },
              0
            ]
          }
        }
      }
    ]);

    // 5. UPCOMING SOWING REQUIREMENTS
    const upcomingSowings = await Sowing.aggregate([
      {
        $match: {
          status: { $in: ["PENDING", "PARTIALLY_SOWED"] },
          sowingDate: { $gte: today.format("DD-MM-YYYY") }
        }
      },
      {
        $addFields: {
          sowingDateObj: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$sowingDate", 6, 4] },
                  "-",
                  { $substr: ["$sowingDate", 3, 2] },
                  "-",
                  { $substr: ["$sowingDate", 0, 2] }
                ]
              },
              format: "%Y-%m-%d"
            }
          }
        }
      },
      {
        $addFields: {
          daysUntilSowing: {
            $divide: [
              { $subtract: ["$sowingDateObj", new Date()] },
              1000 * 60 * 60 * 24
            ]
          }
        }
      },
      {
        $match: {
          daysUntilSowing: { $lte: 7, $gte: 0 }
        }
      },
      {
        $group: {
          _id: "$sowingDate",
          totalRequired: { $sum: "$totalQuantityRequired" },
          totalSowed: { $sum: { $add: ["$officeSowed", "$primarySowed"] } },
          sowings: { $push: "$$ROOT" }
        }
      },
      {
        $addFields: {
          remainingToSow: { $subtract: ["$totalRequired", "$totalSowed"] },
          priority: {
            $cond: [
              { $lte: ["$daysUntilSowing", 2] },
              "urgent",
              "upcoming"
            ]
          }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    // 6. SOWING EFFICIENCY METRICS
    const efficiencyMetrics = await Sowing.aggregate([
      {
        $match: {
          createdAt: {
            $gte: startOfMonth.toDate(),
            $lte: endOfMonth.toDate()
          }
        }
      },
      {
        $group: {
          _id: null,
          totalSowings: { $sum: 1 },
          totalRequired: { $sum: "$totalQuantityRequired" },
          totalSowed: { $sum: { $add: ["$officeSowed", "$primarySowed"] } },
          avgPlantReadyDays: { $avg: "$plantReadyDays" },
          completedSowings: {
            $sum: {
              $cond: [
                { $gte: [{ $add: ["$officeSowed", "$primarySowed"] }, "$totalQuantityRequired"] },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $addFields: {
          overallCompletionRate: {
            $cond: [
              { $gt: ["$totalRequired", 0] },
              { $multiply: [{ $divide: ["$totalSowed", "$totalRequired"] }, 100] },
              0
            ]
          },
          completionRate: {
            $cond: [
              { $gt: ["$totalSowings", 0] },
              { $multiply: [{ $divide: ["$completedSowings", "$totalSowings"] }, 100] },
              0
            ]
          }
        }
      }
    ]);

    // 7. TOP PERFORMING PLANTS
    const topPerformingPlants = await Sowing.aggregate([
      {
        $match: {
          createdAt: {
            $gte: startOfMonth.toDate(),
            $lte: endOfMonth.toDate()
          }
        }
      },
      {
        $group: {
          _id: "$plantName",
          totalSowings: { $sum: 1 },
          totalRequired: { $sum: "$totalQuantityRequired" },
          totalSowed: { $sum: { $add: ["$officeSowed", "$primarySowed"] } },
          avgPlantReadyDays: { $avg: "$plantReadyDays" }
        }
      },
      {
        $addFields: {
          completionRate: {
            $cond: [
              { $gt: ["$totalRequired", 0] },
              { $multiply: [{ $divide: ["$totalSowed", "$totalRequired"] }, 100] },
              0
            ]
          }
        }
      },
      { $sort: { completionRate: -1 } },
      { $limit: 5 }
    ]);

    // 8. SOWING ALERTS AND RECOMMENDATIONS
    const alerts = [];
    
    // Check for overdue sowings
    const overdueCount = overallStats[3];
    if (overdueCount > 0) {
      alerts.push({
        type: "warning",
        message: `${overdueCount} sowing(s) are overdue and need immediate attention`,
        priority: "high"
      });
    }

    // Check for upcoming urgent sowings
    const urgentSowings = upcomingSowings.filter(s => s.priority === "urgent").length;
    if (urgentSowings > 0) {
      alerts.push({
        type: "info",
        message: `${urgentSowings} sowing(s) need to be completed within 2 days`,
        priority: "medium"
      });
    }

    // Check overall completion rate
    const overallCompletion = efficiencyMetrics[0]?.overallCompletionRate || 0;
    if (overallCompletion < 80) {
      alerts.push({
        type: "warning",
        message: `Overall sowing completion rate is ${overallCompletion.toFixed(1)}%, below target of 80%`,
        priority: "medium"
      });
    }

    const response = {
      success: true,
      data: {
        overview: {
          totalSowingsThisMonth: overallStats[0],
          totalPlantsSowedThisMonth: overallStats[1][0]?.totalSowed || 0,
          totalRequiredThisMonth: overallStats[1][0]?.totalRequired || 0,
          pendingSowings: overallStats[2],
          overdueSowings: overallStats[3],
          overallCompletionRate: efficiencyMetrics[0]?.overallCompletionRate || 0,
          sowingCompletionRate: efficiencyMetrics[0]?.completionRate || 0
        },
        varietyAnalytics: varietyStats,
        monthlyTrends: monthlyTrends,
        locationAnalysis: locationStats,
        upcomingSowings: upcomingSowings,
        efficiencyMetrics: efficiencyMetrics[0] || {},
        topPerformingPlants: topPerformingPlants,
        alerts: alerts,
        generatedAt: new Date(),
        period: {
          start: startOfMonth.format("DD-MM-YYYY"),
          end: endOfMonth.format("DD-MM-YYYY")
        }
      }
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error("Error fetching sowing insights:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching sowing insights",
      error: error.message,
    });
  }
};

