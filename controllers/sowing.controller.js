import Sowing from "../models/sowing.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
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

// Get pending sowing reminders (for today or past due)
export const getPendingReminders = async (req, res) => {
  try {
    const today = moment().format("DD-MM-YYYY");

    const reminders = await Sowing.find({
      status: { $in: ["PENDING", "PARTIALLY_SOWED", "OVERDUE"] },
      reminderDate: { $lte: today },
    })
      .populate("plantId", "name")
      .populate("createdBy", "name phoneNumber")
      .sort({ reminderDate: 1 });

    return res.status(200).json({
      success: true,
      data: reminders,
      count: reminders.length,
    });
  } catch (error) {
    console.error("Error fetching reminders:", error);
    return res.status(500).json({
      message: "Error fetching reminders",
      error: error.message,
    });
  }
};

// Get sowing dashboard stats
export const getSowingStats = async (req, res) => {
  try {
    const today = moment().format("DD-MM-YYYY");

    const [
      totalSowings,
      pendingSowings,
      overdueSowings,
      readySowings,
      todayReminders,
    ] = await Promise.all([
      Sowing.countDocuments(),
      Sowing.countDocuments({ status: { $in: ["PENDING", "PARTIALLY_SOWED"] } }),
      Sowing.countDocuments({ status: "OVERDUE" }),
      Sowing.countDocuments({ status: "READY" }),
      Sowing.countDocuments({
        reminderDate: today,
        status: { $in: ["PENDING", "PARTIALLY_SOWED", "OVERDUE"] },
      }),
    ]);

    // Get upcoming sowings (next 7 days)
    const nextWeek = moment().add(7, "days").format("DD-MM-YYYY");
    const upcomingSowings = await Sowing.find({
      sowingDate: { $gte: today, $lte: nextWeek },
      status: "PENDING",
    })
      .populate("plantId", "name")
      .limit(10);

    return res.status(200).json({
      success: true,
      stats: {
        total: totalSowings,
        pending: pendingSowings,
        overdue: overdueSowings,
        ready: readySowings,
        todayReminders,
      },
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

