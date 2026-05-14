import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";

// Add a new plant with subtypes
export const addPlant = async (req, res) => {
  const { name, subtypes, addedBy, slotSize, buffer, sowingAllowed, dailyDispatchCapacity, sowingBuffer } = req.body;

  try {
    // Check if a plant with the same name already exists
    const existingPlant = await PlantCms.findOne({ name });
    if (existingPlant) {
      return res.status(400).json({ message: "Plant name must be unique" });
    }

    // Process subtypes to include required fields and validate structure
    const processedSubtypes = subtypes.map((subtype) => {
      if (!subtype.name) {
        throw new Error("Each subtype must have a name.");
      }
      if (!subtype.slotDays) {
        throw new Error("Each subtype must have slotDays.");
      }
      if (!subtype.slotStartDate) {
        throw new Error("Each subtype must have slotStartDate.");
      }
      if (!subtype.slotEndDate) {
        throw new Error("Each subtype must have slotEndDate.");
      }
      if (!subtype.slotCapacity) {
        throw new Error("Each subtype must have slotCapacity.");
      }

      return {
        name: subtype.name,
        description: subtype.description || "",
        characteristics: subtype.characteristics || {},
        rates: Array.isArray(subtype.rates) ? subtype.rates : [], // Ensure rates is an array
        monthlyRates: Array.isArray(subtype.monthlyRates) ? subtype.monthlyRates : [],
        buffer: subtype.buffer || 0,
        plantReadyDays: subtype.plantReadyDays || 0, // Plant ready days for sowing
        slotDays: subtype.slotDays, // Slot days for this subtype
        slotStartDate: subtype.slotStartDate, // Slot start date for this subtype
        slotEndDate: subtype.slotEndDate, // Slot end date for this subtype
        slotCapacity: subtype.slotCapacity, // Slot capacity for this subtype
      };
    });

    // Create a new plant document
    const newPlant = new PlantCms({
      name,
      subtypes: processedSubtypes,
      addedBy,
      slotSize: slotSize || 5, // Default slot size to 5 if not provided
      buffer: buffer || 0, // Default buffer to 0 if not provided
      sowingAllowed: sowingAllowed || false, // Default sowing allowed to false
      dailyDispatchCapacity: dailyDispatchCapacity || 2000, // Default daily dispatch capacity
      sowingBuffer: sowingBuffer || 0, // Default sowing buffer
    });

    const savedPlant = await newPlant.save();

    console.log('=== Creating slots for new plant ===');
    console.log(`Plant: ${savedPlant.name}, Subtypes: ${savedPlant.subtypes.length}`);
    
    // Create slots for all subtypes of the new plant
    if (savedPlant.subtypes && savedPlant.subtypes.length > 0) {
      for (const subtype of savedPlant.subtypes) {
        console.log(`Creating slots for subtype: ${subtype.name}`);
        const success = await createSlotsForNewSubtype(savedPlant._id, subtype._id, subtype);
        console.log(`Slot creation ${success ? 'SUCCESS' : 'FAILED'} for subtype: ${subtype.name}`);
      }
    }
    console.log('===================================\n');

    return res
      .status(201)
      .json({ 
        message: "Plant added successfully", 
        data: savedPlant,
        slotsCreated: `Slots created for ${savedPlant.subtypes.length} subtype(s)`
      });
  } catch (error) {
    console.error("Error adding plant:", error.message);
    return res.status(500).json({
      message: "Error adding plant",
      error: error.message,
    });
  }
};

// Helper function to create slots for a specific subtype
const createSlotsForNewSubtype = async (plantId, subtypeId, subtype) => {
  try {
    console.log(`\n📦 Creating slots for subtype ${subtype.name}...`);
    console.log('Slot Config:', {
      slotDays: subtype.slotDays,
      slotStartDate: subtype.slotStartDate,
      slotEndDate: subtype.slotEndDate,
      slotCapacity: subtype.slotCapacity
    });
    
    const moment = await import('moment');
    
    // Convert date format from YYYY-MM-DD (date picker) to DD-MM-YYYY (internal format)
    const convertDate = (dateStr) => {
      if (dateStr.includes('-') && dateStr.split('-')[0].length === 4) {
        // YYYY-MM-DD format from date picker
        const [year, month, day] = dateStr.split('-');
        return `${day}-${month}-${year}`;
      }
      // Already in DD-MM-YYYY format
      return dateStr;
    };
    
    const startDate = convertDate(subtype.slotStartDate);
    const endDate = convertDate(subtype.slotEndDate);
    
    console.log('Converted dates:', { startDate, endDate });
    
    // Parse dates to get year range
    const startMoment = moment.default(startDate, 'DD-MM-YYYY');
    const endMoment = moment.default(endDate, 'DD-MM-YYYY');
    const startYear = startMoment.year();
    const endYear = endMoment.year();
    
    console.log('Year range:', { startYear, endYear });
    
    // Generate slots for each year in the date range
    for (let year = startYear; year <= endYear; year++) {
      // Check if slots already exist for this plant and year
      let plantSlotDoc = await PlantSlot.findOne({
        plantId: plantId,
        year: year
      });
      
      // Determine date range for this specific year
      let yearStartDate, yearEndDate;
      if (year === startYear && year === endYear) {
        // Same year - use full range
        yearStartDate = startDate;
        yearEndDate = endDate;
      } else if (year === startYear) {
        // First year - from start date to year end
        yearStartDate = startDate;
        yearEndDate = `31-12-${year}`;
      } else if (year === endYear) {
        // Last year - from year start to end date
        yearStartDate = `01-01-${year}`;
        yearEndDate = endDate;
      } else {
        // Middle year - full year
        yearStartDate = `01-01-${year}`;
        yearEndDate = `31-12-${year}`;
      }
      
      // Generate slots using the slot days configuration
      const slots = [];
      let currentDate = moment.default(yearStartDate, 'DD-MM-YYYY');
      const endDateMoment = moment.default(yearEndDate, 'DD-MM-YYYY');
      
      while (currentDate.isSameOrBefore(endDateMoment)) {
        const slotStart = currentDate.clone();
        let slotEnd = currentDate.clone().add(subtype.slotDays - 1, 'days');
        
        // Don't exceed the end date
        if (slotEnd.isAfter(endDateMoment)) {
          slotEnd = endDateMoment.clone();
        }
        
        // Don't exceed month boundary
        const monthEnd = slotStart.clone().endOf('month');
        if (slotEnd.isAfter(monthEnd)) {
          slotEnd = monthEnd.clone();
        }
        
        slots.push({
          startDay: slotStart.format('DD-MM-YYYY'),
          endDay: slotEnd.format('DD-MM-YYYY'),
          month: slotStart.format('MMMM'),
          totalPlants: subtype.slotCapacity || 0,
          availablePlants: subtype.slotCapacity || 0,
          buffer: subtype.buffer || 0,
          plantReadyDays: subtype.plantReadyDays || 0,
          status: true, // ✅ Set status to true so slots are visible
          isManual: false,
        });
        
        // Move to next period
        currentDate = slotEnd.clone().add(1, 'days');
      }
      
      console.log(`Generated ${slots.length} slots for year ${year}`);
      
      if (plantSlotDoc) {
        // Add new subtype slots to existing document
        console.log(`Adding to existing PlantSlot document for year ${year}`);
        plantSlotDoc.subtypeSlots.push({
          subtypeId: subtypeId,
          slots: slots
        });
        await plantSlotDoc.save();
      } else {
        // Create new plant slot document
        console.log(`Creating new PlantSlot document for year ${year}`);
        const newPlantSlot = new PlantSlot({
          plantId: plantId,
          year: year,
          subtypeSlots: [{
            subtypeId: subtypeId,
            slots: slots
          }]
        });
        await newPlantSlot.save();
      }
    }
    
    console.log(`✅ Successfully created slots for subtype ${subtype.name}\n`);
    return true;
  } catch (error) {
    console.error(`❌ Error creating slots for new subtype:`, error);
    return false;
  }
};

// Update a plant's details, subtypes, or slotSize
export const updatePlant = async (req, res) => {
  const { plantId } = req.params;
  const { name, subtypes, slotSize, buffer, sowingAllowed, dailyDispatchCapacity, sowingBuffer } = req.body;

  try {
    const plant = await PlantCms.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    // Track existing subtype IDs + ready days before update
    const existingSubtypeIds = plant.subtypes.map(st => st._id.toString());
    const previousSubtypeReadyDays = new Map(
      (plant.subtypes || []).map((st) => [st._id.toString(), Number(st.plantReadyDays) || 0])
    );

    // Update plant fields
    plant.name = name || plant.name;
    plant.slotSize = slotSize || plant.slotSize;
    plant.buffer = buffer !== undefined ? buffer : plant.buffer;
    plant.sowingAllowed = sowingAllowed !== undefined ? sowingAllowed : plant.sowingAllowed;
    plant.dailyDispatchCapacity = dailyDispatchCapacity || plant.dailyDispatchCapacity;
    plant.sowingBuffer = sowingBuffer !== undefined ? sowingBuffer : plant.sowingBuffer;

    if (subtypes) {
      // Process and validate subtypes
      const processedSubtypes = subtypes.map((subtype) => {
        if (!subtype.name) {
          throw new Error("Each subtype must have a name.");
        }
        if (!subtype.slotDays && !subtype._id) {
          throw new Error("Each new subtype must have slotDays.");
        }
        if (!subtype.slotStartDate && !subtype._id) {
          throw new Error("Each new subtype must have slotStartDate.");
        }
        if (!subtype.slotEndDate && !subtype._id) {
          throw new Error("Each new subtype must have slotEndDate.");
        }
        if (!subtype.slotCapacity && !subtype._id) {
          throw new Error("Each new subtype must have slotCapacity.");
        }

        return {
          ...subtype,
          name: subtype.name,
          description: subtype.description || "",
          characteristics: subtype.characteristics || {},
          rates: Array.isArray(subtype.rates) ? subtype.rates : [],
          monthlyRates: Array.isArray(subtype.monthlyRates) ? subtype.monthlyRates : [],
          buffer: subtype.buffer || 0,
          plantReadyDays: subtype.plantReadyDays || 0,
          slotDays: subtype.slotDays || subtype.slotSize || plant.slotSize,
          slotStartDate: subtype.slotStartDate || '',
          slotEndDate: subtype.slotEndDate || '',
          slotCapacity: subtype.slotCapacity || 0,
        };
      });

      plant.subtypes = processedSubtypes;
    }

    const updatedPlant = await plant.save();

    // Identify newly added subtypes (those without _id or with new _id)
    const newSubtypes = updatedPlant.subtypes.filter(
      st => !existingSubtypeIds.includes(st._id.toString())
    );

    console.log('=== Slot Creation Debug ===');
    console.log('Existing subtype IDs:', existingSubtypeIds);
    console.log('Updated plant subtypes:', updatedPlant.subtypes.map(st => ({ id: st._id.toString(), name: st.name })));
    console.log('New subtypes to create slots for:', newSubtypes.map(st => ({ id: st._id.toString(), name: st.name })));
    console.log('=========================');

    // Create slots for newly added subtypes only
    if (newSubtypes.length > 0) {
      console.log(`Creating slots for ${newSubtypes.length} new subtype(s)...`);
      for (const subtype of newSubtypes) {
        console.log(`Creating slots for subtype: ${subtype.name}, from ${subtype.slotStartDate} to ${subtype.slotEndDate}`);
        const success = await createSlotsForNewSubtype(plantId, subtype._id, subtype);
        console.log(`Slot creation ${success ? 'SUCCESS' : 'FAILED'} for subtype: ${subtype.name}`);
      }
    } else {
      console.log('No new subtypes detected - skipping slot creation');
    }

    // For existing subtypes, if plantReadyDays changed from this PUT call,
    // propagate to future slots so today/easy sowing calculations stay consistent.
    const changedExistingSubtypeReadyDays = [];
    for (const st of updatedPlant.subtypes || []) {
      const subtypeId = st._id.toString();
      if (!existingSubtypeIds.includes(subtypeId)) continue; // new subtype handled above
      const oldReadyDays = previousSubtypeReadyDays.get(subtypeId);
      const newReadyDays = Number(st.plantReadyDays) || 0;
      if (oldReadyDays !== newReadyDays) {
        changedExistingSubtypeReadyDays.push({ subtypeId, oldReadyDays, newReadyDays });
      }
    }

    const parseDdMmYyyy = (value) => {
      if (!value || typeof value !== "string") return null;
      const m = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (!m) return null;
      const dt = new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00.000Z`);
      return Number.isNaN(dt.getTime()) ? null : dt;
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const readyDaysSync = [];

    if (changedExistingSubtypeReadyDays.length > 0) {
      const slotDocs = await PlantSlot.find({ plantId: updatedPlant._id });
      for (const slotDoc of slotDocs) {
        let modified = false;
        for (const subtypeSlot of slotDoc.subtypeSlots || []) {
          const change = changedExistingSubtypeReadyDays.find(
            (x) => x.subtypeId === subtypeSlot.subtypeId?.toString()
          );
          if (!change) continue;

          for (const slot of subtypeSlot.slots || []) {
            const slotEnd = parseDdMmYyyy(slot.endDay);
            if (!slotEnd || slotEnd < today) continue; // future (and today) only
            if ((Number(slot.plantReadyDays) || 0) === change.newReadyDays) continue;
            slot.plantReadyDays = change.newReadyDays;
            modified = true;
            readyDaysSync.push({
              slotId: slot._id.toString(),
              subtypeId: change.subtypeId,
              oldPlantReadyDays: change.oldReadyDays,
              newPlantReadyDays: change.newReadyDays,
              slotStartDay: slot.startDay,
              slotEndDay: slot.endDay,
            });
          }
        }
        if (modified) {
          slotDoc.markModified("subtypeSlots");
          await slotDoc.save();
        }
      }
    }

    return res
      .status(200)
      .json({ 
        message: "Plant updated successfully", 
        data: updatedPlant,
        slotsCreated: newSubtypes.length > 0 ? `Slots created for ${newSubtypes.length} new subtype(s)` : 'No new subtypes added',
        readyDaysSyncedCount: readyDaysSync.length,
        readyDaysSynced: readyDaysSync,
      });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error updating plant", error: error.message });
  }
};

// Delete a plant
export const deletePlant = async (req, res) => {
  const { plantId } = req.params;

  try {
    // Find the plant
    const plant = await PlantCms.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    console.log(`🗑️ Attempting to delete plant: ${plant.name} (ID: ${plantId})`);

    // Safety Check 1: Check if there are any orders related to this plant
    const ordersWithPlant = await Order.countDocuments({ 
      plantName: plantId 
    });

    if (ordersWithPlant > 0) {
      console.log(`❌ Cannot delete plant: ${ordersWithPlant} order(s) exist for this plant`);
      return res.status(400).json({ 
        message: "Cannot delete plant", 
        reason: `This plant is associated with ${ordersWithPlant} order(s). Please remove or cancel all related orders first.`,
        orderCount: ordersWithPlant
      });
    }

    // Safety Check 2: Check if there are any inventory outward records for any subtype of this plant
    const mongoose = await import('mongoose');
    const InventoryOutward = mongoose.default.models.InventoryOutward;
    
    if (InventoryOutward) {
      const subtypeIds = plant.subtypes.map(st => st._id);
      const inventoryOutwards = await InventoryOutward.countDocuments({
        'plantSubtype': { $in: subtypeIds },
        'status': { $ne: 'cancelled' }
      });

      if (inventoryOutwards > 0) {
        console.log(`❌ Cannot delete plant: ${inventoryOutwards} inventory outward record(s) exist for this plant's subtypes`);
        return res.status(400).json({
          message: "Cannot delete plant",
          reason: `This plant has ${inventoryOutwards} active inventory outward record(s). Please resolve them first.`,
          inventoryOutwardCount: inventoryOutwards
        });
      }
    }

    // Safety Check 3: Check if there are any slots with bookings for this plant
    const slotsWithBookings = await PlantSlot.aggregate([
      {
        $match: {
          plantId: mongoose.default.Types.ObjectId(plantId)
        }
      },
      {
        $unwind: "$subtypeSlots"
      },
      {
        $unwind: "$subtypeSlots.slots"
      },
      {
        $match: {
          "subtypeSlots.slots.orders": { $exists: true, $ne: [] }
        }
      },
      {
        $count: "slotsWithOrders"
      }
    ]);

    if (slotsWithBookings.length > 0 && slotsWithBookings[0].slotsWithOrders > 0) {
      console.log(`❌ Cannot delete plant: ${slotsWithBookings[0].slotsWithOrders} slot(s) have bookings`);
      return res.status(400).json({
        message: "Cannot delete plant",
        reason: `This plant has ${slotsWithBookings[0].slotsWithOrders} slot(s) with active bookings. Please clear the bookings first.`,
        slotsWithBookings: slotsWithBookings[0].slotsWithOrders
      });
    }

    // All checks passed - proceed with deletion
    console.log(`✅ Safety checks passed. Proceeding with plant deletion...`);

    // Delete related slots
    const slotDeletionResult = await PlantSlot.deleteMany({ plantId });
    console.log(`🗑️ Deleted ${slotDeletionResult.deletedCount} slot document(s) for plant`);

    // Delete the plant
    const deletedPlant = await PlantCms.findByIdAndDelete(plantId);

    console.log(`✅ Successfully deleted plant: ${plant.name}`);

    return res.status(200).json({
      message: "Plant and related slots deleted successfully",
      data: deletedPlant,
      slotsDeleted: slotDeletionResult.deletedCount
    });
  } catch (error) {
    console.error("❌ Error deleting plant and related slots:", error);
    return res
      .status(500)
      .json({ message: "Error deleting plant", error: error.message });
  }
};
// Add a new subtype to an existing plant
export const addSubtype = async (req, res) => {
  const { plantId } = req.params;
  const { name, description, characteristics } = req.body;

  try {
    const plant = await PlantCms.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    plant.subtypes.push({ name, description, characteristics });
    const updatedPlant = await plant.save();

    return res
      .status(200)
      .json({ message: "Subtype added successfully", data: updatedPlant });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error adding subtype", error: error.message });
  }
};

// Update a specific subtype
export const updateSubtype = async (req, res) => {
  const { plantId, subtypeId } = req.params;
  const { name, description, characteristics, plantReadyDays, monthlyRates } = req.body;

  try {
    // Build the $set payload using the positional $ operator so we only update
    // the matched subtype's fields — avoids full-document validation which would
    // fail for older subtypes that predate the required slotDays/slotCapacity fields.
    const setFields = {};

    if (name !== undefined) setFields["subtypes.$.name"] = name;
    if (description !== undefined) setFields["subtypes.$.description"] = description;
    if (characteristics !== undefined) setFields["subtypes.$.characteristics"] = characteristics;
    if (plantReadyDays !== undefined) setFields["subtypes.$.plantReadyDays"] = Number(plantReadyDays) || 0;
    if (monthlyRates !== undefined) {
      setFields["subtypes.$.monthlyRates"] = Array.isArray(monthlyRates)
        ? monthlyRates
            .filter((mr) => mr.month && mr.rate !== "" && mr.rate !== null && mr.rate !== undefined)
            .map((mr) => ({ month: mr.month, rate: Number(mr.rate) || 0 }))
        : [];
    }

    if (Object.keys(setFields).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    const result = await PlantCms.findOneAndUpdate(
      { _id: plantId, "subtypes._id": subtypeId },
      { $set: setFields },
      { new: true, runValidators: false }
    );

    if (!result) {
      return res.status(404).json({ message: "Plant or subtype not found" });
    }

    return res
      .status(200)
      .json({ message: "Subtype updated successfully", data: result });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error updating subtype", error: error.message });
  }
};

// Delete a specific subtype
export const deleteSubtype = async (req, res) => {
  const { plantId, subtypeId } = req.params;

  try {
    const plant = await PlantCms.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    const subtype = plant.subtypes.id(subtypeId);

    if (!subtype) {
      return res.status(404).json({ message: "Subtype not found" });
    }

    console.log(`🗑️ Attempting to delete subtype: ${subtype.name} (ID: ${subtypeId})`);

    // Safety Check 1: Check if there are any orders related to this subtype
    const ordersWithSubtype = await Order.countDocuments({ 
      plantSubtype: subtypeId 
    });

    if (ordersWithSubtype > 0) {
      console.log(`❌ Cannot delete subtype: ${ordersWithSubtype} order(s) exist for this subtype`);
      return res.status(400).json({ 
        message: "Cannot delete subtype", 
        reason: `This subtype is associated with ${ordersWithSubtype} order(s). Please remove or cancel all related orders first.`,
        orderCount: ordersWithSubtype
      });
    }

    // Safety Check 2: Check if there are any inventory batches locked for this subtype
    // Note: Assuming inventory batches might have a reference to plant subtype
    // If your inventory model has a different structure, adjust this query accordingly
    const mongoose = await import('mongoose');
    
    // Check if there are any sowing requests or inventory outwards related to this plant/subtype
    const InventoryOutward = mongoose.default.models.InventoryOutward;
    if (InventoryOutward) {
      // Check for any inventory outward records that might be related to this subtype
      const inventoryOutwards = await InventoryOutward.countDocuments({
        'plantSubtype': subtypeId,
        'status': { $ne: 'cancelled' } // Exclude cancelled records
      });

      if (inventoryOutwards > 0) {
        console.log(`❌ Cannot delete subtype: ${inventoryOutwards} inventory outward record(s) exist for this subtype`);
        return res.status(400).json({
          message: "Cannot delete subtype",
          reason: `This subtype has ${inventoryOutwards} active inventory outward record(s). Please resolve them first.`,
          inventoryOutwardCount: inventoryOutwards
        });
      }
    }

    // Safety Check 3: Check if there are any slots with bookings for this subtype
    const slotsWithBookings = await PlantSlot.aggregate([
      {
        $match: {
          plantId: mongoose.default.Types.ObjectId(plantId)
        }
      },
      {
        $unwind: "$subtypeSlots"
      },
      {
        $match: {
          "subtypeSlots.subtypeId": mongoose.default.Types.ObjectId(subtypeId)
        }
      },
      {
        $unwind: "$subtypeSlots.slots"
      },
      {
        $match: {
          "subtypeSlots.slots.orders": { $exists: true, $ne: [] }
        }
      },
      {
        $count: "slotsWithOrders"
      }
    ]);

    if (slotsWithBookings.length > 0 && slotsWithBookings[0].slotsWithOrders > 0) {
      console.log(`❌ Cannot delete subtype: ${slotsWithBookings[0].slotsWithOrders} slot(s) have bookings`);
      return res.status(400).json({
        message: "Cannot delete subtype",
        reason: `This subtype has ${slotsWithBookings[0].slotsWithOrders} slot(s) with active bookings. Please clear the bookings first.`,
        slotsWithBookings: slotsWithBookings[0].slotsWithOrders
      });
    }

    // All checks passed - proceed with deletion
    console.log(`✅ Safety checks passed. Proceeding with subtype deletion...`);

    // Delete related slots for this subtype
    const slotDeletionResult = await PlantSlot.updateMany(
      { plantId: plantId },
      { 
        $pull: { 
          subtypeSlots: { subtypeId: subtypeId } 
        } 
      }
    );
    console.log(`🗑️ Deleted slots for subtype: ${slotDeletionResult.modifiedCount} document(s) modified`);

    // Remove the subtype from the plant
    subtype.remove();
    const updatedPlant = await plant.save();

    console.log(`✅ Successfully deleted subtype: ${subtype.name}`);

    return res
      .status(200)
      .json({ 
        message: "Subtype deleted successfully", 
        data: updatedPlant,
        deletedSubtype: {
          name: subtype.name,
          id: subtypeId
        },
        slotsDeleted: slotDeletionResult.modifiedCount > 0
      });
  } catch (error) {
    console.error(`❌ Error deleting subtype:`, error);
    return res
      .status(500)
      .json({ message: "Error deleting subtype", error: error.message });
  }
};

// Get all plants
export const getPlants = async (req, res) => {
  try {
    // Fetch all plants with their embedded subtypes (including plantReadyDays)
    const plants = await PlantCms.find()
      .select("name subtypes slotSize addedBy buffer sowingAllowed dailyDispatchCapacity sowingBuffer createdAt") // Select fields to return
      .lean() // Convert to plain JavaScript object for better performance
      .exec();

    if (!plants || plants.length === 0) {
      return res.status(404).json({ message: "No plant data found." });
    }

    // Ensure all subtype fields are included (plantReadyDays, buffer, etc.) with default values
    const plantsWithCompleteData = plants.map(plant => ({
      _id: plant._id,
      name: plant.name,
      slotSize: plant.slotSize,
      buffer: plant.buffer || 0,
      sowingAllowed: plant.sowingAllowed || false, // Explicitly include with default
      dailyDispatchCapacity: plant.dailyDispatchCapacity || 2000,
      sowingBuffer: plant.sowingBuffer || 0,
      createdAt: plant.createdAt,
      addedBy: plant.addedBy,
      subtypes: plant.subtypes.map(subtype => ({
        _id: subtype._id,
        name: subtype.name,
        description: subtype.description || "",
        characteristics: subtype.characteristics || {},
        rates: subtype.rates || [],
        monthlyRates: subtype.monthlyRates || [],
        dailyDispatch: subtype.dailyDispatch || 0,
        buffer: subtype.buffer || 0,
        plantReadyDays: subtype.plantReadyDays || 0, // Explicitly include plantReadyDays with default
        slotDays: subtype.slotDays || plant.slotSize || 7,
        slotStartDate: subtype.slotStartDate || '',
        slotEndDate: subtype.slotEndDate || '',
        slotCapacity: subtype.slotCapacity || 0,
      }))
    }));

    return res
      .status(200)
      .json({ 
        success: true, 
        message: "Plants retrieved successfully", 
        data: plantsWithCompleteData 
      });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error retrieving plants", error: error.message });
  }
};

// Auto slot generation removed - slots are now managed through dedicated slot management system
