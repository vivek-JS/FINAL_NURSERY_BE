import Sowing from "../models/sowing.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Order from "../models/order.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";
import InventoryTransaction from "../models/inventoryTransaction.model.js";
import ReturnRequest from "../models/returnRequest.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import moment from "moment";
import mongoose from "mongoose";
import { resolveSowingPlantsPerPacket } from "../utility/sowingPlantsPerPacket.js";

// Create a new sowing record
export const createSowing = async (req, res) => {
  try {
    const {
      plantId,
      subtypeId,
      sowingDate,
      totalQuantityRequired,
      sowedPlant, // For PRIMARY location - plants sowed
      slotId,
      orderId,
      orderNumber,
      reminderBeforeDays,
      notes,
      batchNumber, // Batch number (mandatory - from packets or form field)
      dispatchBatchId, // Optional DispatchBatch _id — strengthens primary countdown matching
      createdBy,
      sowingLocation, // OFFICE or PRIMARY
      packets, // Array of packets from outward entries
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

    // Get plantReadyDays from PlantCMS (subtype), not from slot
    const plantReadyDays = Number(subtype.plantReadyDays) || 0;
    
    if (!plantReadyDays || plantReadyDays <= 0) {
      return res.status(400).json({
        message: "Plant Ready Days not configured for this subtype. Please update plant settings.",
      });
    }

    // Calculate plantReadyDate = sowingDate + plantReadyDays
    const sowingMoment = moment(sowingDate, "DD-MM-YYYY");
    const plantReadyDate = sowingMoment
      .clone()
      .add(plantReadyDays, "days")
      .format("DD-MM-YYYY");

    // Validate slot if provided
    let slotObjectId = null;
    if (slotId) {
      if (!mongoose.Types.ObjectId.isValid(slotId)) {
        return res.status(400).json({ message: "Invalid slotId provided" });
      }
      slotObjectId = new mongoose.Types.ObjectId(slotId);

      const slotDoc = await PlantSlot.findOne(
        { "subtypeSlots.slots._id": slotObjectId },
        { subtypeSlots: 1, plantId: 1 }
      ).lean();

      if (!slotDoc) {
        return res.status(404).json({
          message: "Slot not found",
        });
      }

      if (slotDoc.plantId?.toString() !== plant._id.toString()) {
        return res.status(400).json({
          message: "Slot does not belong to the selected plant",
        });
      }

      // Verify slot exists for this subtype
      const subtypeSlot = slotDoc.subtypeSlots.find(
        st => st.subtypeId?.toString() === subtypeId.toString()
      );
      
      if (!subtypeSlot) {
        return res.status(404).json({
          message: "Slot not found for the selected subtype",
        });
      }

      const matchedSlot = subtypeSlot.slots.find(
        (slot) => slot._id.toString() === slotObjectId.toString()
      );

      if (!matchedSlot) {
        return res.status(404).json({
          message: "Slot not found",
        });
      }
    }

    // Determine actual slotId (provided or found) before creating sowing record
    let actualSlotIdForSowing = slotId;
    let actualSlotObjectIdForSowing = slotObjectId;
    
    if (!slotId) {
      try {
        // Extract year from plantReadyDate (format: DD-MM-YYYY)
        // Slot should match based on plantReadyDate = sowingDate + plantReadyDays
        const plantReadyMoment = moment(plantReadyDate, "DD-MM-YYYY");
        if (!plantReadyMoment.isValid()) {
          console.error(`Invalid plantReadyDate format: ${plantReadyDate}`);
        } else {
          const year = plantReadyMoment.year();
          
          // Find the slot for this plant, subtype, and year
          const plantSlotDoc = await PlantSlot.findOne({
            plantId: new mongoose.Types.ObjectId(plantId),
            year: year,
            "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId)
          }).lean();

          if (plantSlotDoc) {
            const subtypeSlot = plantSlotDoc.subtypeSlots.find(
              st => st.subtypeId?.toString() === subtypeId.toString()
            );

            if (subtypeSlot && subtypeSlot.slots && subtypeSlot.slots.length > 0) {
              // Find a slot where plantReadyDate (sowingDate + plantReadyDays) falls within the slot's date range
              const matchingSlot = subtypeSlot.slots.find(slot => {
                if (!slot.startDay || !slot.endDay) return false;
                const startDate = moment(slot.startDay, "DD-MM-YYYY");
                const endDate = moment(slot.endDay, "DD-MM-YYYY");
                return plantReadyMoment.isBetween(startDate, endDate, null, '[]'); // inclusive
              });

              if (matchingSlot) {
                // Use the matching slot
                actualSlotIdForSowing = matchingSlot._id.toString();
                actualSlotObjectIdForSowing = matchingSlot._id;
                console.log(`✅ Found matching slot for plantReadyDate ${plantReadyDate} (sowingDate: ${sowingDate} + ${plantReadyDays} days): slot ${actualSlotIdForSowing} (${matchingSlot.startDay} to ${matchingSlot.endDay})`);
              } else {
                // Fallback: Use the first slot for this subtype if no match found
                actualSlotIdForSowing = subtypeSlot.slots[0]._id.toString();
                actualSlotObjectIdForSowing = subtypeSlot.slots[0]._id;
                console.log(`⚠️  No slot found matching plantReadyDate ${plantReadyDate} (sowingDate: ${sowingDate} + ${plantReadyDays} days), using first slot: ${actualSlotIdForSowing} (${subtypeSlot.slots[0].startDay} to ${subtypeSlot.slots[0].endDay})`);
              }
            }
          }
        }
      } catch (findSlotError) {
        console.error("Error finding slot for sowing record:", findSlotError);
      }
    }

    // Validate batchNumber (mandatory)
    if (!batchNumber || batchNumber.trim() === "") {
      return res.status(400).json({
        message: "Batch number is required. Please provide a batch number.",
      });
    }

    const dispatchBatchRef =
      dispatchBatchId && mongoose.Types.ObjectId.isValid(String(dispatchBatchId))
        ? new mongoose.Types.ObjectId(String(dispatchBatchId))
        : undefined;

    // Create sowing record
    const location = sowingLocation || "OFFICE";
    const officeSowedValue = location === "OFFICE" ? Number(totalQuantityRequired) || 0 : 0;
    const primarySowedValue =
      location === "PRIMARY"
        ? Number(sowedPlant ?? totalQuantityRequired) || 0
        : Number(sowedPlant) || 0;

    const sowing = new Sowing({
      plantId,
      plantName: plant.name,
      subtypeId,
      subtypeName: subtype.name,
      slotId: actualSlotIdForSowing,
      sowingDate,
      plantReadyDays: plantReadyDays,
      expectedReadyDate: plantReadyDate,
      totalQuantityRequired,
      sowingLocation: sowingLocation || "OFFICE", // Default to OFFICE
      orderId,
      orderNumber,
      reminderBeforeDays: reminderBeforeDays || 5,
      notes,
      batchNumber: batchNumber.trim(), // Store batch number
      ...(dispatchBatchRef ? { dispatchBatchId: dispatchBatchRef } : {}),
      createdBy,
      // Keep sowing record counters consistent with how UI/cards interpret office vs primary.
      officeSowed: officeSowedValue,
      primarySowed: primarySowedValue,
    });

    const savedSowing = await sowing.save();

    // Handle packets if provided (for PRIMARY or OFFICE location with outward entries)
    if (packets && Array.isArray(packets) && packets.length > 0) {
      try {
        for (const packet of packets) {
          const { outwardId, itemId, quantity: packetQuantity, batchNumber, completeSowing, remainingQuantity } = packet;
          
          // Validate packet data
          if (!outwardId || !itemId) {
            console.warn(`Skipping invalid packet (missing outwardId or itemId):`, packet);
            continue;
          }

          // Validate quantity is a positive number
          const quantityToUse = Number(packetQuantity);
          if (!quantityToUse || quantityToUse <= 0 || isNaN(quantityToUse)) {
            console.warn(`Skipping invalid packet (invalid quantity: ${packetQuantity}):`, packet);
            continue;
          }

          // Find the outward entry
          const outward = await InventoryOutward.findById(outwardId);
          if (!outward) {
            console.warn(`Outward entry not found: ${outwardId}`);
            continue;
          }

          // Find the item in the outward entry
          const item = outward.items.id(itemId);
          if (!item) {
            console.warn(`Item not found in outward ${outwardId}: ${itemId}`);
            continue;
          }

          // Calculate available quantity (total - already used)
          const currentUsedQty = item.usedQuantity || 0;
          const totalQty = item.quantity || 0;
          const availableQty = totalQty - currentUsedQty;

          console.log(`Processing packet: outwardId=${outwardId}, itemId=${itemId}, requestedQuantity=${quantityToUse}, availableQty=${availableQty}, currentUsedQty=${currentUsedQty}, totalQty=${totalQty}, completeSowing=${completeSowing}, remainingQuantity=${remainingQuantity}`);

          console.log(`[createSowing] Packet processing details:`, {
            outwardId,
            itemId,
            totalQty,
            quantityToUse,
            currentUsedQty,
            availableQty,
            completeSowing,
            remainingQuantityFromPayload: remainingQuantity
          });

          // Validate available quantity
          let finalUsedQuantity;
          let finalRemainingQty = 0;
          
          if (quantityToUse > availableQty) {
            console.warn(`Insufficient quantity in outward ${outwardId}, item ${itemId}. Available: ${availableQty}, Requested: ${quantityToUse}`);
            // Use only the available quantity (don't exceed)
            finalUsedQuantity = currentUsedQty + availableQty;
            console.log(`Used only available quantity: ${availableQty} (instead of requested ${quantityToUse})`);
          } else {
            // If complete sowing, mark the full original quantity as used (so it doesn't appear in available packets)
            // Otherwise, just update with the used quantity
            if (completeSowing) {
              // Mark full quantity as used since remaining is being returned to inventory
              finalUsedQuantity = totalQty;
              // Calculate remaining: totalQty - quantityToUse (what's left after using quantityToUse)
              finalRemainingQty = Math.max(0, totalQty - quantityToUse);
              console.log(`✅ Complete sowing: Marked full quantity ${totalQty} as used (used ${quantityToUse}, returning ${finalRemainingQty} to inventory)`);
            } else {
              // Update usedQuantity with the exact quantity from packet
              finalUsedQuantity = currentUsedQty + quantityToUse;
              console.log(`Updated usedQuantity: ${currentUsedQty} + ${quantityToUse} = ${finalUsedQuantity}`);
            }
          }
          
          // Update the item's usedQuantity
          item.usedQuantity = finalUsedQuantity;
          
          // Use payload remainingQuantity as fallback if calculation is 0
          if (completeSowing && finalRemainingQty === 0 && remainingQuantity > 0) {
            finalRemainingQty = remainingQuantity;
            console.log(`[createSowing] Using payload remainingQuantity: ${finalRemainingQty}`);
          }
          
          console.log(`[createSowing] Final values: usedQuantity=${finalUsedQuantity}, remainingQty=${finalRemainingQty}`);

          // Link sowing to the outward item (add to array if not already present)
          if (!item.sowing || !Array.isArray(item.sowing)) {
            item.sowing = [];
          }
          if (!item.sowing.includes(savedSowing._id)) {
            item.sowing.push(savedSowing._id);
          }

          // Save the outward entry
          await outward.save();
          
          console.log(`✅ Updated outward ${outwardId}, item ${itemId}: usedQuantity = ${item.usedQuantity} (was ${currentUsedQty}, added ${quantityToUse})`);
          
          // If complete sowing is checked, create return request instead of directly updating inventory
          console.log(`[createSowing] Checking if should create return request: completeSowing=${completeSowing}, finalRemainingQty=${finalRemainingQty}`);
          if (completeSowing && finalRemainingQty > 0) {
            console.log(`[createSowing] ✅ Creating return request for ${finalRemainingQty} units...`);
            try {
              // Get product and batch from outward item
              // Handle both ObjectId and string formats
              const productId = item.product?.toString ? item.product.toString() : (item.product?._id?.toString() || item.product);
              const batchId = item.batch?.toString ? item.batch.toString() : (item.batch?._id?.toString() || item.batch);
              
              console.log(`[createSowing] Product ID: ${productId} (type: ${typeof productId}), Batch ID: ${batchId} (type: ${typeof batchId})`);
              
              // Create return request instead of directly updating inventory
              if (productId && mongoose.Types.ObjectId.isValid(productId)) {
                try {
                  const product = await Product.findById(productId);
                  if (product) {
                    // Use item.unit (from outward item) or product.primaryUnit as fallback
                    const unitId = item.unit?.toString ? item.unit.toString() : (item.unit?._id?.toString() || item.unit || product.primaryUnit?.toString() || product.primaryUnit);
                      
                    // Generate return request number
                    const requestNumber = await ReturnRequest.generateRequestNumber();
                      
                    // Create return request
                    const returnRequest = new ReturnRequest({
                      requestNumber,
                      returnType: 'sowing',
                      product: productId,
                      batch: batchId || null,
                      quantity: finalRemainingQty,
                      unit: unitId,
                      referenceType: 'Sowing',
                      referenceId: savedSowing._id,
                      referenceNumber: savedSowing.batchNumber || null,
                      outwardId: outward._id,
                      itemId: itemId,
                      originalQuantity: totalQty,
                      usedQuantity: quantityToUse,
                      remainingQuantity: finalRemainingQty,
                      reason: 'Return from complete sowing - remaining stock',
                      remarks: `Remaining ${finalRemainingQty} units returned from sowing ${savedSowing._id} (complete sowing: used ${quantityToUse} out of ${totalQty})`,
                      status: 'pending',
                      requestedBy: createdBy || req.user?._id,
                      metadata: {
                        sowingId: savedSowing._id,
                        outwardId: outward._id,
                        itemId: itemId,
                        originalQuantity: totalQty,
                        usedQuantity: quantityToUse,
                        remainingQuantity: finalRemainingQty
                      }
                    });
                      
                    await returnRequest.save();
                    console.log(`✅ Created return request ${requestNumber} for ${finalRemainingQty} units (pending approval)`);
                  } else {
                    console.error(`❌ Product not found: ${productId}`);
                  }
                } catch (returnRequestError) {
                  console.error(`❌ Error creating return request:`, returnRequestError);
                  console.error(`❌ Return request error stack:`, returnRequestError.stack);
                  // Don't fail the whole request, just log the error
                }
              } else {
                console.warn(`⚠️ No valid productId found in outward item ${itemId} (productId: ${productId})`);
              }
            } catch (returnStockError) {
              console.error(`❌ Error returning remaining stock to inventory for packet ${itemId}:`, returnStockError);
              console.error(`❌ Error stack:`, returnStockError.stack);
              // Don't fail the whole request, just log the error
            }
          } else {
            console.log(`[createSowing] ⚠️ Not returning stock: completeSowing=${completeSowing}, finalRemainingQty=${finalRemainingQty}`);
          }
        }
      } catch (packetError) {
        console.error("Error updating outward packets:", packetError);
        // Don't fail the whole request if packet update fails, but log it
      }
    }

    // Update slot using the slotId we found/used for the sowing record
    if (actualSlotIdForSowing) {
      try {
        const searchSlotId = actualSlotObjectIdForSowing || new mongoose.Types.ObjectId(actualSlotIdForSowing);
        const location = sowingLocation || "OFFICE";
        
        // Determine quantities:
        // - If sowedPlant is provided, use it for primarySowed and totalPlants
        // - For officeSowed, use totalQuantityRequired based on location
        const sowedPlantValue = (sowedPlant !== undefined && sowedPlant !== null) ? Number(sowedPlant) : null;
        const officeQuantity = location === "OFFICE" ? totalQuantityRequired : 0;
        
        // Build update operation
        const updateOperation = {
          $set: {
            'subtypeSlots.$[subtypeSlot].slots.$[slot].sowingDate': sowingDate,
            'subtypeSlots.$[subtypeSlot].slots.$[slot].plantReadyDate': plantReadyDate
          },
          $inc: {}
        };
        
        // Update officeSowed based on location
        if (location === "OFFICE" && officeQuantity > 0) {
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].officeSowed'] = officeQuantity;
        }
        
        // If sowedPlant is provided, always update primarySowed with sowed plants.
        // Temporary business rule: availablePlants should also increase by sowed plants in every case.
        if (sowedPlantValue !== null && sowedPlantValue > 0) {
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed'] = sowedPlantValue;
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants'] = sowedPlantValue;
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants'] = sowedPlantValue;
          console.log(`📊 Will update primarySowed and totalPlants with sowedPlant: ${sowedPlantValue}`);
        } else if (location === "PRIMARY") {
          // Fallback: For PRIMARY location without sowedPlant, use totalQuantityRequired
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed'] = totalQuantityRequired;
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants'] = totalQuantityRequired;
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants'] = totalQuantityRequired;
        }
        
        // Use updateOne with arrayFilters for reliable nested updates
        const updateResult = await PlantSlot.updateOne(
          { "subtypeSlots.slots._id": searchSlotId },
          updateOperation,
          {
            arrayFilters: [
              { "subtypeSlot.slots._id": actualSlotIdForSowing },
              { "slot._id": actualSlotIdForSowing }
            ]
          }
        );
        
        if (updateResult.matchedCount > 0) {
          console.log(`✅ Updated slot ${actualSlotIdForSowing}: sowingDate=${sowingDate}, plantReadyDate=${plantReadyDate}`);
          if (sowedPlantValue) {
            console.log(`   - primarySowed += ${sowedPlantValue} (from sowedPlant)`);
            console.log(`   - totalPlants += ${sowedPlantValue} (from sowedPlant)`);
            console.log(`   - availablePlants += ${sowedPlantValue} (from sowedPlant)`);
          }
          if (officeQuantity > 0) {
            console.log(`   - officeSowed += ${officeQuantity}`);
          }
          
          // Update plantsSowed only when PRIMARY sowing changed primarySowed.
          if (sowedPlantValue !== null && sowedPlantValue > 0) {
            const slot = await PlantSlot.findOne({ "subtypeSlots.slots._id": searchSlotId });
            if (slot) {
              const subtypeSlot = slot.subtypeSlots.find(st => 
                st.slots.some(s => s._id.toString() === actualSlotIdForSowing.toString())
              );
              if (subtypeSlot) {
                const slotToUpdate = subtypeSlot.slots.find(s => s._id.toString() === actualSlotIdForSowing.toString());
                if (slotToUpdate) {
                  // Update plantsSowed to match primarySowed
                  slotToUpdate.plantsSowed = slotToUpdate.primarySowed || 0;
                  
                  // Calculate gap: gap = totalBookedPlants - primarySowed
                  const totalBookedPlants = slotToUpdate.totalBookedPlants || 0;
                  const gap = totalBookedPlants - (slotToUpdate.primarySowed || 0);
                  console.log(`📊 Slot ${actualSlotIdForSowing} - totalBookedPlants: ${totalBookedPlants}, primarySowed: ${slotToUpdate.primarySowed}, gap: ${gap}`);
                  
                  slot.markModified('subtypeSlots');
                  await slot.save();
                }
              }
            }
          }
        } else {
          console.error(`❌ Slot ${actualSlotIdForSowing} not found or update failed`);
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

// Create multiple sowing records in a single request
export const createMultipleSowings = async (req, res) => {
  try {
    const { sowings } = req.body; // Array of sowing entries

    if (!Array.isArray(sowings) || sowings.length === 0) {
      return res.status(400).json({
        message: "sowings array is required and must not be empty",
      });
    }

    const results = [];
    const errors = [];

    // Process each sowing entry
    for (let i = 0; i < sowings.length; i++) {
      const sowingData = sowings[i];
      
      try {
        const {
          plantId,
          subtypeId,
          sowingDate,
          totalQuantityRequired,
          sowedPlant, // For PRIMARY location - plants sowed
          baseSowedPlant, // Base qty before buffer (slot update qty)
          displaySowedPlant, // Buffered/display qty shown to user
          slotId,
          entrySlotId,
          orderId,
          orderNumber,
          reminderBeforeDays,
          notes,
          batchNumber, // Batch number (mandatory - from packets or form field)
          dispatchBatchId,
          createdBy,
          sowingLocation, // OFFICE or PRIMARY
          packets, // Array of packets from outward entries
          packetsUsed, // Explicit packets used count for in-progress sowings
          packetsToReturn, // Explicit packets to return (calculated by frontend)
          sourceType,
        } = sowingData;

        // Validate batchNumber (mandatory)
        if (!batchNumber || batchNumber.trim() === "") {
          errors.push({
            index: i,
            error: "Batch number is required. Please provide a batch number.",
          });
          continue;
        }

        // Validate plant and subtype
        const plant = await PlantCms.findById(plantId);
        if (!plant) {
          errors.push({ index: i, error: "Plant not found" });
          continue;
        }

        if (!plant.sowingAllowed) {
          errors.push({ 
            index: i, 
            error: "Sowing is not allowed for this plant. Please enable 'Sowing Allowed' in plant settings." 
          });
          continue;
        }

        const subtype = plant.subtypes.id(subtypeId);
        if (!subtype) {
          errors.push({ index: i, error: "Subtype not found" });
          continue;
        }

        // Get plantReadyDays from request body if provided, otherwise from PlantCMS (subtype)
        const requestedPlantReadyDays = Number(sowingData.plantReadyDays);
        const defaultPlantReadyDays = Number(subtype.plantReadyDays) || 0;
        const plantReadyDays = (requestedPlantReadyDays > 0) ? requestedPlantReadyDays : defaultPlantReadyDays;
        
        if (!plantReadyDays || plantReadyDays <= 0) {
          errors.push({ 
            index: i, 
            error: "Plant Ready Days not configured for this subtype. Please update plant settings or provide plantReadyDays in request." 
          });
          continue;
        }

        // Calculate plantReadyDate = sowingDate + plantReadyDays
        const sowingMoment = moment(sowingDate, "DD-MM-YYYY");
        const plantReadyDate = sowingMoment
          .clone()
          .add(plantReadyDays, "days")
          .format("DD-MM-YYYY");

        // Validate entry slot if provided
        const requestedEntrySlotId = entrySlotId || slotId || null;
        let slotObjectId = null;
        if (requestedEntrySlotId) {
          if (!mongoose.Types.ObjectId.isValid(requestedEntrySlotId)) {
            errors.push({ index: i, error: "Invalid slotId provided" });
            continue;
          }
          slotObjectId = new mongoose.Types.ObjectId(requestedEntrySlotId);

          const slotDoc = await PlantSlot.findOne(
            { "subtypeSlots.slots._id": slotObjectId },
            { subtypeSlots: 1, plantId: 1 }
          ).lean();

          if (!slotDoc) {
            errors.push({ index: i, error: "Slot not found" });
            continue;
          }

          if (slotDoc.plantId?.toString() !== plant._id.toString()) {
            errors.push({ index: i, error: "Slot does not belong to the selected plant" });
            continue;
          }

          // Verify slot exists for this subtype
          const subtypeSlot = slotDoc.subtypeSlots.find(
            st => st.subtypeId?.toString() === subtypeId.toString()
          );
          
          if (!subtypeSlot) {
            errors.push({ index: i, error: "Slot not found for the selected subtype" });
            continue;
          }

          const matchedSlot = subtypeSlot.slots.find(
            (slot) => slot._id.toString() === slotObjectId.toString()
          );

          if (!matchedSlot) {
            errors.push({ index: i, error: "Slot not found" });
            continue;
          }
        }

        // Determine actual slotId (provided or found) before creating sowing record
        // For admin day-wise flow, always map updates to expected-ready-date slot.
        const shouldMapByReadyDate = sourceType === "admin_daywise";
        let actualSlotIdForSowing = requestedEntrySlotId;
        let actualSlotObjectIdForSowing = slotObjectId;
        
        if (!requestedEntrySlotId || shouldMapByReadyDate) {
          try {
            // Extract year from plantReadyDate (format: DD-MM-YYYY)
            // Slot should match based on plantReadyDate = sowingDate + plantReadyDays
            const plantReadyMoment = moment(plantReadyDate, "DD-MM-YYYY");
            if (!plantReadyMoment.isValid()) {
              console.error(`Invalid plantReadyDate format: ${plantReadyDate}`);
            } else {
              const year = plantReadyMoment.year();
              
              // Find candidate slot documents for this plant/subtype (strict for daywise mapping)
              const plantSlotDocs = shouldMapByReadyDate
                ? await PlantSlot.find({
                    plantId: new mongoose.Types.ObjectId(plantId),
                    "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
                  }).lean()
                : await PlantSlot.find({
                    plantId: new mongoose.Types.ObjectId(plantId),
                    year: year,
                    "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
                  }).lean();

              let matchedSlot = null;
              for (const plantSlotDoc of plantSlotDocs || []) {
                const subtypeSlot = plantSlotDoc.subtypeSlots.find(
                  st => st.subtypeId?.toString() === subtypeId.toString()
                );
                if (!subtypeSlot?.slots?.length) continue;
                const maybe = subtypeSlot.slots.find(slot => {
                  if (!slot.startDay || !slot.endDay) return false;
                  const startDate = moment(slot.startDay, "DD-MM-YYYY");
                  const endDate = moment(slot.endDay, "DD-MM-YYYY");
                  return plantReadyMoment.isBetween(startDate, endDate, null, "[]");
                });
                if (maybe) {
                  matchedSlot = maybe;
                  break;
                }
              }

              if (matchedSlot) {
                actualSlotIdForSowing = matchedSlot._id.toString();
                actualSlotObjectIdForSowing = matchedSlot._id;
                console.log(`✅ Found matching slot for plantReadyDate ${plantReadyDate} (sowingDate: ${sowingDate} + ${plantReadyDays} days): slot ${actualSlotIdForSowing} (${matchedSlot.startDay} to ${matchedSlot.endDay})`);
              } else if (!shouldMapByReadyDate && plantSlotDocs?.[0]?.subtypeSlots?.length) {
                const fallbackSubtype = plantSlotDocs[0].subtypeSlots.find(
                  st => st.subtypeId?.toString() === subtypeId.toString()
                );
                if (fallbackSubtype?.slots?.[0]) {
                  actualSlotIdForSowing = fallbackSubtype.slots[0]._id.toString();
                  actualSlotObjectIdForSowing = fallbackSubtype.slots[0]._id;
                  console.log(`⚠️  No slot found matching plantReadyDate ${plantReadyDate}; using fallback slot ${actualSlotIdForSowing}`);
                }
              } else {
                errors.push({
                  index: i,
                  error: `No target slot found for expected ready date ${plantReadyDate}`,
                });
                actualSlotIdForSowing = null;
                actualSlotObjectIdForSowing = null;
              }
            }
          } catch (findSlotError) {
            console.error("Error finding slot for sowing record:", findSlotError);
          }
        }

        if (!actualSlotIdForSowing || !actualSlotObjectIdForSowing) {
          errors.push({
            index: i,
            error: `Target slot resolution failed for expected ready date ${plantReadyDate}`,
          });
          continue;
        }

        const parsedSowedPlant = (sowedPlant !== undefined && sowedPlant !== null) ? Number(sowedPlant) : null;
        const parsedBaseSowedPlant =
          (baseSowedPlant !== undefined && baseSowedPlant !== null) ? Number(baseSowedPlant) : null;
        const parsedDisplaySowedPlant =
          (displaySowedPlant !== undefined && displaySowedPlant !== null) ? Number(displaySowedPlant) : null;
        const effectiveSlotPlants =
          parsedBaseSowedPlant !== null && parsedBaseSowedPlant > 0
            ? parsedBaseSowedPlant
            : parsedSowedPlant;
        const bufferedInputPlants =
          parsedDisplaySowedPlant !== null && parsedDisplaySowedPlant > 0
            ? parsedDisplaySowedPlant
            : parsedSowedPlant;

        const dispatchBatchRefMulti =
          dispatchBatchId && mongoose.Types.ObjectId.isValid(String(dispatchBatchId))
            ? new mongoose.Types.ObjectId(String(dispatchBatchId))
            : undefined;

        // Create sowing record
        const location = sowingLocation || "OFFICE";
        const officeSowedValue = location === "OFFICE" ? Number(totalQuantityRequired) || 0 : 0;
        // `effectiveSlotPlants` is the base qty used for slot updates (buffer already removed).
        const primarySowedValue = Number(effectiveSlotPlants) || 0;

        const sowing = new Sowing({
          plantId,
          plantName: plant.name,
          subtypeId,
          subtypeName: subtype.name,
          slotId: actualSlotIdForSowing,
          entrySlotId: requestedEntrySlotId || actualSlotIdForSowing,
          targetSlotId: actualSlotIdForSowing,
          mappedByRule: shouldMapByReadyDate ? "expectedReadyDate" : null,
          sowingDate,
          plantReadyDays: plantReadyDays,
          expectedReadyDate: plantReadyDate,
          totalQuantityRequired,
          sowingLocation: sowingLocation || "OFFICE",
          orderId,
          orderNumber,
          reminderBeforeDays: reminderBeforeDays || 5,
          notes,
          batchNumber: batchNumber.trim(), // Store batch number (mandatory)
          ...(dispatchBatchRefMulti ? { dispatchBatchId: dispatchBatchRefMulti } : {}),
          createdBy,
          // Keep sowing record counters consistent with UI/cards:
          // - OFFICE: officeSowed = packet count
          // - PRIMARY (and OFFICE produced plants): primarySowed = base slot qty (buffer removed)
          officeSowed: officeSowedValue,
          primarySowed: primarySowedValue,
          metadata: {
            sourceType: sourceType || null,
            entrySlotId: requestedEntrySlotId || actualSlotIdForSowing,
            targetSlotId: actualSlotIdForSowing,
            sowingDate,
            plantReadyDays,
            expectedReadyDate: plantReadyDate,
            mappedByRule: shouldMapByReadyDate ? "expectedReadyDate" : null,
            bufferedSowingQty: bufferedInputPlants,
            baseSowingQty: effectiveSlotPlants,
            slotUpdateQty: effectiveSlotPlants,
            performedBy: createdBy || req.user?._id || null,
            timestamp: new Date().toISOString(),
            reason: notes || "Sowing entry submitted",
          },
        });

        const savedSowing = await sowing.save();

        // Write explicit mapping audit event on target slot trail for traceability
        if (shouldMapByReadyDate && actualSlotIdForSowing) {
          try {
            const targetSlotDoc = await PlantSlot.findOne({ "subtypeSlots.slots._id": actualSlotObjectIdForSowing });
            if (targetSlotDoc) {
              const subtypeSlot = targetSlotDoc.subtypeSlots.find(st =>
                st.slots.some(s => s._id.toString() === actualSlotIdForSowing.toString())
              );
              const slotForTrail = subtypeSlot?.slots?.find(s => s._id.toString() === actualSlotIdForSowing.toString());
              if (slotForTrail) {
                slotForTrail.logSowingActivity({
                  action: "SOWING_READY_DATE_MAPPED",
                  activityName: "Sowing Mapped To Ready-Date Slot",
                  sowingId: savedSowing._id,
                  sowingDate,
                  plantReadyDate: plantReadyDate,
                  batchNumber,
                  performedBy: createdBy || req.user?._id,
                  reason: notes || "Mapped by expectedReadyDate rule",
                  metadata: {
                    sowingDate,
                    plantReadyDays,
                    expectedReadyDate: plantReadyDate,
                    entrySlotId: requestedEntrySlotId || null,
                    targetSlotId: actualSlotIdForSowing,
                    mappedByRule: "expectedReadyDate",
                    bufferedSowingQty: bufferedInputPlants,
                    baseSowingQty: effectiveSlotPlants,
                    slotUpdateQty: effectiveSlotPlants,
                    performedBy: createdBy || req.user?._id || null,
                    timestamp: new Date().toISOString(),
                    notes: notes || null,
                  },
                });
                targetSlotDoc.markModified("subtypeSlots");
                await targetSlotDoc.save();
              }
            }
          } catch (mappingLogError) {
            console.error("Error writing ready-date mapping trail:", mappingLogError);
          }
        }

        // Handle packets if provided (for PRIMARY or OFFICE location)
        if (packets && Array.isArray(packets) && packets.length > 0) {
          console.log(`[createMultipleSowings] Processing ${packets.length} packet(s) for sowing ${savedSowing._id}`);
          try {
            for (const packet of packets) {
              console.log(`[createMultipleSowings] Starting packet processing:`, JSON.stringify(packet, null, 2));
              const { outwardId, itemId, quantity: packetQuantity, batchNumber, completeSowing, remainingQuantity } = packet;
              
              if (!outwardId || !itemId) {
                console.warn(`Skipping invalid packet (missing outwardId or itemId):`, packet);
                continue;
              }

              const quantityToUse = Number(packetQuantity);
              if (!quantityToUse || quantityToUse <= 0 || isNaN(quantityToUse)) {
                console.warn(`Skipping invalid packet (invalid quantity: ${packetQuantity}):`, packet);
                continue;
              }

              const outward = await InventoryOutward.findById(outwardId);
              if (!outward) {
                console.warn(`Outward entry not found: ${outwardId}`);
                continue;
              }

              const item = outward.items.id(itemId);
              if (!item) {
                console.warn(`Item not found in outward ${outwardId}: ${itemId}`);
                continue;
              }

              const currentUsedQty = item.usedQuantity || 0;
              const totalQty = item.quantity || 0;
              const availableQty = totalQty - currentUsedQty;

              console.log(`Processing packet: outwardId=${outwardId}, itemId=${itemId}, requestedQuantity=${quantityToUse}, availableQty=${availableQty}, currentUsedQty=${currentUsedQty}, totalQty=${totalQty}, completeSowing=${completeSowing}, remainingQuantity=${remainingQuantity}`);

              console.log(`[createMultipleSowings] Packet processing details:`, {
                outwardId,
                itemId,
                totalQty,
                quantityToUse,
                currentUsedQty,
                availableQty,
                completeSowing,
                remainingQuantityFromPayload: remainingQuantity
              });

              let finalUsedQuantity;
              let finalRemainingQty = 0;
              
              if (quantityToUse > availableQty) {
                console.warn(`Insufficient quantity in outward ${outwardId}, item ${itemId}. Available: ${availableQty}, Requested: ${quantityToUse}`);
                finalUsedQuantity = currentUsedQty + availableQty;
              } else {
                // If complete sowing, mark the full original quantity as used (so it doesn't appear in available packets)
                // Otherwise, just update with the used quantity
                if (completeSowing) {
                  // Mark full quantity as used since remaining is being returned to inventory
                  finalUsedQuantity = totalQty;
                  // Calculate remaining: totalQty - quantityToUse (what's left after using quantityToUse)
                  finalRemainingQty = Math.max(0, totalQty - quantityToUse);
                  console.log(`✅ Complete sowing: Marked full quantity ${totalQty} as used (used ${quantityToUse}, returning ${finalRemainingQty} to inventory)`);
                } else {
                  // Update usedQuantity with the exact quantity from packet
                  finalUsedQuantity = currentUsedQty + quantityToUse;
                  console.log(`Updated usedQuantity: ${currentUsedQty} + ${quantityToUse} = ${finalUsedQuantity}`);
                }
              }
              
              // Update the item's usedQuantity
              item.usedQuantity = finalUsedQuantity;
              
              // Use payload remainingQuantity as fallback if calculation is 0
              if (completeSowing && finalRemainingQty === 0 && remainingQuantity > 0) {
                finalRemainingQty = remainingQuantity;
                console.log(`[createMultipleSowings] Using payload remainingQuantity: ${finalRemainingQty}`);
              }
              
              console.log(`[createMultipleSowings] Final values: usedQuantity=${finalUsedQuantity}, remainingQty=${finalRemainingQty}`);

              if (!item.sowing || !Array.isArray(item.sowing)) {
                item.sowing = [];
              }
              if (!item.sowing.includes(savedSowing._id)) {
                item.sowing.push(savedSowing._id);
              }

              await outward.save();
              
              console.log(`✅ Updated outward ${outwardId}, item ${itemId}: usedQuantity = ${item.usedQuantity} (was ${currentUsedQty}, added ${quantityToUse})`);
              
              // If complete sowing is checked, create return request instead of directly updating inventory
              console.log(`[createMultipleSowings] Checking if should create return request: completeSowing=${completeSowing}, finalRemainingQty=${finalRemainingQty}`);
              if (completeSowing && finalRemainingQty > 0) {
                console.log(`[createMultipleSowings] ✅ Creating return request for ${finalRemainingQty} units...`);
                try {
                  // Get product and batch from outward item
                  // Handle both ObjectId and string formats
                  const productId = item.product?.toString ? item.product.toString() : (item.product?._id?.toString() || item.product);
                  const batchId = item.batch?.toString ? item.batch.toString() : (item.batch?._id?.toString() || item.batch);
                  
                  console.log(`[createMultipleSowings] Product ID: ${productId} (type: ${typeof productId}), Batch ID: ${batchId} (type: ${typeof batchId})`);
                  
                  // Create return request instead of directly updating inventory
                  if (productId && mongoose.Types.ObjectId.isValid(productId)) {
                    try {
                      const product = await Product.findById(productId);
                      if (product) {
                        // Use item.unit (from outward item) or product.primaryUnit as fallback
                        const unitId = item.unit?.toString ? item.unit.toString() : (item.unit?._id?.toString() || item.unit || product.primaryUnit?.toString() || product.primaryUnit);
                        
                        // Generate return request number
                        const requestNumber = await ReturnRequest.generateRequestNumber();
                        
                        // Create return request
                        const returnRequest = new ReturnRequest({
                          requestNumber,
                          returnType: 'sowing',
                          product: productId,
                          batch: batchId || null,
                          quantity: finalRemainingQty,
                          unit: unitId,
                          referenceType: 'Sowing',
                          referenceId: savedSowing._id,
                          referenceNumber: savedSowing.batchNumber || null,
                          outwardId: outward._id,
                          itemId: itemId,
                          originalQuantity: totalQty,
                          usedQuantity: quantityToUse,
                          remainingQuantity: finalRemainingQty,
                          reason: 'Return from complete sowing - remaining stock',
                          remarks: `Remaining ${finalRemainingQty} units returned from sowing ${savedSowing._id} (complete sowing: used ${quantityToUse} out of ${totalQty})`,
                          status: 'pending',
                          requestedBy: createdBy || req.user?._id,
                          metadata: {
                            sowingId: savedSowing._id,
                            outwardId: outward._id,
                            itemId: itemId,
                            originalQuantity: totalQty,
                            usedQuantity: quantityToUse,
                            remainingQuantity: finalRemainingQty
                          }
                        });
                        
                        await returnRequest.save();
                        console.log(`✅ Created return request ${requestNumber} for ${finalRemainingQty} units (pending approval)`);
                      } else {
                        console.error(`❌ Product not found: ${productId}`);
                      }
                    } catch (returnRequestError) {
                      console.error(`❌ Error creating return request:`, returnRequestError);
                      console.error(`❌ Return request error stack:`, returnRequestError.stack);
                      // Don't fail the whole request, just log the error
                    }
                  } else {
                    console.warn(`⚠️ No productId found in outward item ${itemId}`);
                  }
                } catch (returnStockError) {
                  console.error(`❌ Error creating return request for packet ${itemId}:`, returnStockError);
                  console.error(`❌ Error stack:`, returnStockError.stack);
                  // Don't fail the whole request, just log the error
                }
              } else {
                console.log(`[createMultipleSowings] ⚠️ Not creating return request: completeSowing=${completeSowing}, finalRemainingQty=${finalRemainingQty}`);
              }
            }
          } catch (packetError) {
            console.error("Error updating outward packets:", packetError);
          }
        }

        // Update slot using the slotId we found/used for the sowing record
        if (actualSlotIdForSowing) {
          try {
            const searchSlotId = actualSlotObjectIdForSowing || new mongoose.Types.ObjectId(actualSlotIdForSowing);
            const location = sowingLocation || "OFFICE";
            
            // Determine quantities:
            // - If sowedPlant is provided, use it for primarySowed and totalPlants
            // - For officeSowed, use totalQuantityRequired based on location
            const sowedPlantValue = effectiveSlotPlants;
            const officeQuantity = location === "OFFICE" ? totalQuantityRequired : 0;
            
            // Get slot document BEFORE update for logging (capture before state)
            let slotDocBefore = null;
            let slotToUpdateBefore = null;
            try {
              slotDocBefore = await PlantSlot.findOne({ "subtypeSlots.slots._id": searchSlotId });
              if (slotDocBefore) {
                const subtypeSlotBefore = slotDocBefore.subtypeSlots.find(st => 
                  st.slots.some(s => s._id.toString() === actualSlotIdForSowing.toString())
                );
                if (subtypeSlotBefore) {
                  slotToUpdateBefore = subtypeSlotBefore.slots.find(s => s._id.toString() === actualSlotIdForSowing.toString());
                }
              }
            } catch (err) {
              console.error("[Logging] Error fetching slot before state:", err);
            }
            
            // Check if this is excessive sowing - check packets first, then SowingRequest
            let isExcessiveSowing = false;
            if (packets && packets.length > 0) {
              // Check if any packet has isExcessiveSowing flag
              isExcessiveSowing = packets.some(p => p.isExcessiveSowing === true);
              console.log(`[ExcessiveSowing] Checked packets: isExcessiveSowing=${isExcessiveSowing}`);
            }
            
            // If not found in packets, try to find from SowingRequest
            if (!isExcessiveSowing && actualSlotIdForSowing) {
              try {
                const sowingRequest = await SowingRequest.findOne({
                  linkedSlotIds: { $in: [searchSlotId] },
                  plantId: new mongoose.Types.ObjectId(plantId),
                  subtypeId: new mongoose.Types.ObjectId(subtypeId),
                }).select('isExcessiveSowing').lean();
                
                if (sowingRequest && sowingRequest.isExcessiveSowing) {
                  isExcessiveSowing = true;
                  console.log(`[ExcessiveSowing] Found from SowingRequest: isExcessiveSowing=true`);
                }
              } catch (reqCheckError) {
                console.log(`[ExcessiveSowing] Could not check SowingRequest:`, reqCheckError.message);
              }
            }
            
            // Build update operation
            const updateOperation = {
              $set: {
                'subtypeSlots.$[subtypeSlot].slots.$[slot].sowingDate': sowingDate,
                'subtypeSlots.$[subtypeSlot].slots.$[slot].plantReadyDate': plantReadyDate
              },
              $inc: {}
            };
            
            // Update officeSowed ONLY if packets array exists (NEW sowings)
            // For in-progress sowings (no packets array), officeSowed will be updated in cleanup section
            if (packets && packets.length > 0) {
              const packetsCount = packets.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
              updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].officeSowed'] = packetsCount;
              console.log(`📦 Will update officeSowed with ${packetsCount} packets (from packets array)`);
            }
            
            const shouldIncrementPrimarySowed = location === "PRIMARY";

            // If sowedPlant is provided, always increment primarySowed with sowed plants.
            // Temporary business rule: availablePlants should also increase by sowed plants in every case.
            if (sowedPlantValue !== null && sowedPlantValue > 0) {
              updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed'] = sowedPlantValue;
              updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants'] = sowedPlantValue;
              if (isExcessiveSowing) {
                console.log(`📊 [EXCESSIVE] Will update primarySowed with sowedPlant: ${sowedPlantValue} (base slot counters)`);
                console.log(`📊 [EXCESSIVE] Will also update excessiveSowing.plants with sowedPlant: ${sowedPlantValue} (separate tracking)`);
              } else {
                console.log(`📊 Will update primarySowed with sowedPlant: ${sowedPlantValue}`);
              }
              
              // Update totalPlants once here. availablePlants is handled later after gap coverage.
              updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants'] = sowedPlantValue;
              console.log(`📊 Will update totalPlants with sowedPlant: ${sowedPlantValue}; availablePlants will be set after gap coverage`);
            } else if (totalQuantityRequired > 0) {
              // Fallback: only PRIMARY sowing can affect primarySowed.
              if (shouldIncrementPrimarySowed) {
                updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed'] = totalQuantityRequired;
                updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants'] = totalQuantityRequired;
                if (isExcessiveSowing) {
                  console.log(`📊 [EXCESSIVE] Fallback: Will update primarySowed and track excessive plants separately with totalQuantityRequired: ${totalQuantityRequired}`);
                }
              }
              updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants'] = totalQuantityRequired;
            }
            
            // Use updateOne with arrayFilters for reliable nested updates
            const updateResult = await PlantSlot.updateOne(
              { "subtypeSlots.slots._id": searchSlotId },
              updateOperation,
              {
                arrayFilters: [
                  { "subtypeSlot.slots._id": actualSlotIdForSowing },
                  { "slot._id": actualSlotIdForSowing }
                ]
              }
            );
            
            if (updateResult.matchedCount > 0) {
              console.log(`✅ Updated slot ${actualSlotIdForSowing}: sowingDate=${sowingDate}, plantReadyDate=${plantReadyDate}`);
              if (sowedPlantValue) {
                if (isExcessiveSowing) {
                  console.log(`   - primarySowed += ${sowedPlantValue} (EXCESSIVE SOWING - for totalPlants/availablePlants)`);
                  console.log(`   - excessiveSowing.plants += ${sowedPlantValue} (EXCESSIVE SOWING - separate tracking)`);
                } else {
                  console.log(`   - primarySowed += ${sowedPlantValue} (from sowedPlant)`);
                }
                console.log(`   - totalPlants += ${sowedPlantValue} (from sowedPlant)`);
                console.log(`   - availablePlants += ${sowedPlantValue} (from sowedPlant)`);
              }
              if (officeQuantity > 0) {
                console.log(`   - officeSowed += ${officeQuantity}`);
              }
              
              // Handle excessiveSowing.plants update separately (for excessive sowings)
              // Note: primarySowed is already updated above, this is for separate excessive tracking
              if (isExcessiveSowing && sowedPlantValue !== null && sowedPlantValue > 0) {
                const slotDoc = await PlantSlot.findOne({ "subtypeSlots.slots._id": searchSlotId });
                if (slotDoc) {
                  const subtypeSlot = slotDoc.subtypeSlots.find(st => 
                    st.slots.some(s => s._id.toString() === actualSlotIdForSowing.toString())
                  );
                  if (subtypeSlot) {
                    const slotToUpdate = subtypeSlot.slots.find(s => s._id.toString() === actualSlotIdForSowing.toString());
                    if (slotToUpdate) {
                      // Capture before state for logging
                      const beforeExcessivePlants = slotToUpdate.excessiveSowing?.plants || 0;
                      
                      // Initialize excessiveSowing if it doesn't exist
                      if (!slotToUpdate.excessiveSowing) {
                        slotToUpdate.excessiveSowing = { packets: 0, plants: 0 };
                      }
                      // Add plants to excessiveSowing.plants (separate tracking)
                      slotToUpdate.excessiveSowing.plants = (slotToUpdate.excessiveSowing.plants || 0) + sowedPlantValue;
                      console.log(`✅ [EXCESSIVE] Updated excessiveSowing.plants: ${slotToUpdate.excessiveSowing.plants} (added ${sowedPlantValue})`);
                      console.log(`✅ [EXCESSIVE] primarySowed: ${slotToUpdate.primarySowed}, totalPlants: ${slotToUpdate.totalPlants}, availablePlants: ${slotToUpdate.availablePlants}`);
                      
                      // Log excessive sowing activity
                      slotToUpdate.logSowingActivity({
                        action: "SOWING_EXCESSIVE",
                        activityName: "Excessive Sowing - Plants Added",
                        quantity: sowedPlantValue,
                        plus: {
                          excessivePlants: sowedPlantValue,
                        },
                        before: {
                          excessivePlants: beforeExcessivePlants,
                          primarySowed: slotToUpdateBefore?.primarySowed || 0,
                          totalPlants: slotToUpdateBefore?.totalPlants || 0,
                          availablePlants: slotToUpdateBefore?.availablePlants || 0,
                        },
                        after: {
                          excessivePlants: slotToUpdate.excessiveSowing.plants,
                          primarySowed: slotToUpdate.primarySowed || 0,
                          totalPlants: slotToUpdate.totalPlants || 0,
                          availablePlants: slotToUpdate.availablePlants || 0,
                        },
                        sowingId: savedSowing._id,
                        sowingLocation: location,
                        batchNumber,
                        sowingDate,
                        plantReadyDate,
                        isExcessiveSowing: true,
                        performedBy: createdBy || req.user?._id,
                        reason: `Excessive sowing: ${sowedPlantValue} plants added to excessiveSowing.plants`,
                        notes: `Plants beyond order requirements. Batch: ${batchNumber}`,
                        metadata: {
                          originalSowingData: {
                            totalQuantityRequired,
                            sowedPlant: sowedPlantValue,
                            officeQuantity,
                            bufferedSowingQty: bufferedInputPlants,
                            baseSowingQty: effectiveSlotPlants,
                            slotUpdateQty: effectiveSlotPlants,
                          },
                          mapping: {
                            entrySlotId: requestedEntrySlotId || actualSlotIdForSowing,
                            targetSlotId: actualSlotIdForSowing,
                            mappedByRule: shouldMapByReadyDate ? "expectedReadyDate" : null,
                            expectedReadyDate: plantReadyDate,
                            bufferedSowingQty: bufferedInputPlants,
                            baseSowingQty: effectiveSlotPlants,
                            slotUpdateQty: effectiveSlotPlants,
                          },
                        },
                      });
                      
                      slotDoc.markModified('subtypeSlots');
                      await slotDoc.save();
                    }
                  }
                }
              }
              
              // Update plantsSowed when we incremented primarySowed.
              if (sowedPlantValue !== null && sowedPlantValue > 0) {
                const slotDoc = await PlantSlot.findOne({ "subtypeSlots.slots._id": searchSlotId });
                if (slotDoc) {
                  const subtypeSlot = slotDoc.subtypeSlots.find(st => 
                    st.slots.some(s => s._id.toString() === actualSlotIdForSowing.toString())
                  );
                  if (subtypeSlot) {
                    const slotToUpdate = subtypeSlot.slots.find(s => s._id.toString() === actualSlotIdForSowing.toString());
                    if (slotToUpdate) {
                      // Capture before state
                      const beforePlantsSowed = slotToUpdate.plantsSowed || 0;
                      const beforePrimarySowed = slotToUpdateBefore?.primarySowed || 0;
                      
                      // Update plantsSowed to match primarySowed (for both regular and excessive)
                      slotToUpdate.plantsSowed = slotToUpdate.primarySowed || 0;
                      
                      if (!isExcessiveSowing) {
                        // Calculate gap: gap = totalBookedPlants - primarySowed (only for regular sowing)
                        const totalBookedPlants = slotToUpdate.totalBookedPlants || 0;
                        const gap = totalBookedPlants - (slotToUpdate.primarySowed || 0);
                        console.log(`📊 Slot ${actualSlotIdForSowing} - totalBookedPlants: ${totalBookedPlants}, primarySowed: ${slotToUpdate.primarySowed}, gap: ${gap}`);
                        
                        // Log regular sowing activity
                        slotToUpdate.logSowingActivity({
                          action: location === "PRIMARY" ? "SOWING_PRIMARY" : "SOWING_OFFICE",
                          activityName: `${location} Sowing - Plants Added`,
                          quantity: sowedPlantValue,
                          plus: {
                            primarySowed: sowedPlantValue,
                            totalPlants: sowedPlantValue,
                            availablePlants: sowedPlantValue,
                            plantsSowed: slotToUpdate.plantsSowed - beforePlantsSowed,
                            officeSowed: officeQuantity || 0,
                          },
                          before: {
                            primarySowed: beforePrimarySowed,
                            totalPlants: slotToUpdateBefore?.totalPlants || 0,
                            availablePlants: slotToUpdateBefore?.availablePlants || 0,
                            plantsSowed: beforePlantsSowed,
                            officeSowed: slotToUpdateBefore?.officeSowed || 0,
                            totalBookedPlants: totalBookedPlants,
                          },
                          after: {
                            primarySowed: slotToUpdate.primarySowed || 0,
                            totalPlants: slotToUpdate.totalPlants || 0,
                            availablePlants: slotToUpdate.availablePlants || 0,
                            plantsSowed: slotToUpdate.plantsSowed || 0,
                            officeSowed: slotToUpdate.officeSowed || 0,
                            totalBookedPlants: totalBookedPlants,
                          },
                          sowingId: savedSowing._id,
                          sowingLocation: location,
                          batchNumber,
                          sowingDate,
                          plantReadyDate,
                          isExcessiveSowing: false,
                          performedBy: createdBy || req.user?._id,
                          reason: `${location} sowing: ${sowedPlantValue} plants sowed. Batch: ${batchNumber}`,
                          notes: notes || `Sowing completed. Gap after: ${gap}`,
                          metadata: {
                            gap,
                            totalQuantityRequired,
                            sowedPlant: sowedPlantValue,
                            officeQuantity,
                            bufferedSowingQty: bufferedInputPlants,
                            baseSowingQty: effectiveSlotPlants,
                            slotUpdateQty: effectiveSlotPlants,
                            mapping: {
                              entrySlotId: requestedEntrySlotId || actualSlotIdForSowing,
                              targetSlotId: actualSlotIdForSowing,
                              mappedByRule: shouldMapByReadyDate ? "expectedReadyDate" : null,
                              expectedReadyDate: plantReadyDate,
                              bufferedSowingQty: bufferedInputPlants,
                              baseSowingQty: effectiveSlotPlants,
                              slotUpdateQty: effectiveSlotPlants,
                            },
                          },
                        });
                      } else {
                        console.log(`📊 [EXCESSIVE] Slot ${actualSlotIdForSowing} - primarySowed: ${slotToUpdate.primarySowed}, excessiveSowing.plants: ${slotToUpdate.excessiveSowing?.plants || 0}`);
                      }
                      
                      // Only save if we haven't already saved for excessiveSowing update above
                      if (!isExcessiveSowing) {
                        slotDoc.markModified('subtypeSlots');
                        await slotDoc.save();
                      }
                    }
                  }
                }
              }
            } else {
              console.error(`❌ Slot ${actualSlotIdForSowing} not found or update failed`);
            }
          } catch (slotError) {
            console.error("Error updating slot:", slotError);
          }
        }

        // ADDITION: Handle sowingInProgress cleanup and availablePlants update
        if (!actualSlotIdForSowing) {
          console.log(`[sowingInProgress] ⚠️ No slotId found - skipping cleanup. slotId from request: ${slotId}`);
        }
        
        if (actualSlotIdForSowing) {
          const completeSowing = sowingData.completeSowing !== undefined ? Boolean(sowingData.completeSowing) : true; // Default to true if not provided
          console.log(`[sowingInProgress] Starting cleanup for slotId=${actualSlotIdForSowing}, sowedPlant=${sowedPlant}, completeSowing=${completeSowing}, packetsUsed=${packetsUsed}, packetsToReturn=${packetsToReturn}`);
          
          // ===== HELPER FUNCTIONS (defined before try block) =====
          
          // Helper function to create return request
          async function createReturnRequestForProgress(progress, packetsUsed, packetsRemaining, userId, request) {
            try {
              console.log(`[sowingInProgress] 🔄 createReturnRequestForProgress called with:`, {
                progressRequestNumber: progress?.requestNumber,
                progressSowingRequestId: progress?.sowingRequestId?.toString(),
                packetsUsed,
                packetsRemaining,
                userId: userId?.toString()
              });
              
              if (packetsRemaining <= 0) {
                console.log(`[sowingInProgress] ⚠️ Skipping return request creation (packetsRemaining <= 0)`);
                return;
              }
              
              console.log(`[sowingInProgress] Creating return request for ${packetsRemaining} packets`);
              
              // Find the SowingRequest to get outwardId
              const sowingRequest = await SowingRequest.findById(progress.sowingRequestId);
              if (!sowingRequest || !sowingRequest.outwardId) {
                console.warn(`[sowingInProgress] No outwardId found for request ${progress.requestNumber}`);
                return;
              }
              
              // Find the outward entry
              const outward = await InventoryOutward.findById(sowingRequest.outwardId);
              if (!outward || !outward.items || outward.items.length === 0) {
                console.warn(`[sowingInProgress] No outward items found`);
                return;
              }
              
              // Get first item (assuming single product per request)
              const item = outward.items[0];
              const productId = item.product?.toString() || item.product;
              const batchId = item.batch?.toString() || item.batch;
              const unitId = item.unit?.toString() || item.unit;
              
              // Generate return request number
              const requestNumber = await ReturnRequest.generateRequestNumber();
              
              // Create return request
              const returnRequest = new ReturnRequest({
                requestNumber,
                returnType: 'sowing',
                product: productId,
                batch: batchId || null,
                quantity: packetsRemaining,
                unit: unitId,
                referenceType: 'Sowing',
                referenceId: progress.sowingRequestId,
                referenceNumber: progress.requestNumber,
                outwardId: sowingRequest.outwardId,
                itemId: item._id,
                originalQuantity: progress.packetsIssued,
                usedQuantity: packetsUsed,
                remainingQuantity: packetsRemaining,
                reason: 'End of sowing - return remaining packets',
                remarks: `Remaining ${packetsRemaining} packets returned from sowing ${progress.requestNumber} (used ${packetsUsed} out of ${progress.packetsIssued})`,
                status: 'pending',
                requestedBy: userId || request.user?._id,
                metadata: {
                  sowingRequestId: progress.sowingRequestId,
                  requestNumber: progress.requestNumber,
                  packetsIssued: progress.packetsIssued,
                  packetsUsed: packetsUsed,
                  packetsRemaining: packetsRemaining
                }
              });
              
              await returnRequest.save();
              console.log(`[sowingInProgress] ✅ Created return request ${requestNumber} for ${packetsRemaining} packets`);
              console.log(`[sowingInProgress] 📄 Return request details:`, {
                requestNumber,
                quantity: packetsRemaining,
                productId,
                batchId,
                outwardId: sowingRequest.outwardId?.toString(),
                itemId: item._id?.toString()
              });
            } catch (error) {
              console.error(`[sowingInProgress] ❌ Error creating return request:`, error);
              console.error(`[sowingInProgress] ❌ Error stack:`, error.stack);
            }
          }
          
          // Helper function to find SowingRequest by slotId, plantId, subtypeId (when sowingInProgress is empty)
          async function findSowingRequestBySlot(actualSlotIdForSowing, plantId, subtypeId) {
            try {
              console.log(`[sowingInProgress] 🔍 Finding SowingRequest for slotId=${actualSlotIdForSowing}, plantId=${plantId}, subtypeId=${subtypeId}`);
              
              // Find SowingRequest that has this slotId in linkedSlotIds, matching plant/subtype, with stock issued
              const sowingRequest = await SowingRequest.findOne({
                linkedSlotIds: { $in: [new mongoose.Types.ObjectId(actualSlotIdForSowing)] },
                plantId: new mongoose.Types.ObjectId(plantId),
                subtypeId: new mongoose.Types.ObjectId(subtypeId),
                status: { $in: ['issued', 'processing'] }, // Stock has been issued
                outwardId: { $exists: true, $ne: null }, // Must have outwardId (stock issued)
              }).sort({ issuedDate: -1 }); // Get most recent one
              
              if (sowingRequest) {
                console.log(`[sowingInProgress] ✅ Found SowingRequest: ${sowingRequest.requestNumber} (${sowingRequest._id})`);
                return sowingRequest;
              } else {
                console.log(`[sowingInProgress] ⚠️ No SowingRequest found for slotId=${actualSlotIdForSowing}`);
                return null;
              }
            } catch (error) {
              console.error(`[sowingInProgress] ❌ Error finding SowingRequest by slot:`, error);
              return null;
            }
          }
          
          // Helper function to create return request from SowingRequest (when no progress entry)
          async function createReturnRequestFromRequest(sowingRequest, packetsUsed, packetsRemaining, userId, request) {
            try {
              console.log(`[sowingInProgress] 🔄 createReturnRequestFromRequest called with:`, {
                requestNumber: sowingRequest.requestNumber,
                sowingRequestId: sowingRequest._id?.toString(),
                packetsUsed,
                packetsRemaining,
                packetsRequested: sowingRequest.packetsRequested,
                userId: userId?.toString()
              });
              
              // Validate packetsRemaining is reasonable (not more than packetsRequested)
              if (sowingRequest.packetsRequested && packetsRemaining > sowingRequest.packetsRequested) {
                console.warn(`[sowingInProgress] ⚠️ WARNING: packetsRemaining (${packetsRemaining}) > packetsRequested (${sowingRequest.packetsRequested}). This might be a calculation error.`);
              }
              
              if (packetsRemaining <= 0) {
                console.log(`[sowingInProgress] ⚠️ Skipping return request creation (packetsRemaining <= 0)`);
                return;
              }
              
              if (!sowingRequest.outwardId) {
                console.warn(`[sowingInProgress] ⚠️ No outwardId found for request ${sowingRequest.requestNumber}`);
                return;
              }
              
              console.log(`[sowingInProgress] Creating return request for ${packetsRemaining} packets`);
              
              // Find the outward entry
              const outward = await InventoryOutward.findById(sowingRequest.outwardId);
              if (!outward || !outward.items || outward.items.length === 0) {
                console.warn(`[sowingInProgress] ⚠️ No outward items found`);
                return;
              }
              
              // Get first item (assuming single product per request)
              const item = outward.items[0];
              const productId = item.product?.toString() || item.product;
              const batchId = item.batch?.toString() || item.batch;
              const unitId = item.unit?.toString() || item.unit;
              
              // Calculate original quantity from outward item
              const originalQuantity = item.quantity || 0;
              
              // Generate return request number
              const requestNumber = await ReturnRequest.generateRequestNumber();
              
              // Create return request
              const returnRequest = new ReturnRequest({
                requestNumber,
                returnType: 'sowing',
                product: productId,
                batch: batchId || null,
                quantity: packetsRemaining,
                unit: unitId,
                referenceType: 'Sowing',
                referenceId: sowingRequest._id,
                referenceNumber: sowingRequest.requestNumber,
                outwardId: sowingRequest.outwardId,
                itemId: item._id,
                originalQuantity: originalQuantity,
                usedQuantity: packetsUsed,
                remainingQuantity: packetsRemaining,
                reason: 'End of sowing - return remaining unused packets',
                remarks: `Remaining ${packetsRemaining} packets returned from sowing request ${sowingRequest.requestNumber} (used ${packetsUsed} out of ${originalQuantity})`,
                status: 'pending',
                requestedBy: userId || request.user?._id,
                metadata: {
                  sowingRequestId: sowingRequest._id,
                  requestNumber: sowingRequest.requestNumber,
                  packetsUsed: packetsUsed,
                  packetsRemaining: packetsRemaining
                }
              });
              
              await returnRequest.save();
              console.log(`[sowingInProgress] ✅ Created return request ${requestNumber} for ${packetsRemaining} packets`);
              console.log(`[sowingInProgress] 📄 Return request details:`, {
                requestNumber,
                quantity: packetsRemaining,
                productId,
                batchId,
                outwardId: sowingRequest.outwardId?.toString(),
                itemId: item._id?.toString()
              });
            } catch (error) {
              console.error(`[sowingInProgress] ❌ Error creating return request:`, error);
              console.error(`[sowingInProgress] ❌ Error stack:`, error.stack);
            }
          }
          
          // Helper function to mark packets as used from progress entry
          async function markPacketsAsUsed(progress, packetsUsed) {
            try {
              console.log(`[sowingInProgress] 🔄 markPacketsAsUsed called with:`, {
                progressRequestNumber: progress?.requestNumber,
                progressSowingRequestId: progress?.sowingRequestId?.toString(),
                packetsUsed
              });
              
              if (packetsUsed <= 0) {
                console.log(`[sowingInProgress] ⚠️ Skipping mark as used (packetsUsed <= 0)`);
                return;
              }
              
              console.log(`[sowingInProgress] Marking ${packetsUsed} packets as used`);
              
              // Find the SowingRequest to get outwardId
              const sowingRequest = await SowingRequest.findById(progress.sowingRequestId);
              if (!sowingRequest || !sowingRequest.outwardId) {
                console.warn(`[sowingInProgress] ⚠️ No SowingRequest found or no outwardId for requestId: ${progress.sowingRequestId?.toString()}`);
                return;
              }
              console.log(`[sowingInProgress] ✅ Found SowingRequest: ${sowingRequest._id?.toString()}, outwardId: ${sowingRequest.outwardId?.toString()}`);
              
              // Update outward item usedQuantity
              const outward = await InventoryOutward.findById(sowingRequest.outwardId);
              if (!outward || !outward.items || outward.items.length === 0) {
                console.warn(`[sowingInProgress] ⚠️ No InventoryOutward found or no items for outwardId: ${sowingRequest.outwardId?.toString()}`);
                return;
              }
              console.log(`[sowingInProgress] ✅ Found InventoryOutward: ${outward._id?.toString()}, items count: ${outward.items.length}`);
              
              const item = outward.items[0];
              const currentUsed = item.usedQuantity || 0;
              item.usedQuantity = currentUsed + packetsUsed;
              
              await outward.save();
              console.log(`[sowingInProgress] ✅ Updated usedQuantity from ${currentUsed} to ${item.usedQuantity}`);
              console.log(`[sowingInProgress] 📦 InventoryOutward update details:`, {
                outwardId: outward._id?.toString(),
                itemId: item._id?.toString(),
                previousUsed: currentUsed,
                packetsAdded: packetsUsed,
                newUsed: item.usedQuantity
              });
            } catch (error) {
              console.error(`[sowingInProgress] ❌ Error marking packets as used:`, error);
              console.error(`[sowingInProgress] ❌ Error stack:`, error.stack);
            }
          }
          
          // Helper function to mark packets as used from SowingRequest (when no progress entry)
          async function markPacketsAsUsedFromRequest(sowingRequest, packetsUsed) {
            try {
              console.log(`[sowingInProgress] 🔄 markPacketsAsUsedFromRequest called with:`, {
                requestNumber: sowingRequest.requestNumber,
                sowingRequestId: sowingRequest._id?.toString(),
                packetsUsed
              });
              
              if (packetsUsed <= 0) {
                console.log(`[sowingInProgress] ⚠️ Skipping mark as used (packetsUsed <= 0)`);
                return;
              }
              
              if (!sowingRequest.outwardId) {
                console.warn(`[sowingInProgress] ⚠️ No outwardId found for request ${sowingRequest.requestNumber}`);
                return;
              }
              
              console.log(`[sowingInProgress] Marking ${packetsUsed} packets as used`);
              
              // Update outward item usedQuantity
              const outward = await InventoryOutward.findById(sowingRequest.outwardId);
              if (!outward || !outward.items || outward.items.length === 0) {
                console.warn(`[sowingInProgress] ⚠️ No InventoryOutward found or no items for outwardId: ${sowingRequest.outwardId?.toString()}`);
                return;
              }
              console.log(`[sowingInProgress] ✅ Found InventoryOutward: ${outward._id?.toString()}, items count: ${outward.items.length}`);
              
              const item = outward.items[0];
              const currentUsed = item.usedQuantity || 0;
              item.usedQuantity = currentUsed + packetsUsed;
              
              await outward.save();
              console.log(`[sowingInProgress] ✅ Updated usedQuantity from ${currentUsed} to ${item.usedQuantity}`);
              console.log(`[sowingInProgress] 📦 InventoryOutward update details:`, {
                outwardId: outward._id?.toString(),
                itemId: item._id?.toString(),
                previousUsed: currentUsed,
                packetsAdded: packetsUsed,
                newUsed: item.usedQuantity
              });
            } catch (error) {
              console.error(`[sowingInProgress] ❌ Error marking packets as used:`, error);
              console.error(`[sowingInProgress] ❌ Error stack:`, error.stack);
            }
          }
          
          try {
            const searchSlotId = actualSlotObjectIdForSowing || new mongoose.Types.ObjectId(actualSlotIdForSowing);
            const sowedPlantValue = Number(effectiveSlotPlants) || 0;
            const location = sowingLocation || "OFFICE";
            // ✅ Extract packetsUsed and packetsToReturn from payload for in-progress cleanup
            const packetsUsedValue = (packetsUsed !== undefined && packetsUsed !== null) ? Number(packetsUsed) : 0;
            const packetsToReturnValue = (packetsToReturn !== undefined && packetsToReturn !== null) ? Number(packetsToReturn) : 0;
            console.log(`[sowingInProgress] Extracted values - packetsUsed: ${packetsUsedValue}, packetsToReturn: ${packetsToReturnValue}`);
            
            // Check if this is excessive sowing - need to check here for scope access
            let isExcessiveSowingLocal = false;
            if (packets && packets.length > 0) {
              isExcessiveSowingLocal = packets.some(p => p.isExcessiveSowing === true);
            }

            console.log(`[sowingInProgress] Looking for slot with ID: ${searchSlotId}`);
            // Find the slot document
            const slotDoc = await PlantSlot.findOne({ "subtypeSlots.slots._id": searchSlotId });
            
            if (!slotDoc) {
              console.log(`[sowingInProgress] ❌ No slot document found for slotId: ${searchSlotId}`);
            }
            
            if (slotDoc) {
              console.log(`[sowingInProgress] ✅ Found slot document for slotId: ${searchSlotId}`);
              const subtypeSlot = slotDoc.subtypeSlots.find(st => 
                st.slots.some(s => s._id.toString() === actualSlotIdForSowing.toString())
              );
              
              if (subtypeSlot) {
                const slotToUpdate = subtypeSlot.slots.find(s => s._id.toString() === actualSlotIdForSowing.toString());
                
                if (slotToUpdate) {
                  // Debug: Log slot structure
                  console.log(`[sowingInProgress] 📊 Slot details:`, {
                    slotId: slotToUpdate._id?.toString(),
                    startDay: slotToUpdate.startDay,
                    sowingInProgressLength: slotToUpdate.sowingInProgress?.length || 0,
                    sowingInProgress: slotToUpdate.sowingInProgress || [],
                    officeSowed: slotToUpdate.officeSowed,
                    availablePlants: slotToUpdate.availablePlants
                  });
                  // LOGIC:
                  // 1. If completeSowing = true → Clear sowingInProgress (sowing is done, packets returned if any)
                  // 2. If completeSowing = true AND PRIMARY location → Add to availablePlants
                  // 3. Store packet info in sowingInProgress for OFFICE sowing (record-keeping)
                  
                  // ALWAYS completeSowing = true (from frontend)
                  // Logic:
                  // 1. ALWAYS clear sowingInProgress FIRST (sowing is always complete)
                  // 2. If sowedPlant > 0, add to availablePlants (plants are ready)
                  // 3. Track packets for record-keeping before clearing
                  
                  console.log(`[sowingInProgress] ✅ completeSowing=true → Processing complete sowing`);
                  
                  // ✅ CRITICAL: Clear sowingInProgress IMMEDIATELY when completeSowing=true
                  // This prevents any entries from being processed or added
                  const inProgressCountBefore = slotToUpdate.sowingInProgress?.length || 0;
                  const inProgressEntriesSnapshot = slotToUpdate.sowingInProgress ? [...slotToUpdate.sowingInProgress] : [];
                  
                  if (completeSowing && slotToUpdate.sowingInProgress && slotToUpdate.sowingInProgress.length > 0) {
                    console.log(`[sowingInProgress] 🧹 IMMEDIATE CLEAR: Clearing ${slotToUpdate.sowingInProgress.length} entries (completeSowing=true)`);
                    
                    // Log clearing of in-progress entries
                    slotToUpdate.logSowingActivity({
                      action: "SOWING_IN_PROGRESS_CLEARED",
                      activityName: "Sowing In Progress Cleared - Sowing Completed",
                      quantity: inProgressCountBefore,
                      minus: {
                        inProgressEntries: inProgressCountBefore,
                      },
                      before: {
                        inProgressCount: inProgressCountBefore,
                        primarySowed: slotToUpdate.primarySowed || 0,
                        officeSowed: slotToUpdate.officeSowed || 0,
                        totalPlants: slotToUpdate.totalPlants || 0,
                        availablePlants: slotToUpdate.availablePlants || 0,
                      },
                      after: {
                        inProgressCount: 0,
                        primarySowed: slotToUpdate.primarySowed || 0,
                        officeSowed: slotToUpdate.officeSowed || 0,
                        totalPlants: slotToUpdate.totalPlants || 0,
                        availablePlants: slotToUpdate.availablePlants || 0,
                      },
                      sowingId: savedSowing._id,
                      sowingLocation: location,
                      batchNumber: batchNumber || 'N/A',
                      sowingDate: sowingDate,
                      plantReadyDate: plantReadyDate,
                      performedBy: createdBy || req.user?._id,
                      reason: `Cleared ${inProgressCountBefore} in-progress entry/entries - sowing completed`,
                      notes: `Sowing marked as complete. Cleared all in-progress entries.`,
                      metadata: {
                        inProgressEntriesCleared: inProgressEntriesSnapshot,
                        completeSowing: true,
                      },
                    });
                    
                    slotToUpdate.sowingInProgress = [];
                  } else if (completeSowing) {
                    // Ensure it's an empty array even if it was undefined
                    slotToUpdate.sowingInProgress = [];
                    console.log(`[sowingInProgress] 🧹 IMMEDIATE CLEAR: Initialized empty array (completeSowing=true)`);
                  }
                  
                  // Step 1: Calculate totalPacketsUsed (but DON'T push to sowingInProgress yet - we need to process existing entries first)
                  let totalPacketsUsed = 0;
                  if (packets && packets.length > 0) {
                    totalPacketsUsed = packets.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
                    console.log(`[sowingInProgress] 📦 Calculated totalPacketsUsed from packets array: ${totalPacketsUsed}`);
                  } else if (packetsUsed !== undefined && packetsUsed !== null) {
                    // For in-progress sowings, use explicit packetsUsed if provided
                    totalPacketsUsed = Number(packetsUsed) || 0;
                    console.log(`[sowingInProgress] 📦 Using explicit packetsUsed: ${totalPacketsUsed}`);
                  } else if (totalQuantityRequired > 0) {
                    // Fallback: use totalQuantityRequired as packets
                    totalPacketsUsed = totalQuantityRequired;
                    console.log(`[sowingInProgress] 📦 Using totalQuantityRequired as packets: ${totalPacketsUsed}`);
                  }
                  
                  // Update officeSowed with packets used (this is the PRIMARY sowing, packets should be tracked)
                  if (totalPacketsUsed > 0) {
                    if (slotToUpdate.officeSowed === undefined) {
                      slotToUpdate.officeSowed = 0;
                    }
                    slotToUpdate.officeSowed += totalPacketsUsed;
                    console.log(`[sowingInProgress] ✅ Updated officeSowed: +${totalPacketsUsed} (now ${slotToUpdate.officeSowed})`);
                  }
                  
                  // Check if this is excessive sowing (from progress entry or packets)
                  const progressIsExcessive = slotToUpdate.sowingInProgress?.[0]?.isExcessiveSowing || false;
                  const packetsIsExcessive = packets && packets.length > 0 && packets.some(p => p.isExcessiveSowing === true);
                  const cleanupIsExcessiveSowing = progressIsExcessive || packetsIsExcessive || isExcessiveSowingLocal;
                  
                  console.log(`[ExcessiveSowing] Cleanup check: progressIsExcessive=${progressIsExcessive}, packetsIsExcessive=${packetsIsExcessive}, isExcessiveSowingLocal=${isExcessiveSowingLocal}, cleanupIsExcessiveSowing=${cleanupIsExcessiveSowing}`);
                  
                  // Step 2: Distribute plants - FIRST cover previous gaps (skip for excessive), THEN add to current slot
                  if (sowedPlantValue > 0) {
                    let remainingPlants = sowedPlantValue;
                    
                    // Skip gap coverage for excessive sowing (excessive plants don't cover order gaps)
                    if (!cleanupIsExcessiveSowing) {
                      console.log(`[GapCoverage] 🎯 Starting gap coverage distribution for ${remainingPlants} plants (regular sowing)`);
                      
                      // Find all previous slots with gaps for this plant/subtype
                      const currentSlotDate = moment(slotToUpdate.startDay, "DD-MM-YYYY");
                      const allSlots = subtypeSlot.slots
                        .filter(s => {
                          const slotDate = moment(s.startDay, "DD-MM-YYYY");
                          return slotDate.isBefore(currentSlotDate); // Only previous slots
                        })
                        .sort((a, b) => {
                          // Sort oldest first (22 -> 23 -> 24)
                          const dateA = moment(a.startDay, "DD-MM-YYYY");
                          const dateB = moment(b.startDay, "DD-MM-YYYY");
                          return dateA.diff(dateB);
                        });
                    
                      console.log(`[GapCoverage] Found ${allSlots.length} previous slots to check`);
                      
                      // ✅ VALIDATION: Check for previous gaps
                      const previousGaps = allSlots
                        .map(s => {
                          const gap = (s.totalBookedPlants || 0) - (s.primarySowed || 0);
                          const covered = (s.gapCovered || []).reduce((sum, g) => sum + (g.plantsCovered || 0), 0);
                          return {
                            slotDate: s.startDay,
                            gap: Math.max(0, gap - covered),
                          };
                        })
                        .filter(s => s.gap > 0);
                      
                      if (previousGaps.length > 0) {
                        const totalPreviousGaps = previousGaps.reduce((sum, s) => sum + s.gap, 0);
                        console.log(`[GapCoverage] ⚠️ Found ${previousGaps.length} previous slots with gaps (total: ${totalPreviousGaps})`);
                        console.log(`[GapCoverage] 📋 Gap details:`, previousGaps);
                        
                        if (totalPreviousGaps > sowedPlantValue) {
                          console.log(`[GapCoverage] ⚠️ WARNING: Sowing ${sowedPlantValue} plants, but ${totalPreviousGaps} needed to cover all previous gaps`);
                          console.log(`[GapCoverage] 📌 Plants will be distributed to cover gaps oldest-first`);
                        } else {
                          console.log(`[GapCoverage] ✅ Sowing ${sowedPlantValue} plants: ${totalPreviousGaps} to cover gaps, ${sowedPlantValue - totalPreviousGaps} to current slot`);
                        }
                      }
                      
                      // Distribute plants to cover gaps in previous slots (oldest first)
                      // IMPORTANT: do NOT over-cover. If a previous slot already has `gapCovered`,
                      // only the remaining uncovered gap should be covered.
                      for (const prevSlot of allSlots) {
                        if (remainingPlants <= 0) break;

                        const totalGapForSlot = Math.max(
                          0,
                          (prevSlot.totalBookedPlants || 0) - (prevSlot.primarySowed || 0)
                        );
                        const alreadyCoveredForSlot = (prevSlot.gapCovered || []).reduce(
                          (sum, g) => sum + (g.plantsCovered || 0),
                          0
                        );
                        const uncoveredGapForSlot = Math.max(0, totalGapForSlot - alreadyCoveredForSlot);

                        if (uncoveredGapForSlot > 0) {
                          const toCover = Math.min(remainingPlants, uncoveredGapForSlot);
                          
                          console.log(`[GapCoverage] 📍 Slot ${prevSlot.startDay}: UncoveredGap=${uncoveredGapForSlot}, Covering=${toCover}`);
                          
                          // Initialize gapCovered array if not exists
                          if (!prevSlot.gapCovered) {
                            prevSlot.gapCovered = [];
                          }
                          
                          // Capture before state for gap coverage logging
                          const prevSlotBeforeGapCovered = (prevSlot.gapCovered || []).reduce((sum, g) => sum + (g.plantsCovered || 0), 0);
                          
                          // Add coverage entry
                          prevSlot.gapCovered.push({
                            fromSlotId: slotToUpdate._id,
                            fromSlotDate: slotToUpdate.startDay,
                            plantsCovered: toCover,
                            coverageDate: new Date(),
                            sowingBatchNumber: batchNumber || 'N/A',
                            sowingId: savedSowing._id,
                          });
                          
                          // Check if gap is fully covered
                          const totalCovered = prevSlot.gapCovered.reduce((sum, g) => sum + (g.plantsCovered || 0), 0);
                          if (totalCovered >= totalGapForSlot) {
                            prevSlot.gapFullyCovered = true;
                          }
                          
                          remainingPlants -= toCover;
                          
                          console.log(`[GapCoverage] ✅ Covered ${toCover} plants in slot ${prevSlot.startDay}, remaining: ${remainingPlants}`);
                          
                          // Log gap coverage activity on previous slot
                          prevSlot.logSowingActivity({
                            action: "GAP_COVERED",
                            activityName: "Gap Coverage from Later Slot",
                            quantity: toCover,
                            plus: {
                              gapCovered: toCover,
                            },
                            before: {
                              totalBookedPlants: prevSlot.totalBookedPlants || 0,
                              primarySowed: prevSlot.primarySowed || 0,
                              gapCovered: prevSlotBeforeGapCovered,
                            },
                            after: {
                              totalBookedPlants: prevSlot.totalBookedPlants || 0,
                              primarySowed: prevSlot.primarySowed || 0,
                              gapCovered: totalCovered,
                              gapFullyCovered: prevSlot.gapFullyCovered || false,
                            },
                            sowingId: savedSowing._id,
                            batchNumber: batchNumber || 'N/A',
                            sowingDate: sowingDate,
                            plantReadyDate: plantReadyDate,
                            performedBy: createdBy || req.user?._id,
                            reason: `Gap covered from later slot (${slotToUpdate.startDay}) sowing`,
                            notes: `Covered ${toCover} plants. Total covered: ${totalCovered}/${totalGapForSlot}. Fully covered: ${prevSlot.gapFullyCovered}`,
                            gapCoverageDetails: {
                              fromSlotId: slotToUpdate._id,
                              fromSlotDate: slotToUpdate.startDay,
                              plantsCovered: toCover,
                              toSlotId: prevSlot._id,
                              toSlotDate: prevSlot.startDay,
                            },
                            metadata: {
                              gapBeforeCoverage: uncoveredGapForSlot,
                              totalCovered,
                              isFullyCovered: prevSlot.gapFullyCovered,
                            },
                          });
                        }
                      }
                      
                      // availablePlants is already incremented by the full sowedPlantValue above.
                      // Keep gap coverage separate from immediate availability increment.
                      console.log(`[GapCoverage] ℹ️ availablePlants already increased by full sowedPlantValue=${sowedPlantValue}`);
                      
                      console.log(`[GapCoverage] 🎯 Distribution complete: ${sowedPlantValue} plants total, ${sowedPlantValue - remainingPlants} to gaps, ${remainingPlants} to current slot`);
                    } else {
                      // For excessive sowing: skip gap coverage, but still update primarySowed for availablePlants/totalPlants
                      console.log(`[ExcessiveSowing] ⏭️ Skipping gap coverage - all plants go to excessiveSowing.plants AND primarySowed`);
                      
                      if (remainingPlants > 0) {
                      // For excessive sowing: keep separate tracking and add ready plants to availability.
                        if (!slotToUpdate.excessiveSowing) {
                          slotToUpdate.excessiveSowing = { packets: 0, plants: 0 };
                        }
                        slotToUpdate.excessiveSowing.plants = (slotToUpdate.excessiveSowing.plants || 0) + remainingPlants;

                      // totalPlants/primarySowed/availablePlants were already incremented in the initial slot update.
                        console.log(`[ExcessiveSowing] ✅ Added ${remainingPlants} to excessiveSowing.plants (now ${slotToUpdate.excessiveSowing.plants})`);
                      console.log(`[ExcessiveSowing] ✅ Updated availability only after base slot increment. primarySowed: ${slotToUpdate.primarySowed}, totalPlants: ${slotToUpdate.totalPlants}, availablePlants: ${slotToUpdate.availablePlants}`);
                      }
                      
                      console.log(`[ExcessiveSowing] 🎯 Excessive sowing complete: ${remainingPlants} plants added to excessiveSowing.plants and availablePlants`);
                    }
                  }
                  
                  // Step 3: Process sowingInProgress entries (if any) OR handle in-progress sowings with packetsUsed/packetsToReturn
                  // ✅ SKIP processing if completeSowing=true (already cleared above)
                  if (!completeSowing) {
                    const currentProgressLength = slotToUpdate.sowingInProgress?.length || 0;
                    console.log(`[sowingInProgress] Checking for in-progress entries. Array length: ${currentProgressLength}`);
                    console.log(`[sowingInProgress] Payload has packetsUsed: ${packetsUsedValue}, packetsToReturn: ${packetsToReturnValue}`);
                    if (currentProgressLength > 0) {
                      console.log(`[sowingInProgress] Current sowingInProgress entries:`, JSON.stringify(slotToUpdate.sowingInProgress, null, 2));
                    }
                    
                    // ✅ ALWAYS clear sowingInProgress if packetsUsed is provided (in-progress sowing completion)
                    // This ensures cleanup happens even if the array structure doesn't match exactly
                    if (packetsUsedValue > 0 || packetsToReturnValue > 0) {
                      console.log(`[sowingInProgress] ✅ In-progress sowing detected (packetsUsed=${packetsUsedValue}, packetsToReturn=${packetsToReturnValue}) - will clear sowingInProgress`);
                    }
                  } else {
                    console.log(`[sowingInProgress] ⏭️ Skipping in-progress processing (completeSowing=true, already cleared)`);
                  }
                  
                  if (!completeSowing && slotToUpdate.sowingInProgress && slotToUpdate.sowingInProgress.length > 0) {
                    console.log(`[sowingInProgress] ✅ Found ${slotToUpdate.sowingInProgress.length} in-progress entries for slot ${actualSlotIdForSowing}`);
                    console.log(`[sowingInProgress] Entries:`, JSON.stringify(slotToUpdate.sowingInProgress, null, 2));
                    
                    // Process the first in-progress entry (there should only be one per slot)
                    const progress = slotToUpdate.sowingInProgress[0];
                    const packetsIssued = progress.packetsIssued || 0;
                    
                    console.log(`[sowingInProgress] Processing entry: requestNumber=${progress.requestNumber}, packetsIssued=${packetsIssued}, packetsUsed=${packetsUsedValue || 0}, packetsToReturn=${packetsToReturnValue || 0}`);
                    
                    // ✅ Use packetsToReturn from frontend (already calculated)
                    if (packetsToReturnValue > 0) {
                      console.log(`[sowingInProgress] ✅ Creating return request for ${packetsToReturnValue} packets`);
                      await createReturnRequestForProgress(progress, packetsUsedValue, packetsToReturnValue, createdBy, req);
                    } else {
                      console.log(`[sowingInProgress] ⚠️ No return request needed (packetsToReturn: ${packetsToReturnValue})`);
                    }
                    
                    // Mark packets as used in InventoryOutward
                    if (packetsUsedValue > 0) {
                      console.log(`[sowingInProgress] ✅ Marking ${packetsUsedValue} packets as used`);
                      await markPacketsAsUsed(progress, packetsUsedValue);
                    } else {
                      console.log(`[sowingInProgress] ⚠️ No packets to mark as used (packetsUsed: ${packetsUsedValue})`);
                    }
                    
                    // Update slot officeSowed (add packets used) - this is already done above, but doing it again to ensure it's tracked
                    if (packetsUsedValue > 0 && slotToUpdate.officeSowed !== undefined) {
                      // Already updated above in Step 1, just log it
                      console.log(`[sowingInProgress] ✅ Slot officeSowed already updated to: ${slotToUpdate.officeSowed}`);
                    }
                    
                    // Add SOWING_COMPLETED to slotTrail
                    if (!slotToUpdate.slotTrail) {
                      slotToUpdate.slotTrail = [];
                    }
                    
                    // Capture current slot values (after gap coverage distribution in Step 2)
                    // Note: Since this is Step 3, availablePlants may have been updated by gap coverage
                    // For SOWING_COMPLETED, we're just recording the completion, not tracking plant changes
                    // The actual plant changes are tracked separately in gap coverage
                    const previousTotalPlants = slotToUpdateBefore?.totalPlants || 0;
                    const previousAvailablePlants = slotToUpdateBefore?.availablePlants || 0;
                    const newTotalPlants = slotToUpdate.totalPlants || 0; // No change to totalPlants from this action
                    const newAvailablePlants = slotToUpdate.availablePlants || 0; // Current value after gap coverage
                    
                    slotToUpdate.slotTrail.push({
                      action: 'SOWING_COMPLETED',
                      quantity: sowedPlantValue || 0, // Required: quantity of plants sowed
                      previousTotalPlants: previousTotalPlants, // Required
                      newTotalPlants: newTotalPlants, // Required
                      previousAvailablePlants: previousAvailablePlants, // Required
                      newAvailablePlants: newAvailablePlants, // Required (will be updated after gap coverage)
                      reason: `Sowing completed for ${progress.requestNumber}`,
                      sowingRequestId: progress.sowingRequestId,
                      performedBy: createdBy || req.user?._id,
                      notes: `Request ${progress.requestNumber}: Used ${packetsUsedValue || 0} packets, Returning ${packetsToReturnValue || 0} packets. Plants sowed: ${sowedPlantValue || 0}. Batch: ${batchNumber}`,
                    });
                    
                    // Clear sowingInProgress (sowing complete for this day)
                    slotToUpdate.sowingInProgress = [];
                    console.log(`[sowingInProgress] ✅ Cleared sowingInProgress array`);
                  } else if (packetsUsedValue > 0 || packetsToReturnValue > 0) {
                    // No existing entries but we have packetsUsed/packetsToReturn - find SowingRequest by slotId
                    console.log(`[sowingInProgress] ℹ️ No sowingInProgress entries found but packetsUsed=${packetsUsedValue} or packetsToReturn=${packetsToReturnValue}`);
                    console.log(`[sowingInProgress] 🔍 Attempting to find SowingRequest by slotId, plantId, subtypeId...`);
                    
                    // Find SowingRequest linked to this slot
                    const sowingRequest = await findSowingRequestBySlot(actualSlotIdForSowing, plantId, subtypeId);
                    
                    if (sowingRequest) {
                      console.log(`[sowingInProgress] ✅ Found SowingRequest: ${sowingRequest.requestNumber}`);
                      
                      // Create return request if needed
                      if (packetsToReturnValue > 0) {
                        console.log(`[sowingInProgress] ✅ Creating return request for ${packetsToReturnValue} packets`);
                        await createReturnRequestFromRequest(sowingRequest, packetsUsedValue, packetsToReturnValue, createdBy, req);
                      } else {
                        console.log(`[sowingInProgress] ⚠️ No return request needed (packetsToReturn: ${packetsToReturnValue})`);
                      }
                      
                      // Mark packets as used
                      if (packetsUsedValue > 0) {
                        console.log(`[sowingInProgress] ✅ Marking ${packetsUsedValue} packets as used`);
                        await markPacketsAsUsedFromRequest(sowingRequest, packetsUsedValue);
                      } else {
                        console.log(`[sowingInProgress] ⚠️ No packets to mark as used (packetsUsed: ${packetsUsedValue})`);
                      }
                      
                      // Clear sowingInProgress array (even if it was empty, ensure it's cleared)
                      if (slotToUpdate.sowingInProgress && slotToUpdate.sowingInProgress.length > 0) {
                        console.log(`[sowingInProgress] ℹ️ Clearing ${slotToUpdate.sowingInProgress.length} existing sowingInProgress entries`);
                      }
                      slotToUpdate.sowingInProgress = [];
                      console.log(`[sowingInProgress] ✅ Cleared sowingInProgress array`);
                      
                      // Add SOWING_COMPLETED to slotTrail
                      if (!slotToUpdate.slotTrail) {
                        slotToUpdate.slotTrail = [];
                      }
                      
                      const previousTotalPlants = slotToUpdateBefore?.totalPlants || 0;
                      const previousAvailablePlants = slotToUpdateBefore?.availablePlants || 0;
                      const newTotalPlants = slotToUpdate.totalPlants || 0;
                      const newAvailablePlants = slotToUpdate.availablePlants || 0;
                      
                      slotToUpdate.slotTrail.push({
                        action: 'SOWING_COMPLETED',
                        quantity: sowedPlantValue || 0,
                        previousTotalPlants: previousTotalPlants,
                        newTotalPlants: newTotalPlants,
                        previousAvailablePlants: previousAvailablePlants,
                        newAvailablePlants: newAvailablePlants,
                        reason: `Sowing completed for ${sowingRequest.requestNumber}`,
                        sowingRequestId: sowingRequest._id,
                        performedBy: createdBy || req.user?._id,
                        notes: `Request ${sowingRequest.requestNumber}: Used ${packetsUsedValue || 0} packets, Returning ${packetsToReturnValue || 0} packets. Plants sowed: ${sowedPlantValue || 0}. Batch: ${batchNumber}`,
                      });
                    } else {
                      console.log(`[sowingInProgress] ⚠️ Could not find SowingRequest for slotId=${actualSlotIdForSowing}. Cannot create return request or mark packets.`);
                    }
                  } else {
                    console.log(`[sowingInProgress] ℹ️ No in-progress entries and no packetsUsed/packetsToReturn - skipping cleanup`);
                  }
                  
                  // ✅ FINAL STEP: ALWAYS ensure sowingInProgress is cleared when completeSowing=true OR packetsUsed is provided
                  // This is a safety measure to ensure it's cleared even if we didn't enter any of the above branches
                  if (completeSowing || packetsUsedValue > 0 || packetsToReturnValue > 0) {
                    if (slotToUpdate.sowingInProgress && slotToUpdate.sowingInProgress.length > 0) {
                      console.log(`[sowingInProgress] 🧹 Final cleanup: Clearing ${slotToUpdate.sowingInProgress.length} remaining sowingInProgress entries (completeSowing=${completeSowing}, packetsUsed=${packetsUsedValue})`);
                    }
                    // Always clear the array when sowing is complete or packetsUsed is provided
                    slotToUpdate.sowingInProgress = [];
                    console.log(`[sowingInProgress] ✅ Final cleanup: Cleared sowingInProgress array`);
                  } else {
                    // Ensure it's an empty array
                    if (!slotToUpdate.sowingInProgress) {
                      slotToUpdate.sowingInProgress = [];
                    }
                  }
                  console.log(`[sowingInProgress] ✅ Final state: sowingInProgress.length = ${slotToUpdate.sowingInProgress.length}`);
                  
                  // ✅ CRITICAL: Ensure sowingInProgress is cleared before saving (double-check)
                  if (packetsUsedValue > 0 || packetsToReturnValue > 0 || completeSowing) {
                    const beforeClear = slotToUpdate.sowingInProgress?.length || 0;
                    slotToUpdate.sowingInProgress = [];
                    console.log(`[sowingInProgress] 🔒 CRITICAL CLEANUP: Cleared ${beforeClear} entries before save (packetsUsed=${packetsUsedValue}, completeSowing=${completeSowing})`);
                  }
                  
                  // Save slot updates
                  slotDoc.markModified('subtypeSlots');
                  slotDoc.markModified('subtypeSlots.slots');
                  await slotDoc.save();
                  console.log(`[sowingInProgress] ✅ Slot updated successfully`);
                  
                  // ✅ VERIFY: Re-fetch slot to confirm cleanup
                  const verifySlot = await PlantSlot.findOne({ "subtypeSlots.slots._id": searchSlotId });
                  if (verifySlot) {
                    const verifySubtypeSlot = verifySlot.subtypeSlots.find(st => 
                      st.slots.some(s => s._id.toString() === actualSlotIdForSowing.toString())
                    );
                    if (verifySubtypeSlot) {
                      const verifySlotToCheck = verifySubtypeSlot.slots.find(s => s._id.toString() === actualSlotIdForSowing.toString());
                      if (verifySlotToCheck) {
                        const verifyLength = verifySlotToCheck.sowingInProgress?.length || 0;
                        console.log(`[sowingInProgress] ✅ VERIFICATION: After save, sowingInProgress.length = ${verifyLength}`);
                        if (verifyLength > 0 && (packetsUsedValue > 0 || packetsToReturnValue > 0 || completeSowing)) {
                          console.error(`[sowingInProgress] ❌ ERROR: sowingInProgress still has ${verifyLength} entries after save! Force clearing...`);
                          // Force clear again
                          verifySlotToCheck.sowingInProgress = [];
                          verifySlot.markModified('subtypeSlots');
                          verifySlot.markModified('subtypeSlots.slots');
                          await verifySlot.save();
                          console.log(`[sowingInProgress] 🔧 FORCE CLEARED: Cleared again after verification`);
                        }
                      }
                    }
                  }
                  
                  console.log(`[sowingInProgress] 📊 Final slot state:`, {
                    slotId: slotToUpdate._id?.toString(),
                    sowingInProgressLength: slotToUpdate.sowingInProgress?.length || 0,
                    officeSowed: slotToUpdate.officeSowed,
                    availablePlants: slotToUpdate.availablePlants,
                    totalPlants: slotToUpdate.totalPlants
                  });
                  
                  // ✅ NEW: Clear sowingInProgress for ALL linked slots in the same request (even if not in payload)
                  // This ensures when one slot is sown, all other slots in the multi-slot request are also cleared
                  try {
                    console.log(`[sowingInProgress] 🔄 Checking for other linked slots to clear...`);
                    const sowingRequest = await findSowingRequestBySlot(actualSlotIdForSowing, plantId, subtypeId);
                    
                    if (sowingRequest && sowingRequest.linkedSlotIds && sowingRequest.linkedSlotIds.length > 1) {
                      console.log(`[sowingInProgress] ✅ Found multi-slot request ${sowingRequest.requestNumber} with ${sowingRequest.linkedSlotIds.length} linked slots`);
                      console.log(`[sowingInProgress] 🔍 Processing other linked slots (excluding current slot ${actualSlotIdForSowing})...`);
                      
                      // Get all slotIds from current batch payload
                      const currentBatchSlotIds = sowings.map(s => new mongoose.Types.ObjectId(s.slotId).toString());
                      console.log(`[sowingInProgress] 📋 Current batch slotIds:`, currentBatchSlotIds);
                      
                      // Process each linked slot that's NOT in the current payload
                      for (const linkedSlotId of sowingRequest.linkedSlotIds) {
                        const linkedSlotIdStr = linkedSlotId.toString();
                        
                        // Skip if this is the current slot (already processed above)
                        if (linkedSlotIdStr === actualSlotIdForSowing.toString()) {
                          console.log(`[sowingInProgress] ⏭️ Skipping current slot ${linkedSlotIdStr} (already processed)`);
                          continue;
                        }
                        
                        // Skip if this slot is in the current batch payload
                        if (currentBatchSlotIds.includes(linkedSlotIdStr)) {
                          console.log(`[sowingInProgress] ⏭️ Skipping slot ${linkedSlotIdStr} (will be processed in this batch)`);
                          continue;
                        }
                        
                        console.log(`[sowingInProgress] 🧹 Clearing sowingInProgress for linked slot ${linkedSlotIdStr} (not in payload, using 0 packetsUsed/0 packetsToReturn)`);
                        
                        // Find the slot document
                        const linkedSlotDoc = await PlantSlot.findOne({ "subtypeSlots.slots._id": linkedSlotId });
                        
                        if (linkedSlotDoc) {
                          const linkedSubtypeSlot = linkedSlotDoc.subtypeSlots.find(st => 
                            st.slots.some(s => s._id.toString() === linkedSlotIdStr)
                          );
                          
                          if (linkedSubtypeSlot) {
                            const linkedSlotToUpdate = linkedSubtypeSlot.slots.find(s => s._id.toString() === linkedSlotIdStr);
                            
                            if (linkedSlotToUpdate && linkedSlotToUpdate.sowingInProgress && linkedSlotToUpdate.sowingInProgress.length > 0) {
                              console.log(`[sowingInProgress] ✅ Found linked slot ${linkedSlotIdStr} with ${linkedSlotToUpdate.sowingInProgress.length} sowingInProgress entry/entries`);
                              
                              // Find the matching progress entry for this request
                              const progressEntry = linkedSlotToUpdate.sowingInProgress.find(
                                prog => prog.sowingRequestId?.toString() === sowingRequest._id.toString()
                              );
                              
                              if (progressEntry) {
                                console.log(`[sowingInProgress] 🎯 Found matching progress entry for request ${sowingRequest.requestNumber}`);
                                const packetsIssuedToThisSlot = progressEntry.packetsIssued || 0;
                                console.log(`[sowingInProgress] 📦 Slot ${linkedSlotIdStr} has ${packetsIssuedToThisSlot} packets issued that need to be returned`);
                                
                                // ✅ IMPORTANT: Create return request for ALL packets in this slot (0 used, all returned)
                                // Since this slot wasn't in the payload, no packets were used - all should be returned
                                if (packetsIssuedToThisSlot > 0) {
                                  console.log(`[sowingInProgress] 🔄 Creating return request for ${packetsIssuedToThisSlot} packets from slot ${linkedSlotIdStr} (0 packets used, all packets returned)`);
                                  try {
                                    await createReturnRequestForProgress(progressEntry, 0, packetsIssuedToThisSlot, createdBy, req);
                                    console.log(`[sowingInProgress] ✅ Return request created successfully for slot ${linkedSlotIdStr}`);
                                  } catch (returnRequestError) {
                                    console.error(`[sowingInProgress] ❌ Error creating return request for slot ${linkedSlotIdStr}:`, returnRequestError);
                                    // Continue with clearing even if return request fails
                                  }
                                } else {
                                  console.log(`[sowingInProgress] ℹ️ No packets to return for slot ${linkedSlotIdStr} (packetsIssued: ${packetsIssuedToThisSlot})`);
                                }
                                
                                // Add SOWING_COMPLETED to slotTrail
                                if (!linkedSlotToUpdate.slotTrail) {
                                  linkedSlotToUpdate.slotTrail = [];
                                }
                                
                                const previousTotalPlants = linkedSlotToUpdate.totalPlants || 0;
                                const previousAvailablePlants = linkedSlotToUpdate.availablePlants || 0;
                                const newTotalPlants = linkedSlotToUpdate.totalPlants || 0;
                                const newAvailablePlants = linkedSlotToUpdate.availablePlants || 0;
                                
                                linkedSlotToUpdate.slotTrail.push({
                                  action: 'SOWING_COMPLETED',
                                  quantity: 0, // No plants sowed (slot cleared without sowing entry)
                                  previousTotalPlants: previousTotalPlants,
                                  newTotalPlants: newTotalPlants,
                                  previousAvailablePlants: previousAvailablePlants,
                                  newAvailablePlants: newAvailablePlants,
                                  reason: `Sowing cleared for ${progressEntry.requestNumber} (slot cleared when another slot in same request was sown)`,
                                  sowingRequestId: sowingRequest._id,
                                  performedBy: createdBy || req.user?._id,
                                  notes: `Request ${progressEntry.requestNumber}: Slot cleared (no sowing entry created). All ${packetsIssuedToThisSlot} packets returned.`,
                                });
                                
                                // Remove only the entry for this request from sowingInProgress
                                linkedSlotToUpdate.sowingInProgress = linkedSlotToUpdate.sowingInProgress.filter(
                                  prog => prog.sowingRequestId?.toString() !== sowingRequest._id.toString()
                                );
                                
                                console.log(`[sowingInProgress] ✅ Cleared sowingInProgress for linked slot ${linkedSlotIdStr} (now has ${linkedSlotToUpdate.sowingInProgress.length} entries)`);
                              } else {
                                console.log(`[sowingInProgress] ⚠️ No matching progress entry found for request ${sowingRequest.requestNumber} in slot ${linkedSlotIdStr}`);
                              }
                              
                              // Save the linked slot document
                              linkedSlotDoc.markModified('subtypeSlots');
                              await linkedSlotDoc.save();
                              console.log(`[sowingInProgress] ✅ Saved linked slot ${linkedSlotIdStr} after clearing`);
                            } else {
                              console.log(`[sowingInProgress] ℹ️ Linked slot ${linkedSlotIdStr} has no sowingInProgress entries (already clear)`);
                            }
                          } else {
                            console.log(`[sowingInProgress] ⚠️ Could not find subtypeSlot for linked slot ${linkedSlotIdStr}`);
                          }
                        } else {
                          console.log(`[sowingInProgress] ⚠️ Could not find PlantSlot document for linked slot ${linkedSlotIdStr}`);
                        }
                      }
                      
                      console.log(`[sowingInProgress] ✅ Finished clearing all linked slots for request ${sowingRequest.requestNumber}`);
                    } else if (sowingRequest && (!sowingRequest.linkedSlotIds || sowingRequest.linkedSlotIds.length <= 1)) {
                      console.log(`[sowingInProgress] ℹ️ Request ${sowingRequest.requestNumber} has only 1 linked slot (no other slots to clear)`);
                    } else {
                      console.log(`[sowingInProgress] ℹ️ No SowingRequest found or request has no linkedSlotIds - skipping linked slot clearing`);
                    }
                  } catch (linkedSlotError) {
                    console.error(`[sowingInProgress] ❌ Error clearing linked slots:`, linkedSlotError);
                    console.error(`[sowingInProgress] ❌ Error stack:`, linkedSlotError.stack);
                    // Don't fail the whole request, just log the error
                  }
                }
              }
            }
          } catch (progressError) {
            console.error("[sowingInProgress] Error handling progress cleanup:", progressError);
            // Don't fail the whole request, just log the error
          }
        }

        results.push({
          index: i,
          success: true,
          data: savedSowing,
        });
      } catch (error) {
        console.error(`Error creating sowing at index ${i}:`, error);
        errors.push({
          index: i,
          error: error.message || "Error creating sowing record",
        });
      }
    }

    // Return results
    const successCount = results.length;
    const errorCount = errors.length;

    return res.status(successCount > 0 ? 201 : 400).json({
      message: `Created ${successCount} sowing record(s)${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
      success: successCount,
      failed: errorCount,
      results,
      errors: errorCount > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error creating multiple sowings:", error);
    return res.status(500).json({
      message: "Error creating multiple sowing records",
      error: error.message,
    });
  }
};

// Get all sowing records with filters
export const getSowings = async (req, res) => {
  try {
    const {
      plantId,
      subtypeId,
      status,
      date,
      fromDate,
      toDate,
      showPendingOnly,
      showOverdueOnly,
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (plantId) query.plantId = plantId;
    if (subtypeId) query.subtypeId = subtypeId;
    if (status) query.status = status;

    // Date filter - priority: exact date > date range
    if (date) {
      // Single date filter (exact match for sowingDate)
      query.sowingDate = date;
    } else if (fromDate && toDate) {
      // Date range filter
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
      .skip((page - 1) * limit)
      .lean();

    // Enhance sowings with slot details
    const sowingsWithSlotDetails = await Promise.all(
      sowings.map(async (sowing) => {
        const sowingObj = { ...sowing };
        
        // If slotId exists, fetch slot details
        if (sowing.slotId) {
          try {
            const slotDoc = await PlantSlot.findOne(
              { "subtypeSlots.slots._id": new mongoose.Types.ObjectId(sowing.slotId) },
              { subtypeSlots: 1, plantId: 1, year: 1 }
            ).lean();

            if (slotDoc) {
              // Find the specific slot
              for (const subtypeSlot of slotDoc.subtypeSlots || []) {
                const slot = subtypeSlot.slots?.find(
                  s => s._id.toString() === sowing.slotId.toString()
                );
                
                if (slot) {
                  sowingObj.slotDetails = {
                    _id: slot._id,
                    startDay: slot.startDay,
                    endDay: slot.endDay,
                    month: slot.month,
                    year: slotDoc.year,
                    primarySowed: slot.primarySowed || 0,
                    officeSowed: slot.officeSowed || 0,
                    totalPlants: slot.totalPlants || 0,
                    plantsSowed: slot.plantsSowed || 0,
                    sowingDate: slot.sowingDate,
                    plantReadyDate: slot.plantReadyDate,
                    status: slot.status !== false,
                  };
                  break;
                }
              }
            }
          } catch (slotError) {
            console.error(`Error fetching slot details for sowing ${sowing._id}:`, slotError);
            // Continue without slot details
          }
        }
        
        return sowingObj;
      })
    );

    const count = await Sowing.countDocuments(query);

    return res.status(200).json({
      success: true,
      data: sowingsWithSlotDetails,
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

// Get plant ready days for a specific slot
export const getSlotPlantReadyDays = async (req, res) => {
  try {
    const { slotId } = req.params;

    if (!slotId || !mongoose.Types.ObjectId.isValid(slotId)) {
      return res.status(400).json({
        success: false,
        message: "Valid slotId is required",
      });
    }

    const slotObjectId = new mongoose.Types.ObjectId(slotId);

    const slotDoc = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotObjectId },
      { subtypeSlots: 1, plantId: 1 }
    ).lean();

    if (!slotDoc) {
      return res.status(404).json({
        success: false,
        message: "Slot not found",
      });
    }

    let readyDays = null;
    let subtypeId = null;

    for (const subtypeSlot of slotDoc.subtypeSlots || []) {
      const match = (subtypeSlot.slots || []).find(
        (slot) => slot._id.toString() === slotObjectId.toString()
      );

      if (match) {
        readyDays = Number(match.plantReadyDays) || 0;
        subtypeId = subtypeSlot.subtypeId;
        break;
      }
    }

    if (readyDays === null) {
      return res.status(404).json({
        success: false,
        message: "Slot details not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        plantId: slotDoc.plantId,
        subtypeId,
        slotId: slotObjectId,
        plantReadyDays: readyDays,
      },
    });
  } catch (error) {
    console.error("Error fetching slot plant ready days:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching slot plant ready days",
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

    // Get user ID from request (from auth middleware) or from body
    const userId = req.user?._id || performedBy;
    if (!userId) {
      return res.status(401).json({ 
        message: "User authentication required" 
      });
    }

    const sowing = await Sowing.findById(id);
    if (!sowing) {
      return res.status(404).json({ message: "Sowing record not found" });
    }

    // Store previous value for tracking
    const previousPrimarySowed = sowing.primarySowed || 0;
    const newPrimarySowed = previousPrimarySowed + quantity;

    // Update primary sowed
    sowing.primarySowed = newPrimarySowed;
    sowing.updatedBy = userId;

    // Add to history with user tracking
    sowing.sowingHistory.push({
      date: date || moment().format("DD-MM-YYYY"),
      location: "PRIMARY",
      quantity,
      performedBy: userId,
      notes: notes || `Primary sowing entry: ${quantity} plants`,
    });

    await sowing.save();

    // Update slot's primarySowed field if slotId exists
    if (sowing.slotId) {
      try {
        const slotObjectId = new mongoose.Types.ObjectId(sowing.slotId);
        const plantSlot = await PlantSlot.findOne({
          "subtypeSlots.slots._id": slotObjectId,
        });

        if (plantSlot) {
          // Find the specific slot
          for (const subtypeSlot of plantSlot.subtypeSlots || []) {
            const matchedSlot = (subtypeSlot.slots || []).find(
              (slot) => slot._id.toString() === slotObjectId.toString()
            );

            if (matchedSlot) {
              const previousSlotPrimarySowed = matchedSlot.primarySowed || 0;
              matchedSlot.primarySowed = (matchedSlot.primarySowed || 0) + quantity;

              // Update plantsSowed (which is only primarySowed)
              matchedSlot.plantsSowed = matchedSlot.primarySowed || 0;

              // Track this change in slot trail
              if (!matchedSlot.slotTrail) {
                matchedSlot.slotTrail = [];
              }

              // Add trail entry for primary sowing
              matchedSlot.slotTrail.unshift({
                action: "UPDATE",
                quantity: quantity,
                previousTotalPlants: matchedSlot.totalPlants || 0,
                newTotalPlants: matchedSlot.totalPlants || 0,
                previousAvailablePlants: matchedSlot.availablePlants || 0,
                newAvailablePlants: matchedSlot.availablePlants || 0,
                reason: "Primary sowing entry",
                performedBy: userId,
                notes: `Primary sowing: ${quantity} plants added. Previous: ${previousSlotPrimarySowed}, New: ${matchedSlot.primarySowed}`,
              });

              // Limit trail to last 100 entries
              if (matchedSlot.slotTrail.length > 100) {
                matchedSlot.slotTrail = matchedSlot.slotTrail.slice(0, 100);
              }

              await plantSlot.save();
              console.log(`✅ Updated slot ${sowing.slotId}: primarySowed += ${quantity} (tracked in trail)`);
              break;
            }
          }
        }
      } catch (slotError) {
        console.error("Error updating slot primarySowed:", slotError);
        // Don't fail the request if slot update fails
      }
    }

    // Populate user info in response
    const populatedSowing = await Sowing.findById(sowing._id)
      .populate("updatedBy", "name phoneNumber")
      .populate("sowingHistory.performedBy", "name phoneNumber");

    return res.status(200).json({
      message: "Primary sowing updated successfully",
      data: populatedSowing,
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
          $addFields: {
            slotId: "$subtypeSlots.slots._id"
          }
        },
        // Dynamically calculate totalBookedPlants from actual orders
        {
          $lookup: {
            from: "orders",
            let: { slotId: "$slotId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$bookingSlot", "$$slotId"] },
                      { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                      { $ne: ["$sowingDone", true] },
                      {
                        $or: [
                          { $ne: ["$quotaSource", "dealer"] },
                          { $not: { $ifNull: ["$quotaSource", false] } }
                        ]
                      }
                    ]
                  }
                }
              },
              {
                $group: {
                  _id: null,
                  totalBookedPlants: {
                    $sum: {
                      $add: [
                        { $ifNull: ["$numberOfPlants", 0] },
                        { $ifNull: ["$additionalPlants", 0] },
                      ],
                    },
                  },
                }
              }
            ],
            as: "orderStats"
          }
        },
        {
          $addFields: {
            dynamicTotalBookedPlants: {
              $ifNull: [
                { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
                0
              ]
            }
          }
        },
        {
          $match: {
            dynamicTotalBookedPlants: { $gt: 0 },
            $expr: {
              $gt: [
                {
                  $subtract: [
                    "$dynamicTotalBookedPlants",
                    { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] }
                  ]
                },
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
                "$dynamicTotalBookedPlants",
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
            totalBookedPlants: "$dynamicTotalBookedPlants",
            primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
            officeSowed: { $ifNull: ["$subtypeSlots.slots.officeSowed", 0] },
            reminderType: "SLOT"
          }
        },
        {
          $project: {
            orderStats: 0 // Remove intermediate orderStats field
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

export const getSowingAlerts = async (req, res) => {
  try {
    const lookaheadParam = req.query.lookahead;
    const pastWindowParam = req.query.pastWindow;

    const lookaheadDays =
      lookaheadParam !== undefined
        ? Math.min(Math.max(parseInt(lookaheadParam, 10) || 0, 0), 365)
        : null;
    const pastWindowDays =
      pastWindowParam !== undefined
        ? Math.min(Math.max(parseInt(pastWindowParam, 10) || 0, 0), 365)
        : null;

    const now = moment().startOf("day");
    const nowDate = now.toDate();
    const pastBoundary =
      pastWindowDays !== null ? now.clone().subtract(pastWindowDays, "days").toDate() : null;
    const futureBoundary =
      lookaheadDays !== null ? now.clone().add(lookaheadDays, "days").endOf("day").toDate() : null;

    const slotPipeline = [
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$subtypeSlots.slots._id" },
          pipeline: [
            {
              $match: {
                orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
              },
            },
            {
              $match: {
                $expr: {
                  $eq: ["$bookingSlot", "$$slotId"],
                },
              },
            },
            {
              $project: {
                numberOfPlants: 1,
              },
            },
          ],
          as: "slotOrders",
        },
      },
      {
        $addFields: {
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          officeSowed: { $ifNull: ["$subtypeSlots.slots.officeSowed", 0] },
          slotReadyDays: {
            $cond: [
              { $gt: ["$subtypeSlots.slots.plantReadyDays", 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
      {
        $addFields: {
          // Dynamically calculate totalBookedPlants from orders - filter out dealer quota and cancelled/rejected
          ordersBooked: {
            $reduce: {
              input: {
                $filter: {
                  input: "$slotOrders",
                  as: "order",
                  cond: {
                    $and: [
                      { $ne: ["$$order.quotaSource", "dealer"] },
                      {
                        $or: [
                          { $eq: [{ $type: "$$order.quotaSource" }, "missing"] },
                          { $not: { $ifNull: ["$$order.quotaSource", false] } }
                        ]
                      }
                    ]
                  }
                }
              },
              initialValue: 0,
              in: { $add: ["$$value", { $ifNull: ["$$this.numberOfPlants", 0] }] },
            },
          },
          // Use only dynamic ordersBooked (no fallback to stored value)
          effectiveBooked: { $ifNull: ["$ordersBooked", 0] },
          pendingQuantity: {
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: ["$ordersBooked", 0] },
                  { $ifNull: ["$primarySowed", 0] },
                ],
              },
            ],
          },
        },
      },
      {
        $match: {
          pendingQuantity: { $gt: 0 },
        },
      },
      {
        $addFields: {
          slotEndISO: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                ],
              },
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $addFields: {
          sowByDateISO: {
            $cond: [
              { $gt: ["$slotReadyDays", 0] },
              {
                $dateSubtract: {
                  startDate: "$slotEndISO",
                  unit: "day",
                  amount: "$slotReadyDays",
                },
              },
              "$slotEndISO",
            ],
          },
        },
      },
      {
        $addFields: {
          daysUntilSow: {
            $divide: [
              { $subtract: ["$sowByDateISO", nowDate] },
              1000 * 60 * 60 * 24,
            ],
          },
        },
      },
      {
        $addFields: {
          daysUntilSow: { $round: ["$daysUntilSow", 0] },
          priority: {
            $cond: [
              { $lt: ["$daysUntilSow", 0] },
              "overdue",
              {
                $cond: [
                  { $lte: ["$daysUntilSow", 2] },
                  "urgent",
                  "upcoming",
                ],
              },
            ],
          },
        },
      },
      {
        $project: {
          _id: "$subtypeSlots.slots._id",
          plantId: "$plantId",
          plantName: { $ifNull: ["$plantInfo.name", "Unknown"] },
          subtypeId: "$subtypeSlots.subtypeId",
          subtypeName: { $ifNull: ["$subtypeDetails.name", "Subtype"] },
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          year: "$year",
          totalBookedPlants: { $ifNull: ["$effectiveBooked", 0] },
          primarySowed: { $ifNull: ["$primarySowed", 0] },
          officeSowed: { $ifNull: ["$officeSowed", 0] },
          pendingQuantity: { $ifNull: ["$pendingQuantity", 0] },
          slotReadyDays: "$slotReadyDays",
          daysUntilSow: 1,
          priority: 1,
          sowByDate: {
            $dateToString: {
              date: "$sowByDateISO",
              format: "%d-%m-%Y",
            },
          },
          sowByDateISO: "$sowByDateISO",
        },
      },
      { $sort: { daysUntilSow: 1, pendingQuantity: -1 } },
    ];

    if (pastBoundary !== null || futureBoundary !== null) {
      const rangeMatch = {};
      if (pastBoundary !== null) {
        rangeMatch.$gte = pastBoundary;
      }
      if (futureBoundary !== null) {
        rangeMatch.$lte = futureBoundary;
      }
      slotPipeline.splice(
        slotPipeline.findIndex((stage) => stage.$addFields?.daysUntilSow !== undefined),
        0,
        {
          $match: {
            sowByDateISO: rangeMatch,
          },
        }
      );
    }

    const slotAlertsRaw = await PlantSlot.aggregate(slotPipeline).allowDiskUse(true);

    if (process.env.NODE_ENV !== "production") {
      console.log(
        "[sowing-alerts] total slots",
        slotAlertsRaw.length,
        "sample",
        slotAlertsRaw.slice(0, 2)
      );
    }
    if (process.env.NODE_ENV !== "production") {
      const totalSlots = await PlantSlot.aggregate([
        { $unwind: "$subtypeSlots" },
        { $unwind: "$subtypeSlots.slots" },
        { $count: "count" }
      ]);
      console.log(
        "alerts db",
        PlantSlot.db.name,
        "total slots",
        totalSlots[0]?.count || 0,
        "pending slots",
        slotAlertsRaw.length
      );
      console.log("alerts: sample slots", slotAlertsRaw.slice(0, 3));
    }

    const priorityWeight = {
      overdue: 2,
      urgent: 1,
      upcoming: 0,
    };

    const resolvePriority = (current, candidate) => {
      if (!current) return candidate;
      if (!candidate) return current;
      return priorityWeight[candidate] > priorityWeight[current] ? candidate : current;
    };

    const slotAlerts = slotAlertsRaw
      .map((alert) => ({
        slotId: alert._id,
        plantId: alert.plantId,
        plantName: alert.plantName,
        subtypeId: alert.subtypeId,
        subtypeName: alert.subtypeName,
        slotStartDay: alert.slotStartDay,
        slotEndDay: alert.slotEndDay,
        month: alert.month,
        year: alert.year,
        pendingQuantity: alert.pendingQuantity,
        totalBookedPlants: alert.totalBookedPlants,
        primarySowed: alert.primarySowed,
        officeSowed: alert.officeSowed,
        slotReadyDays: alert.slotReadyDays,
        daysUntilSow: alert.daysUntilSow,
        priority: alert.priority,
        sowByDate: alert.sowByDate,
        sowByDateISO: alert.sowByDateISO,
      }))
      .filter((alert) => alert.pendingQuantity > 0);

    const dayMap = new Map();
    const plantMap = new Map();
    const impactedPlants = new Set();

    slotAlerts.forEach((alert) => {
      impactedPlants.add(`${alert.plantId}_${alert.subtypeId}`);
      const dayKey = `${alert.plantId}_${alert.subtypeId}_${alert.sowByDate}`;
      const dayExisting = dayMap.get(dayKey);
      if (!dayExisting) {
        dayMap.set(dayKey, {
          id: dayKey,
          plantId: alert.plantId,
          plantName: alert.plantName,
          subtypeId: alert.subtypeId,
          subtypeName: alert.subtypeName,
          sowByDate: alert.sowByDate,
          sowByDateISO: alert.sowByDateISO,
          daysUntilSow: alert.daysUntilSow,
          totalPending: alert.pendingQuantity,
          slotCount: 1,
          priority: alert.priority,
          slotIds: [alert.slotId],
        });
      } else {
        dayExisting.totalPending += alert.pendingQuantity;
        dayExisting.slotCount += 1;
        dayExisting.daysUntilSow = Math.min(dayExisting.daysUntilSow, alert.daysUntilSow);
        dayExisting.priority = resolvePriority(dayExisting.priority, alert.priority);
        dayExisting.slotIds.push(alert.slotId);
      }

      const plantKey = alert.plantId.toString();
      let plantEntry = plantMap.get(plantKey);
      if (!plantEntry) {
        plantEntry = {
          plantId: alert.plantId,
          plantName: alert.plantName,
          totalPending: 0,
          slotCount: 0,
          overdueSlots: 0,
          urgentSlots: 0,
          upcomingSlots: 0,
          subtypes: new Map(),
        };
        plantMap.set(plantKey, plantEntry);
      }

      plantEntry.totalPending += alert.pendingQuantity;
      plantEntry.slotCount += 1;
      if (alert.daysUntilSow < 0) {
        plantEntry.overdueSlots += 1;
      } else if (alert.daysUntilSow <= 2) {
        plantEntry.urgentSlots += 1;
      } else {
        plantEntry.upcomingSlots += 1;
      }

      const subtypeKey = alert.subtypeId.toString();
      let subtypeEntry = plantEntry.subtypes.get(subtypeKey);
      if (!subtypeEntry) {
        subtypeEntry = {
          subtypeId: alert.subtypeId,
          subtypeName: alert.subtypeName,
          totalPending: 0,
          slotCount: 0,
          overdueSlots: 0,
          urgentSlots: 0,
          upcomingSlots: 0,
          earliestSowByDate: alert.sowByDate,
          earliestDaysUntilSow: alert.daysUntilSow,
          latestSowByDate: alert.sowByDate,
          slotAlerts: [],
        };
        plantEntry.subtypes.set(subtypeKey, subtypeEntry);
      }

      subtypeEntry.totalPending += alert.pendingQuantity;
      subtypeEntry.slotCount += 1;
      if (alert.daysUntilSow < 0) {
        subtypeEntry.overdueSlots += 1;
      } else if (alert.daysUntilSow <= 2) {
        subtypeEntry.urgentSlots += 1;
      } else {
        subtypeEntry.upcomingSlots += 1;
      }

      if (alert.daysUntilSow < subtypeEntry.earliestDaysUntilSow) {
        subtypeEntry.earliestDaysUntilSow = alert.daysUntilSow;
        subtypeEntry.earliestSowByDate = alert.sowByDate;
      }

      subtypeEntry.latestSowByDate =
        moment(alert.sowByDate, "DD-MM-YYYY").isAfter(moment(subtypeEntry.latestSowByDate, "DD-MM-YYYY"))
          ? alert.sowByDate
          : subtypeEntry.latestSowByDate;

      if (subtypeEntry.slotAlerts.length < 3) {
        subtypeEntry.slotAlerts.push(alert);
      } else {
        const minIndex = subtypeEntry.slotAlerts.reduce(
          (idx, current, currentIdx, arr) =>
            arr[idx].pendingQuantity <= current.pendingQuantity ? idx : currentIdx,
          0
        );
        if (alert.pendingQuantity > subtypeEntry.slotAlerts[minIndex].pendingQuantity) {
          subtypeEntry.slotAlerts[minIndex] = alert;
        }
      }
    });

    const dayAlerts = Array.from(dayMap.values()).sort(
      (a, b) => a.daysUntilSow - b.daysUntilSow || b.totalPending - a.totalPending
    );

    const plantAlerts = Array.from(plantMap.values()).map((plant) => {
      const subtypes = Array.from(plant.subtypes.values())
        .map((subtype) => ({
          subtypeId: subtype.subtypeId,
          subtypeName: subtype.subtypeName,
          totalPending: subtype.totalPending,
          slotCount: subtype.slotCount,
          overdueSlots: subtype.overdueSlots,
          urgentSlots: subtype.urgentSlots,
          upcomingSlots: subtype.upcomingSlots,
          earliestSowByDate: subtype.earliestSowByDate,
          latestSowByDate: subtype.latestSowByDate,
          sampleSlots: subtype.slotAlerts
            .sort((a, b) => a.daysUntilSow - b.daysUntilSow || b.pendingQuantity - a.pendingQuantity)
            .map((slotAlert) => ({
              slotId: slotAlert.slotId,
              pendingQuantity: slotAlert.pendingQuantity,
              sowByDate: slotAlert.sowByDate,
              daysUntilSow: slotAlert.daysUntilSow,
              priority: slotAlert.priority,
              slotStartDay: slotAlert.slotStartDay,
              slotEndDay: slotAlert.slotEndDay,
            })),
        }))
        .sort((a, b) => b.totalPending - a.totalPending);

      return {
        plantId: plant.plantId,
        plantName: plant.plantName,
        totalPending: plant.totalPending,
        slotCount: plant.slotCount,
        overdueSlots: plant.overdueSlots,
        urgentSlots: plant.urgentSlots,
        upcomingSlots: plant.upcomingSlots,
        subtypeCount: subtypes.length,
        subtypes,
      };
    });

    plantAlerts.sort((a, b) => b.totalPending - a.totalPending);

    const debugInfo =
      req.query.debug === "true"
        ? {
            slotSample: slotAlerts.slice(0, 5),
            rawCount: slotAlertsRaw.length,
          }
        : undefined;

    const totalPending = slotAlerts.reduce((sum, item) => sum + item.pendingQuantity, 0);
    const rawTotalPending = slotAlertsRaw.reduce(
      (sum, item) => sum + Number(item.pendingQuantity || 0),
      0
    );
    const overdueSlots = slotAlerts.filter((item) => item.daysUntilSow < 0).length;
    const urgentSlots = slotAlerts.filter(
      (item) => item.daysUntilSow >= 0 && item.daysUntilSow <= 2
    ).length;
    const upcomingSlots = slotAlerts.length - overdueSlots - urgentSlots;

    const summary = {
      totalPending,
      totalSlots: slotAlerts.length,
      overdueSlots,
      urgentSlots,
      upcomingSlots,
      plantsImpacted: impactedPlants.size,
      lookaheadDays,
      pastWindowDays,
      rawSlotCount: slotAlertsRaw.length,
      rawTotalPending,
    };

    res.status(200).json({
      success: true,
      data: {
        summary,
        slotAlerts,
        dayAlerts,
        plantAlerts,
        debug: debugInfo,
      },
    });
  } catch (error) {
    console.error("Error fetching sowing alerts:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching sowing alerts",
      error: error.message,
    });
  }
};

export const getSowingAlertsByStart = async (req, res) => {
  try {
    const now = moment().startOf("day");

    const slotPipeline = [
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$subtypeSlots.slots._id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $nin: ["$orderStatus", ["CANCELLED", "REJECTED"]] },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              },
            },
            {
              $project: {
                numberOfPlants: 1,
                quotaSource: 1,
              },
            },
          ],
          as: "slotOrders",
        },
      },
      {
        $addFields: {
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          officeSowed: { $ifNull: ["$subtypeSlots.slots.officeSowed", 0] },
          slotReadyDays: {
            $cond: [
              { $gt: ["$subtypeSlots.slots.plantReadyDays", 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
      {
        $addFields: {
          // Dynamically calculate from orders - filter out dealer quota and cancelled/rejected
          ordersBooked: {
            $reduce: {
              input: {
                $filter: {
                  input: "$slotOrders",
                  as: "order",
                  cond: {
                    $and: [
                      { $ne: ["$$order.quotaSource", "dealer"] },
                      {
                        $or: [
                          { $eq: [{ $type: "$$order.quotaSource" }, "missing"] },
                          { $not: { $ifNull: ["$$order.quotaSource", false] } }
                        ]
                      }
                    ]
                  }
                }
              },
              initialValue: 0,
              in: { $add: ["$$value", { $ifNull: ["$$this.numberOfPlants", 0] }] },
            },
          },
          // Use only dynamic ordersBooked (no fallback to stored value)
          effectiveBooked: { $ifNull: ["$ordersBooked", 0] },
        },
      },
      {
        $addFields: {
          pendingQuantity: {
            $max: [
              0,
              {
                $subtract: ["$effectiveBooked", { $ifNull: ["$primarySowed", 0] }],
              },
            ],
          },
        },
      },
      {
        $match: {
          pendingQuantity: { $gt: 0 },
        },
      },
      {
        $addFields: {
          slotStartISO: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$subtypeSlots.slots.startDay", 6, 4] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.startDay", 3, 2] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.startDay", 0, 2] },
                ],
              },
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $addFields: {
          sowByDateISO: {
            $cond: [
              { $gt: ["$slotReadyDays", 0] },
              {
                $dateSubtract: {
                  startDate: "$slotStartISO",
                  unit: "day",
                  amount: "$slotReadyDays",
                },
              },
              "$slotStartISO",
            ],
          },
        },
      },
      {
        $addFields: {
          daysUntilSow: {
            $divide: [
              { $subtract: ["$sowByDateISO", now.toDate()] },
              1000 * 60 * 60 * 24,
            ],
          },
        },
      },
      {
        $addFields: {
          daysUntilSow: { $round: ["$daysUntilSow", 0] },
          priority: {
            $cond: [
              { $lt: ["$daysUntilSow", 0] },
              "overdue",
              {
                $cond: [
                  { $lte: ["$daysUntilSow", 2] },
                  "urgent",
                  "upcoming",
                ],
              },
            ],
          },
        },
      },
      {
        $project: {
          _id: "$subtypeSlots.slots._id",
          plantId: "$plantId",
          plantName: { $ifNull: ["$plantInfo.name", "Unknown"] },
          subtypeId: "$subtypeSlots.subtypeId",
          subtypeName: { $ifNull: ["$subtypeDetails.name", "Subtype"] },
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          year: "$year",
          totalBookedPlants: "$effectiveBooked",
          primarySowed: "$primarySowed",
          officeSowed: "$officeSowed",
          pendingQuantity: 1,
          slotReadyDays: "$slotReadyDays",
          daysUntilSow: 1,
          priority: 1,
          sowByDate: {
            $dateToString: {
              date: "$sowByDateISO",
              format: "%d-%m-%Y",
            },
          },
          sowByDateISO: "$sowByDateISO",
        },
      },
      { $sort: { daysUntilSow: 1, pendingQuantity: -1 } },
    ];

    const slotAlertsRaw = await PlantSlot.aggregate(slotPipeline).allowDiskUse(true);

    const dayAggregates = {};
    const plantAggregates = {};

    slotAlertsRaw.forEach((slot) => {
      const dayKey = `${slot.plantId}_${slot.subtypeId}_${slot.sowByDate}`;
      if (!dayAggregates[dayKey]) {
        dayAggregates[dayKey] = {
          plantId: slot.plantId,
          plantName: slot.plantName,
          subtypeId: slot.subtypeId,
          subtypeName: slot.subtypeName,
          sowByDate: slot.sowByDate,
          sowByDateISO: slot.sowByDateISO,
          totalPending: 0,
          slotIds: [],
          slotCount: 0,
          priority: slot.priority,
          daysUntilSow: slot.daysUntilSow,
        };
      }
      const day = dayAggregates[dayKey];
      day.totalPending += slot.pendingQuantity;
      day.slotCount += 1;
      day.slotIds.push(slot._id);
      day.priority =
        slot.priority === "overdue"
          ? "overdue"
          : slot.priority === "urgent" && day.priority === "upcoming"
          ? "urgent"
          : day.priority;
      day.daysUntilSow = Math.min(day.daysUntilSow, slot.daysUntilSow);

      const plantKey = `${slot.plantId}_${slot.subtypeId}`;
      if (!plantAggregates[plantKey]) {
        plantAggregates[plantKey] = {
          plantId: slot.plantId,
          plantName: slot.plantName,
          subtypeId: slot.subtypeId,
          subtypeName: slot.subtypeName,
          totalPending: 0,
          slotCount: 0,
          overdueSlots: 0,
          urgentSlots: 0,
          upcomingSlots: 0,
          sampleSlots: [],
        };
      }
      const aggregate = plantAggregates[plantKey];
      aggregate.totalPending += slot.pendingQuantity;
      aggregate.slotCount += 1;
      if (slot.priority === "overdue") aggregate.overdueSlots += 1;
      else if (slot.priority === "urgent") aggregate.urgentSlots += 1;
      else aggregate.upcomingSlots += 1;
      if (aggregate.sampleSlots.length < 5) {
        aggregate.sampleSlots.push(slot);
      }
    });

    const dayAlerts = Object.values(dayAggregates).sort(
      (a, b) => a.daysUntilSow - b.daysUntilSow || b.totalPending - a.totalPending
    );

    const plantAlerts = Object.values(plantAggregates).sort((a, b) => b.totalPending - a.totalPending);

    const totalPending = slotAlertsRaw.reduce((sum, slot) => sum + slot.pendingQuantity, 0);
    const overdueSlots = slotAlertsRaw.filter((slot) => slot.daysUntilSow < 0).length;
    const urgentSlots = slotAlertsRaw.filter(
      (slot) => slot.daysUntilSow >= 0 && slot.daysUntilSow <= 2
    ).length;
    const upcomingSlots = slotAlertsRaw.length - overdueSlots - urgentSlots;
    const plantsImpacted = new Set(
      slotAlertsRaw.map((slot) => `${slot.plantId.toString()}_${slot.subtypeId.toString()}`)
    ).size;

    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalPending,
          totalSlots: slotAlertsRaw.length,
          overdueSlots,
          urgentSlots,
          upcomingSlots,
          plantsImpacted,
        },
        slotAlerts: slotAlertsRaw,
        dayAlerts,
        plantAlerts,
      },
    });
  } catch (error) {
    console.error("Error fetching sowing alerts by start:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching sowing alerts",
      error: error.message,
    });
  }
};

export const getTodaySowingSummary = async (req, res) => {
  try {
    const now = moment().startOf("day");

    const ordersSummary = await Order.aggregate([
      {
        $match: {
          orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
        },
      },
      {
        $group: {
          _id: "$bookingSlot",
          totalPlants: { $sum: { $ifNull: ["$numberOfPlants", 0] } },
        },
      },
    ]);

    const ordersMap = new Map(
      ordersSummary.map((entry) => [entry._id?.toString(), entry.totalPlants || 0])
    );

    const slotData = await PlantSlot.aggregate([
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $project: {
          _id: "$subtypeSlots.slots._id",
          plantId: "$plantId",
          plantName: { $ifNull: ["$plantInfo.name", "Unknown"] },
          subtypeId: "$subtypeSlots.subtypeId",
          subtypeName: { $ifNull: ["$subtypeDetails.name", "Subtype"] },
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          year: "$year",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          storedBooked: { $ifNull: ["$subtypeSlots.slots.totalBookedPlants", 0] },
          slotReadyDays: {
            $cond: [
              { $gt: ["$subtypeSlots.slots.plantReadyDays", 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
    ]).allowDiskUse(true);

    const plantSubtypeMap = new Map();

    slotData.forEach((slot) => {
      const slotId = slot._id?.toString();
      const ordersBooked = ordersMap.get(slotId) || 0;
      const effectiveBooked = Math.max(ordersBooked, slot.storedBooked || 0);
      const pending = Math.max(0, effectiveBooked - (slot.primarySowed || 0));

      if (pending <= 0) {
        return;
      }

      const startMoment = moment(slot.slotStartDay, "DD-MM-YYYY");
      const sowByMoment =
        slot.slotReadyDays && slot.slotReadyDays > 0
          ? startMoment.clone().subtract(slot.slotReadyDays, "days")
          : startMoment.clone();

      if (sowByMoment.isAfter(now)) {
        return;
      }

      const daysUntilSow = sowByMoment.diff(now, "days");
      const priority = daysUntilSow < 0 ? "overdue" : "due today";

      const key = `${slot.plantId}_${slot.subtypeId}`;
      if (!plantSubtypeMap.has(key)) {
        plantSubtypeMap.set(key, {
          plantId: slot.plantId,
          plantName: slot.plantName,
          subtypeId: slot.subtypeId,
          subtypeName: slot.subtypeName,
          pendingQuantity: 0,
          slotCount: 0,
          slots: [],
        });
      }

      const entry = plantSubtypeMap.get(key);
      entry.pendingQuantity += pending;
      entry.slotCount += 1;
      entry.slots.push({
        slotId,
        slotStartDay: slot.slotStartDay,
        slotEndDay: slot.slotEndDay,
        month: slot.month,
        year: slot.year,
        pendingQuantity: pending,
        sowByDate: sowByMoment.format("DD-MM-YYYY"),
        daysUntilSow,
        priority,
      });
    });

    const plantSubtypes = Array.from(plantSubtypeMap.values()).sort(
      (a, b) => b.pendingQuantity - a.pendingQuantity
    );
    const totalPending = plantSubtypes.reduce((sum, entry) => sum + entry.pendingQuantity, 0);

    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalPendingToday: totalPending,
          plantSubtypeCount: plantSubtypes.length,
        },
        plantSubtypes,
      },
    });
  } catch (error) {
    console.error("Error fetching today sowing summary:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching sowing summary",
      error: error.message,
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

// Delete all sowing records
export const deleteAllSowings = async (req, res) => {
  try {
    // Get count before deletion
    const count = await Sowing.countDocuments();
    
    if (count === 0) {
      return res.status(200).json({
        message: "No sowing records found to delete",
        deletedCount: 0,
      });
    }

    // Delete all sowing records
    const result = await Sowing.deleteMany({});

    console.log(`Deleted ${result.deletedCount} sowing records`);

    return res.status(200).json({
      message: `Successfully deleted ${result.deletedCount} sowing record${result.deletedCount !== 1 ? 's' : ''}`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting all sowings:", error);
    return res.status(500).json({
      message: "Error deleting sowing records",
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


// NEW API: Get Plant Reminders (Plant selection mandatory, subtype-wise booking gap analysis)
export const getPlantReminders = async (req, res) => {
  try {
    const { 
      plantId,
      subtypeId, // Filter by subtype
      priority, // Filter by priority: overdue, urgent, upcoming (future is excluded)
      current, // Show only current priorities (urgent + upcoming), excludes future and overdue
      startDate, // Date range start (DD-MM-YYYY)
      endDate, // Date range end (DD-MM-YYYY)
      showAvailable, // Show slots with available capacity
      showGap, // Show slots with booking gap
      gapFilter, // Filter by gap: "positive" (gap > 0), "negative" (gap < 0), "zero" (gap === 0), or "all" (default: "all")
    } = req.query;

    if (!plantId) {
      return res.status(400).json({
        success: false,
        message: "Plant ID is required. Please select a plant.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(plantId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Plant ID format",
      });
    }

    const today = moment().startOf("day");
    let dateFilter = {};
    
    // Date range filter
    if (startDate && endDate) {
      const start = moment(startDate, "DD-MM-YYYY").startOf("day").toDate();
      const end = moment(endDate, "DD-MM-YYYY").endOf("day").toDate();
      dateFilter = {
        sowByDateISO: {
          $gte: start,
          $lte: end,
        },
      };
    }

    // Build match conditions for filtering (after projection - use projected field names)
    const buildMatchConditions = () => {
      const conditions = {};
      
      // subtypeId is filtered earlier in pipeline, don't include here
      
      // Priority filtering: exclude "future" by default, only show overdue, urgent, upcoming
      // EXCEPTION: If gapFilter is set (positive, negative, zero, all), include ALL priorities including future
      if (gapFilter) {
        // When gapFilter is set, show ALL priorities (future, overdue, urgent, upcoming)
        // Don't filter by priority - include everything
        // Skip priority filtering entirely
      } else if (current === "true") {
        // Show only current priorities (urgent + upcoming)
        conditions.priority = { $in: ["urgent", "upcoming"] };
      } else if (priority) {
        // Specific priority filter (but still exclude future if somehow passed)
        if (priority !== "future") {
          conditions.priority = priority;
        } else {
          // If future is explicitly requested, return empty (we don't show future)
          conditions.priority = "nonexistent"; // This will return no results
        }
      } else {
        // Default: exclude future, show only overdue, urgent, upcoming
        conditions.priority = { $in: ["overdue", "urgent", "upcoming"] };
      }
      
      if (showAvailable === "true") {
        conditions.availablePlants = { $gt: 0 };
      }
      
      // Filter by gap type: positive, negative, zero, or all
      // Note: gapFilter takes precedence over showGap
      if (gapFilter) {
        if (gapFilter === "positive") {
          conditions.bookingGap = { $gt: 0 };
        } else if (gapFilter === "negative") {
          conditions.bookingGap = { $lt: 0 };
        } else if (gapFilter === "zero") {
          conditions.bookingGap = { $eq: 0 };
        }
        // If gapFilter is "all" or any other value, show all (no filter)
      } else if (showGap === "true") {
        // Fallback to showGap if gapFilter is not provided
        conditions.bookingGap = { $gt: 0 };
      }
      
      if (Object.keys(dateFilter).length > 0) {
        Object.assign(conditions, dateFilter);
      }
      
      // Only apply default filter if no specific filters are set
      if (!showAvailable && !showGap && !gapFilter && (!priority && !current && !subtypeId && Object.keys(dateFilter).length === 0)) {
        conditions.$or = [
          { bookingGap: { $gt: 0 } }, // Has booking gap
          { availablePlants: { $gt: 0 } }, // Has available capacity
        ];
      }
      
      // If gapFilter is set, remove the default $or condition to avoid conflicts
      if (gapFilter && conditions.$or) {
        delete conditions.$or;
      }
      
      return conditions;
    };

    const finalMatchConditions = buildMatchConditions();

    // Get all slots for this plant with booking gaps
    const reminders = await PlantSlot.aggregate([
      {
        $match: {
          plantId: new mongoose.Types.ObjectId(plantId),
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      // Filter by subtypeId early in pipeline if provided (before unwinding slots)
      ...(subtypeId && mongoose.Types.ObjectId.isValid(subtypeId)
        ? [
            {
              $match: {
                "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
              },
            },
          ]
        : []),
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $addFields: {
          // Convert subtypeId to string for comparison
          subtypeIdStr: { $toString: "$subtypeSlots.subtypeId" },
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $let: {
              vars: {
                matchedSubtype: {
                  $arrayElemAt: [
                    {
                      $filter: {
                        input: { $ifNull: ["$plantInfo.subtypes", []] },
                        as: "subtype",
                        cond: {
                          $eq: [
                            { $toString: "$$subtype._id" },
                            "$subtypeIdStr"
                          ]
                        },
                      },
                    },
                    0,
                  ],
                },
              },
              in: "$$matchedSubtype",
            },
          },
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
        },
      },
      {
        $addFields: {
          slotReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
          // Get slotBuffer from subtype (buffer field in PlantCMS subtype)
          slotBuffer: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.buffer", 0] }, 0] },
              "$subtypeSlots.slots.buffer",
              { $ifNull: ["$subtypeDetails.buffer", 0] },
            ],
          },
        },
      },
      // Dynamically calculate totalBookedPlants from unsown orders only
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$slotId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                    { $ne: ["$sowingDone", true] },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBookedPlants: {
                  $sum: {
                    $add: [
                      { $ifNull: ["$numberOfPlants", 0] },
                      { $ifNull: ["$additionalPlants", 0] },
                    ],
                  },
                },
              }
            }
          ],
          as: "orderStats"
        }
      },
      {
        $addFields: {
          totalBookedPlants: {
            $ifNull: [
              { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
              0
            ]
          }
        }
      },
      {
        $project: {
          orderStats: 0 // Remove the intermediate orderStats field
        }
      },
      {
        $addFields: {
          // Calculate raw bookingGap first
          bookingGapRaw: {
            $subtract: [
              "$totalBookedPlants",
              "$primarySowed",
            ],
          },
        },
      },
      {
        $addFields: {
          // Apply slot-level buffer to positive gaps: gapWithBuffer = gap * (1 + slotBuffer/100)
          bookingGap: {
            $cond: [
              {
                $and: [
                  { $gt: ["$bookingGapRaw", 0] }, // Only apply to positive gaps
                  { $gt: ["$slotBuffer", 0] }, // Only if slot buffer > 0
                ],
              },
              {
                $round: [
                  {
                    $multiply: [
                      "$bookingGapRaw",
                      {
                        $add: [
                          1,
                          { $divide: ["$slotBuffer", 100] },
                        ],
                      },
                    ],
                  },
                ],
              },
              "$bookingGapRaw", // Use raw gap if buffer is 0 or gap is negative
            ],
          },
          // Calculate slot buffer count (additional plants added by buffer)
          slotBufferCount: {
            $cond: [
              {
                $and: [
                  { $gt: ["$bookingGapRaw", 0] },
                  { $gt: ["$slotBuffer", 0] },
                ],
              },
              {
                $round: [
                  {
                    $subtract: [
                      {
                        $round: [
                          {
                            $multiply: [
                              "$bookingGapRaw",
                              {
                                $add: [
                                  1,
                                  { $divide: ["$slotBuffer", 100] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      "$bookingGapRaw",
                    ],
                  },
                ],
              },
              0,
            ],
          },
          availablePlants: {
            $max: [
              0,
              {
                $subtract: [
                  "$totalPlants",
                  "$totalBookedPlants",
                ],
              },
            ],
          },
          slotEndISO: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                ],
              },
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $addFields: {
          sowByDateISO: {
            $cond: [
              { $gt: ["$slotReadyDays", 0] },
              {
                $dateSubtract: {
                  startDate: "$slotEndISO",
                  unit: "day",
                  amount: "$slotReadyDays",
                },
              },
              "$slotEndISO",
            ],
          },
        },
      },
      {
        $addFields: {
          daysUntilSow: {
            $round: [
              {
                $divide: [
                  { $subtract: ["$sowByDateISO", today.toDate()] },
                  1000 * 60 * 60 * 24,
                ],
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          priority: {
            $cond: [
              { $lt: ["$daysUntilSow", 0] },
              "overdue",
              {
                $cond: [
                  { $lte: ["$daysUntilSow", 2] },
                  "urgent",
                  {
                    $cond: [
                      { $lte: ["$daysUntilSow", 5] },
                      "upcoming",
                      "future",
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        $match: finalMatchConditions,
      },
      {
        $project: {
          _id: "$subtypeSlots.slots._id",
          slotId: "$subtypeSlots.slots._id",
          plantId: "$plantId",
          plantName: { $ifNull: ["$plantInfo.name", "Unknown"] },
          subtypeId: "$subtypeSlots.subtypeId",
          subtypeName: { $ifNull: ["$subtypeDetails.name", "Subtype"] },
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          totalBookedPlants: 1,
          primarySowed: 1,
          totalPlants: 1,
          bookingGap: 1,
          bookingGapRaw: 1, // Include raw gap for reference
          slotBuffer: 1, // Slot-level buffer percentage
          slotBufferCount: 1, // Additional plants from buffer
          availablePlants: 1,
          surplus: "$availablePlants", // Explicit surplus field (available for booking)
          sowByDate: {
            $dateToString: {
              date: "$sowByDateISO",
              format: "%d-%m-%Y",
            },
          },
          daysUntilSow: 1,
          priority: 1,
          plantReadyDays: "$slotReadyDays",
        },
      },
      {
        $sort: { daysUntilSow: 1, priority: 1 },
      },
    ]);

    // Group by subtype for summary
    const subtypeSummary = await PlantSlot.aggregate([
      {
        $match: {
          plantId: new mongoose.Types.ObjectId(plantId),
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
          totalBookedPlants: { $ifNull: ["$subtypeSlots.slots.totalBookedPlants", 0] },
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
          // Get slotBuffer from subtype (buffer field in PlantCMS subtype)
          slotBuffer: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.buffer", 0] }, 0] },
              "$subtypeSlots.slots.buffer",
              { $ifNull: ["$subtypeDetails.buffer", 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$subtypeSlots.subtypeId",
          subtypeName: { $first: { $ifNull: ["$subtypeDetails.name", "Subtype"] } },
          totalBookedPlants: { $sum: "$totalBookedPlants" },
          totalPrimarySowed: { $sum: "$primarySowed" },
          totalCapacity: { $sum: "$totalPlants" },
          slotCount: { $sum: 1 },
          slotBuffer: { $first: "$slotBuffer" }, // Get slot buffer from first record (should be same for all slots of same subtype)
        },
      },
      {
        $addFields: {
          // Calculate raw gap first
          totalBookingGapRaw: {
            $max: [
              0,
              {
                $subtract: ["$totalBookedPlants", "$totalPrimarySowed"],
              },
            ],
          },
        },
      },
      {
        $addFields: {
          // Apply slot-level buffer: gapWithBuffer = gap * (1 + slotBuffer/100)
          totalBookingGap: {
            $cond: [
              {
                $and: [
                  { $gt: ["$totalBookingGapRaw", 0] },
                  { $gt: ["$slotBuffer", 0] },
                ],
              },
              {
                $round: [
                  {
                    $multiply: [
                      "$totalBookingGapRaw",
                      {
                        $add: [
                          1,
                          { $divide: ["$slotBuffer", 100] },
                        ],
                      },
                    ],
                  },
                ],
              },
              "$totalBookingGapRaw",
            ],
          },
          // Calculate total slot buffer count for this subtype
          totalSlotBufferCount: {
            $cond: [
              {
                $and: [
                  { $gt: ["$totalBookingGapRaw", 0] },
                  { $gt: ["$slotBuffer", 0] },
                ],
              },
              {
                $round: [
                  {
                    $subtract: [
                      {
                        $round: [
                          {
                            $multiply: [
                              "$totalBookingGapRaw",
                              {
                                $add: [
                                  1,
                                  { $divide: ["$slotBuffer", 100] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      "$totalBookingGapRaw",
                    ],
                  },
                ],
              },
              0,
            ],
          },
          totalAvailable: {
            $max: [
              0,
              {
                $subtract: ["$totalCapacity", "$totalBookedPlants"],
              },
            ],
          },
          completionPercentage: {
            $cond: [
              { $gt: ["$totalBookedPlants", 0] },
              {
                $multiply: [
                  {
                    $divide: ["$totalPrimarySowed", "$totalBookedPlants"],
                  },
                  100,
                ],
              },
              0,
            ],
          },
        },
      },
      {
        $sort: { totalBookingGap: -1 },
      },
    ]);

    // Get plant info
    const plantInfo = await PlantCms.findById(plantId).select("name sowingAllowed").lean();

        // Add conversion factor and available stock to subtypeSummary
    const subtypeSummaryWithConversion = await Promise.all(
      subtypeSummary.map(async (subtype) => {
        let conversionFactor = null;
        let secondaryUnit = null;
        let primaryUnit = null;
        let availablePackets = 0;
        try {
          const product = await Product.findOne({
            plantId: new mongoose.Types.ObjectId(plantId),
            subtypeId: new mongoose.Types.ObjectId(subtype._id),
            category: { $regex: /^seeds$/i },
            isActive: true,
          })
            .select("conversionFactor secondaryUnit primaryUnit _id")
            .populate("secondaryUnit", "name symbol")
            .populate("primaryUnit", "name symbol")
            .lean();

          conversionFactor = product?.conversionFactor || null;
          secondaryUnit = product?.secondaryUnit || null;
          primaryUnit = product?.primaryUnit || null;

          // Get available stock from all active batches for this product
          if (product?._id) {
            const batches = await Batch.find({
              product: product._id,
              status: "active",
              remainingQuantity: { $gt: 0 },
            })
              .select("remainingQuantity unit")
              .populate("unit", "name symbol")
              .lean();

            let totalAvailable = 0;
            batches.forEach((batch) => {
              const batchUnitId = batch.unit?._id?.toString();
              const primaryUnitId = primaryUnit?._id?.toString();
              const secondaryUnitId = secondaryUnit?._id?.toString();

              if (batchUnitId === primaryUnitId && conversionFactor) {
                totalAvailable += batch.remainingQuantity / conversionFactor;
              } else if (batchUnitId === secondaryUnitId) {
                totalAvailable += batch.remainingQuantity;
              } else {
                if (conversionFactor) {
                  totalAvailable += batch.remainingQuantity / conversionFactor;
                } else {
                  totalAvailable += batch.remainingQuantity;
                }
              }
            });

            availablePackets = Math.floor(totalAvailable);
          }
        } catch (error) {
          console.error(`Error fetching conversion factor/stock for plant ${plantId}, subtype ${subtype._id}:`, error);
        }

        return {
          ...subtype,
          conversionFactor: conversionFactor,
          secondaryUnit: secondaryUnit,
          primaryUnit: primaryUnit,
          availablePackets: availablePackets,
        };
      })
    );

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      plantInfo: {
        plantId,
        plantName: plantInfo?.name || "Unknown",
        sowingAllowed: plantInfo?.sowingAllowed || false,
      },
      subtypeSummary: subtypeSummaryWithConversion,
      reminders,
      summary: {
        totalSlots: reminders.length,
        totalBookingGap: reminders.reduce((sum, r) => sum + (r.bookingGap || 0), 0),
        totalSlotBufferCount: reminders.reduce((sum, r) => sum + (r.slotBufferCount || 0), 0),
        totalAvailable: reminders.reduce((sum, r) => sum + (r.availablePlants || 0), 0),
        totalSurplus: reminders.reduce((sum, r) => sum + (r.surplus || r.availablePlants || 0), 0), // Total surplus (available for booking)
        totalBooked: reminders.reduce((sum, r) => sum + (r.totalBookedPlants || 0), 0),
        totalCapacity: reminders.reduce((sum, r) => sum + (r.totalPlants || 0), 0),
        overdueCount: reminders.filter((r) => r.priority === "overdue").length, // Past
        urgentCount: reminders.filter((r) => r.priority === "urgent").length, // Current
        upcomingCount: reminders.filter((r) => r.priority === "upcoming").length, // Current
        futureCount: reminders.filter((r) => r.priority === "future").length, // Future
        // Stats excluding future entries (for sowing needed cards)
        currentSowingNeeded: {
          totalSlots: reminders.filter((r) => r.priority !== "future").length,
          totalBookingGap: reminders
            .filter((r) => r.priority !== "future")
            .reduce((sum, r) => sum + Math.max(0, r.bookingGap || 0), 0),
          totalSlotBufferCount: reminders
            .filter((r) => r.priority !== "future")
            .reduce((sum, r) => sum + (r.slotBufferCount || 0), 0),
          overdueGap: reminders
            .filter((r) => r.priority === "overdue")
            .reduce((sum, r) => sum + Math.max(0, r.bookingGap || 0), 0),
          urgentGap: reminders
            .filter((r) => r.priority === "urgent")
            .reduce((sum, r) => sum + Math.max(0, r.bookingGap || 0), 0),
          upcomingGap: reminders
            .filter((r) => r.priority === "upcoming")
            .reduce((sum, r) => sum + Math.max(0, r.bookingGap || 0), 0),
          overdueCount: reminders.filter((r) => r.priority === "overdue").length,
          urgentCount: reminders.filter((r) => r.priority === "urgent").length,
          upcomingCount: reminders.filter((r) => r.priority === "upcoming").length,
        },
      },
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("Error fetching plant reminders:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching plant reminders",
      error: error.message,
    });
  }
};

// NEW API: Get Plant Alerts (Plant selection mandatory, subtype-wise alerts)
export const getPlantAlerts = async (req, res) => {
  try {
    const { 
      plantId,
      subtypeId, // Filter by subtype
      priority, // Filter by priority: overdue, urgent, upcoming (future is excluded)
      current, // Show only current priorities (urgent + upcoming), excludes future and overdue
      startDate, // Date range start (DD-MM-YYYY)
      endDate, // Date range end (DD-MM-YYYY)
      lookaheadDays = 14, // Default 14 days
    } = req.query;

    if (!plantId) {
      return res.status(400).json({
        success: false,
        message: "Plant ID is required. Please select a plant.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(plantId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Plant ID format",
      });
    }

    const today = moment().startOf("day");
    let futureBoundary;
    
    // Date range filter
    if (startDate && endDate) {
      futureBoundary = moment(endDate, "DD-MM-YYYY").endOf("day").toDate();
    } else {
      futureBoundary = today.clone().add(parseInt(lookaheadDays) || 14, "days").endOf("day").toDate();
    }
    
    // Build match conditions for filtering
    const buildAlertMatchConditions = () => {
      const conditions = {
        pendingQuantity: { $gt: 0 },
      };
      
      if (subtypeId && mongoose.Types.ObjectId.isValid(subtypeId)) {
        conditions.subtypeId = new mongoose.Types.ObjectId(subtypeId);
      }
      
      // Priority filtering: exclude "future" by default, only show overdue, urgent, upcoming
      // If "current" parameter is true, show only urgent + upcoming (exclude overdue and future)
      if (current === "true") {
        // Show only current priorities (urgent + upcoming)
        conditions.priority = { $in: ["urgent", "upcoming"] };
      } else if (priority) {
        // Specific priority filter (but still exclude future if somehow passed)
        if (priority !== "future") {
          conditions.priority = priority;
        } else {
          // If future is explicitly requested, return empty (we don't show future)
          conditions.priority = "nonexistent"; // This will return no results
        }
      } else {
        // Default: exclude future, show only overdue, urgent, upcoming
        conditions.priority = { $in: ["overdue", "urgent", "upcoming"] };
      }
      
      if (startDate && endDate) {
        conditions.sowByDateISO = {
          $gte: moment(startDate, "DD-MM-YYYY").startOf("day").toDate(),
          $lte: moment(endDate, "DD-MM-YYYY").endOf("day").toDate(),
        };
      } else {
        conditions.sowByDateISO = {
          $lte: futureBoundary,
        };
      }
      
      return conditions;
    };

    const alertMatchConditions = buildAlertMatchConditions();

    // Get alerts for this plant
    const alerts = await PlantSlot.aggregate([
      {
        $match: {
          plantId: new mongoose.Types.ObjectId(plantId),
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          slotReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
      // Gap / pending: unsown order plants only (sowingDone excluded)
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$slotId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                    { $ne: ["$sowingDone", true] },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBookedPlants: {
                  $sum: {
                    $add: [
                      { $ifNull: ["$numberOfPlants", 0] },
                      { $ifNull: ["$additionalPlants", 0] },
                    ],
                  },
                },
              }
            }
          ],
          as: "orderStats"
        }
      },
      {
        $addFields: {
          totalBookedPlants: {
            $ifNull: [
              { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
              0
            ]
          }
        }
      },
      {
        $project: {
          orderStats: 0
        }
      },
      {
        $addFields: {
          pendingQuantity: {
            $max: [
              0,
              {
                $subtract: [
                  "$totalBookedPlants",
                  "$primarySowed",
                ],
              },
            ],
          },
          slotEndISO: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                ],
              },
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $addFields: {
          sowByDateISO: {
            $cond: [
              { $gt: ["$slotReadyDays", 0] },
              {
                $dateSubtract: {
                  startDate: "$slotEndISO",
                  unit: "day",
                  amount: "$slotReadyDays",
                },
              },
              "$slotEndISO",
            ],
          },
        },
      },
      {
        $addFields: {
          daysUntilSow: {
            $round: [
              {
                $divide: [
                  { $subtract: ["$sowByDateISO", today.toDate()] },
                  1000 * 60 * 60 * 24,
                ],
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          priority: {
            $cond: [
              { $lt: ["$daysUntilSow", 0] },
              "overdue",
              {
                $cond: [
                  { $lte: ["$daysUntilSow", 2] },
                  "urgent",
                  {
                    $cond: [
                      { $lte: ["$daysUntilSow", 5] },
                      "upcoming",
                      "future",
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        $match: alertMatchConditions,
      },
      {
        $project: {
          _id: "$subtypeSlots.slots._id",
          slotId: "$subtypeSlots.slots._id",
          plantId: "$plantId",
          plantName: { $ifNull: ["$plantInfo.name", "Unknown"] },
          subtypeId: "$subtypeSlots.subtypeId",
          subtypeName: { $ifNull: ["$subtypeDetails.name", "Subtype"] },
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          totalBookedPlants: 1,
          primarySowed: 1,
          pendingQuantity: 1,
          sowByDate: {
            $dateToString: {
              date: "$sowByDateISO",
              format: "%d-%m-%Y",
            },
          },
          daysUntilSow: 1,
          priority: 1,
          plantReadyDays: "$slotReadyDays",
        },
      },
      {
        $sort: { daysUntilSow: 1, priority: 1 },
      },
    ]);

    // Group by subtype for summary
    const subtypeAlerts = await PlantSlot.aggregate([
      {
        $match: {
          plantId: new mongoose.Types.ObjectId(plantId),
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
        },
      },
      // Gap / pending by subtype: unsown order plants only
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$slotId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                    { $ne: ["$sowingDone", true] },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBookedPlants: {
                  $sum: {
                    $add: [
                      { $ifNull: ["$numberOfPlants", 0] },
                      { $ifNull: ["$additionalPlants", 0] },
                    ],
                  },
                },
              }
            }
          ],
          as: "orderStats"
        }
      },
      {
        $addFields: {
          totalBookedPlants: {
            $ifNull: [
              { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
              0
            ]
          },
          pendingQuantity: {
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: [{ $arrayElemAt: ["$orderStats.totalBookedPlants", 0] }, 0] },
                  { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] }
                ]
              }
            ]
          }
        }
      },
      {
        $project: {
          orderStats: 0
        }
      },
      {
        $match: {
          pendingQuantity: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: "$subtypeSlots.subtypeId",
          subtypeName: { $first: { $ifNull: ["$subtypeDetails.name", "Subtype"] } },
          totalPending: { $sum: "$pendingQuantity" },
          slotCount: { $sum: 1 },
        },
      },
      {
        $sort: { totalPending: -1 },
      },
    ]);

    // Get plant info
    const plantInfo = await PlantCms.findById(plantId).select("name sowingAllowed").lean();

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      plantInfo: {
        plantId,
        plantName: plantInfo?.name || "Unknown",
        sowingAllowed: plantInfo?.sowingAllowed || false,
      },
      subtypeAlerts,
      alerts,
      summary: {
        totalAlerts: alerts.length,
        totalPending: alerts.reduce((sum, a) => sum + a.pendingQuantity, 0),
        overdueCount: alerts.filter((a) => a.priority === "overdue").length,
        urgentCount: alerts.filter((a) => a.priority === "urgent").length,
        upcomingCount: alerts.filter((a) => a.priority === "upcoming").length,
      },
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("Error fetching plant alerts:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching plant alerts",
      error: error.message,
    });
  }
};

// NEW API: Get Plant Availability (Plant selection mandatory, shows only available slots with primary sowed info)
export const getPlantAvailability = async (req, res) => {
  try {
    const { 
      plantId,
      subtypeId, // Filter by subtype
      startDate, // Date range start (DD-MM-YYYY)
      endDate, // Date range end (DD-MM-YYYY)
      minAvailable, // Minimum available plants threshold
    } = req.query;

    if (!plantId) {
      return res.status(400).json({
        success: false,
        message: "Plant ID is required. Please select a plant.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(plantId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Plant ID format",
      });
    }

    const today = moment().startOf("day");
    let dateFilter = {};
    
    // Date range filter
    if (startDate && endDate) {
      const start = moment(startDate, "DD-MM-YYYY").startOf("day").toDate();
      const end = moment(endDate, "DD-MM-YYYY").endOf("day").toDate();
      dateFilter = {
        slotEndISO: {
          $gte: start,
          $lte: end,
        },
      };
    }

    // Build match conditions - show slots with availability OR with bookings
    const buildAvailabilityMatchConditions = () => {
      const conditions = {};
      
      if (subtypeId && mongoose.Types.ObjectId.isValid(subtypeId)) {
        conditions.subtypeId = new mongoose.Types.ObjectId(subtypeId);
      }
      
      if (Object.keys(dateFilter).length > 0) {
        Object.assign(conditions, dateFilter);
      }
      
      // Show slots with available capacity OR slots that have bookings (even if totalPlants = 0)
      // This ensures booked slots show up even when capacity is cleared
      conditions.$or = [
        { availablePlants: { $gt: 0 } }, // Has available capacity
        { totalBookedPlants: { $gt: 0 } } // Has bookings (to show booked plants even if capacity is 0)
      ];
      
      if (minAvailable) {
        // If minAvailable is specified, add it as additional condition for availablePlants
        conditions.$and = [
          { $or: conditions.$or },
          { availablePlants: { $gte: parseInt(minAvailable) || 0 } }
        ];
        delete conditions.$or; // Remove $or since we're using $and now
      }
      
      return conditions;
    };

    const availabilityMatchConditions = buildAvailabilityMatchConditions();

    // Get all slots for this plant with availability
    const availability = await PlantSlot.aggregate([
      {
        $match: {
          plantId: new mongoose.Types.ObjectId(plantId),
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
          slotReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
      // Dynamically calculate totalBookedPlants from actual orders
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$slotId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBookedPlants: { $sum: "$numberOfPlants" }
              }
            }
          ],
          as: "orderStats"
        }
      },
      {
        $addFields: {
          totalBookedPlants: {
            $ifNull: [
              { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
              0
            ]
          }
        }
      },
      {
        $project: {
          orderStats: 0
        }
      },
      {
        $addFields: {
          // For sowing-allowed plants: Available = primarySowed - totalBookedPlants
          // This represents plants ready for booking (already sowed minus already booked)
          availablePlants: {
            $max: [
              0,
              {
                $subtract: [
                  "$primarySowed",
                  "$totalBookedPlants",
                ],
              },
            ],
          },
          slotEndISO: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                ],
              },
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $match: availabilityMatchConditions,
      },
      {
        $project: {
          _id: "$subtypeSlots.slots._id",
          slotId: "$subtypeSlots.slots._id",
          plantId: "$plantId",
          plantName: { $ifNull: ["$plantInfo.name", "Unknown"] },
          subtypeId: "$subtypeSlots.subtypeId",
          subtypeName: { $ifNull: ["$subtypeDetails.name", "Subtype"] },
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          totalBookedPlants: 1,
          primarySowed: 1,
          totalPlants: 1,
          availablePlants: 1,
          surplus: "$availablePlants",
          utilizationRate: {
            $cond: [
              { $gt: ["$totalPlants", 0] },
              {
                $multiply: [
                  {
                    $divide: ["$totalBookedPlants", "$totalPlants"],
                  },
                  100,
                ],
              },
              0,
            ],
          },
          plantReadyDays: "$slotReadyDays",
        },
      },
      {
        $sort: { availablePlants: -1, slotEndDay: 1 }, // Sort by availability (highest first)
      },
    ]);

    // Group by subtype for summary
    const subtypeAvailability = await PlantSlot.aggregate([
      {
        $match: {
          plantId: new mongoose.Types.ObjectId(plantId),
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
        },
      },
      // Dynamically calculate totalBookedPlants from actual orders for subtype summary
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$slotId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBookedPlants: { $sum: "$numberOfPlants" }
              }
            }
          ],
          as: "orderStats"
        }
      },
      {
        $addFields: {
          totalBookedPlants: {
            $ifNull: [
              { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
              0
            ]
          },
          // For sowing-allowed plants: Available = primarySowed - totalBookedPlants
          availablePlants: {
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: ["$primarySowed", 0] },
                  "$totalBookedPlants" // Use the field we just calculated above
                ]
              }
            ]
          }
        }
      },
      {
        $project: {
          orderStats: 0
        }
      },
      {
        $match: {
          availablePlants: { $gt: 0 },
          ...(subtypeId && mongoose.Types.ObjectId.isValid(subtypeId) ? {
            subtypeId: new mongoose.Types.ObjectId(subtypeId)
          } : {}),
        },
      },
      {
        $group: {
          _id: "$subtypeSlots.subtypeId",
          subtypeName: { $first: { $ifNull: ["$subtypeDetails.name", "Subtype"] } },
          totalAvailable: { $sum: "$availablePlants" },
          totalBooked: { $sum: "$totalBookedPlants" },
          totalPrimarySowed: { $sum: "$primarySowed" },
          totalCapacity: { $sum: "$totalPlants" },
          slotCount: { $sum: 1 },
        },
      },
      {
        $addFields: {
          utilizationRate: {
            $cond: [
              { $gt: ["$totalCapacity", 0] },
              {
                $multiply: [
                  {
                    $divide: ["$totalBooked", "$totalCapacity"],
                  },
                  100,
                ],
              },
              0,
            ],
          },
        },
      },
      {
        $sort: { totalAvailable: -1 },
      },
    ]);

    // Get plant info
    const plantInfo = await PlantCms.findById(plantId).select("name sowingAllowed").lean();

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      plantInfo: {
        plantId,
        plantName: plantInfo?.name || "Unknown",
        sowingAllowed: plantInfo?.sowingAllowed || false,
      },
      subtypeAvailability,
      availability,
      summary: {
        totalSlots: availability.length,
        totalAvailable: availability.reduce((sum, a) => sum + (a.availablePlants || 0), 0),
        totalBooked: availability.reduce((sum, a) => sum + (a.totalBookedPlants || 0), 0),
        totalPrimarySowed: availability.reduce((sum, a) => sum + (a.primarySowed || 0), 0),
        totalCapacity: availability.reduce((sum, a) => sum + (a.totalPlants || 0), 0),
        avgUtilization: availability.length > 0 
          ? availability.reduce((sum, a) => sum + (a.utilizationRate || 0), 0) / availability.length 
          : 0,
      },
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("Error fetching plant availability:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching plant availability",
      error: error.message,
    });
  }
};

// NEW API: Get All Plants Availability (Date range mandatory, shows all plants with all subtypes)
export const getAllPlantsAvailability = async (req, res) => {
  try {
    const { 
      startDate, // Date range start (DD-MM-YYYY) - MANDATORY
      endDate, // Date range end (DD-MM-YYYY) - MANDATORY
      minAvailable, // Minimum available plants threshold
      groupByDays, // Optional: Group slots by days
    } = req.query;

    // Date range is mandatory
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Start date and end date are required. Please provide date range.",
      });
    }

    // Validate date format
    const start = moment(startDate, "DD-MM-YYYY");
    const end = moment(endDate, "DD-MM-YYYY");
    
    if (!start.isValid() || !end.isValid()) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Please use DD-MM-YYYY format.",
      });
    }

    if (start.isAfter(end)) {
      return res.status(400).json({
        success: false,
        message: "Start date must be before or equal to end date.",
      });
    }

    const startDateISO = start.startOf("day").toDate();
    const endDateISO = end.endOf("day").toDate();

    // Build match conditions
    const buildAvailabilityMatchConditions = () => {
      const conditions = {
        slotEndISO: {
          $gte: startDateISO,
          $lte: endDateISO,
        },
        availablePlants: { $gt: 0 }, // Only show slots with available plants
      };
      
      if (minAvailable) {
        conditions.availablePlants = { $gte: parseInt(minAvailable) || 0 };
      }
      
      return conditions;
    };

    const availabilityMatchConditions = buildAvailabilityMatchConditions();

    // Get all plants with sowing allowed
    const allPlants = await PlantCms.find({ sowingAllowed: true })
      .select("_id name subtypes")
      .lean();

    // Get availability for all plants
    const allAvailability = await PlantSlot.aggregate([
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
        },
      },
      // Calculate totalBookedPlants from orders
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$slotId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBookedPlants: { $sum: "$numberOfPlants" }
              }
            }
          ],
          as: "orderStats"
        }
      },
      {
        $addFields: {
          totalBookedPlants: {
            $ifNull: [
              { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
              0
            ]
          },
          availablePlants: {
            $max: [
              0,
              {
                $subtract: [
                  "$primarySowed",
                  {
                    $ifNull: [
                      { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
                      0
                    ]
                  },
                ],
              },
            ],
          },
          slotEndISO: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                ],
              },
              format: "%Y-%m-%d",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $match: availabilityMatchConditions,
      },
      {
        $project: {
          _id: "$subtypeSlots.slots._id",
          slotId: "$subtypeSlots.slots._id",
          plantId: "$plantId",
          plantName: { $ifNull: ["$plantInfo.name", "Unknown"] },
          subtypeId: "$subtypeSlots.subtypeId",
          subtypeName: { $ifNull: ["$subtypeDetails.name", "Subtype"] },
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          totalBookedPlants: 1,
          primarySowed: 1,
          totalPlants: 1,
          availablePlants: 1,
          plantReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
      {
        $sort: { plantName: 1, subtypeName: 1, slotStartDay: 1 },
      },
    ]);

    // Group by plant and subtype
    const plantGroups = {};
    
    allAvailability.forEach((slot) => {
      const plantKey = slot.plantId.toString();
      const subtypeKey = slot.subtypeId.toString();
      
      if (!plantGroups[plantKey]) {
        plantGroups[plantKey] = {
          plantId: slot.plantId,
          plantName: slot.plantName,
          subtypes: {},
          totalAvailable: 0,
          totalSlots: 0,
        };
      }
      
      if (!plantGroups[plantKey].subtypes[subtypeKey]) {
        plantGroups[plantKey].subtypes[subtypeKey] = {
          subtypeId: slot.subtypeId,
          subtypeName: slot.subtypeName,
          slots: [],
          totalAvailable: 0,
        };
      }
      
      plantGroups[plantKey].subtypes[subtypeKey].slots.push(slot);
      plantGroups[plantKey].subtypes[subtypeKey].totalAvailable += slot.availablePlants || 0;
      plantGroups[plantKey].totalAvailable += slot.availablePlants || 0;
      plantGroups[plantKey].totalSlots += 1;
    });

    // Convert to array format
    const plantsAvailability = Object.values(plantGroups).map((plant) => ({
      ...plant,
      subtypes: Object.values(plant.subtypes),
    }));

    // Calculate summary
    const summary = {
      totalPlants: plantsAvailability.length,
      totalSubtypes: plantsAvailability.reduce((sum, p) => sum + p.subtypes.length, 0),
      totalSlots: allAvailability.length,
      totalAvailable: allAvailability.reduce((sum, s) => sum + (s.availablePlants || 0), 0),
    };

    return res.status(200).json({
      success: true,
      plantsAvailability,
      summary,
      dateRange: {
        startDate,
        endDate,
      },
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("Error fetching all plants availability:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching all plants availability",
      error: error.message,
    });
  }
};

// NEW API: Get Plants Gap Summary (all plants with subtype-wise totalBookingGap) - OPTIMIZED
export const getPlantsGapSummary = async (req, res) => {
  try {
    const { available, startDate, endDate, board } = req.query; // available=surplus, board=all stock slots
    
    // Get all plants with sowingAllowed = true (including sowingBuffer) - single query
    const plants = await PlantCms.find({ sowingAllowed: true })
      .select("_id name subtypes sowingBuffer")
      .lean();

    if (!plants || plants.length === 0) {
      return res.status(200).json({
        success: true,
        plants: [],
        summary: {
          totalPlants: 0,
          totalSubtypes: 0,
          totalBookingGap: 0,
        },
        generatedAt: new Date(),
      });
    }

    const plantIds = plants.map(p => p._id);
    const plantMap = new Map(plants.map(p => [p._id.toString(), p]));

    // Batch fetch all products for all plants at once
    const products = await Product.find({
      plantId: { $in: plantIds },
      category: { $regex: /^seeds$/i },
      isActive: true,
    })
      .select("plantId subtypeId conversionFactor secondaryUnit primaryUnit _id")
      .populate("secondaryUnit", "name symbol")
      .populate("primaryUnit", "name symbol")
      .lean();

    // Create product map: key = "plantId-subtypeId"
    const productMap = new Map();
    products.forEach(p => {
      const key = `${p.plantId}-${p.subtypeId}`;
      productMap.set(key, p);
    });

    // Batch fetch all batches for all products at once
    const productIds = products.map(p => p._id);
    const batches = await Batch.find({
      product: { $in: productIds },
      status: "active",
      remainingQuantity: { $gt: 0 },
    })
      .select("product remainingQuantity unit")
      .populate("unit", "name symbol _id")
      .lean();

    // Group batches by product
    const batchMap = new Map();
    batches.forEach(batch => {
      const productId = batch.product.toString();
      if (!batchMap.has(productId)) {
        batchMap.set(productId, []);
      }
      batchMap.get(productId).push(batch);
    });

    // Step 1: Get all slots with their IDs, endDay, and plantReadyDays - FAST aggregation
    // Build aggregation pipeline with optional date filter
    const aggregationPipeline = [
      {
        $match: {
          plantId: { $in: plantIds },
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
    ];
    
    // Add date range filter if provided (slots are stored as DD-MM-YYYY strings)
    if (startDate && endDate) {
      aggregationPipeline.push({
        $match: {
          "subtypeSlots.slots.startDay": { $gte: startDate },
          "subtypeSlots.slots.endDay": { $lte: endDate },
        },
      });
    }
    
    aggregationPipeline.push(
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          slotReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
      {
        $project: {
          plantId: 1,
          subtypeId: "$subtypeSlots.subtypeId",
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          slotReadyDays: 1,
        },
      },
    );
    
    const allSlots = await PlantSlot.aggregate(aggregationPipeline);

    // Step 2: Collect all slot IDs and create slot map
    const slotIds = allSlots.map(s => s.slotId);
    const slotMap = new Map();
    allSlots.forEach(slot => {
      slotMap.set(slot.slotId.toString(), slot);
    });

    // Step 3: Single aggregation on orders to get all bookings grouped by slot - MUCH FASTER
    const orderBookings = await Order.aggregate([
      {
        $match: {
          bookingSlot: { $in: slotIds },
          orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
          $or: [
            { quotaSource: { $ne: "dealer" } },
            { quotaSource: { $exists: false } },
            { quotaSource: null },
          ],
        },
      },
      {
        $group: {
          _id: "$bookingSlot",
          totalBookedPlants: { $sum: "$numberOfPlants" },
        },
      },
    ]);

    // Step 4: Create booking map for fast lookup
    const bookingMap = new Map();
    orderBookings.forEach(booking => {
      bookingMap.set(booking._id.toString(), booking.totalBookedPlants);
    });

    // Step 5: Join slots with bookings in memory and calculate gaps, overdue status
    const today = moment().startOf("day");
    
    const slotsWithBookings = allSlots.map(slot => {
      const slotIdStr = slot.slotId.toString();
      const totalBookedPlants = bookingMap.get(slotIdStr) || 0;
      const primarySowed = slot.primarySowed || 0;
      
      // Calculate gap covered by later slots
      const gapCoveredAmount = (slot.gapCovered || []).reduce((sum, coverage) => {
        return sum + (coverage.plantsCovered || 0);
      }, 0);
      
      // Effective gap = raw gap - covered amount
      const rawGap = totalBookedPlants - primarySowed;
      const slotGap = Math.max(0, rawGap - gapCoveredAmount);
      
      // Calculate overdue status
      // A slot is overdue if: sowByDate (slotEndDay - plantReadyDays) is in the past
      // slotReadyDays is already set from aggregation (slot-level first, then PlantCMS fallback)
      let isOverdue = false;
      let sowByDate = null;
      const slotReadyDays = slot.slotReadyDays || 0;
      
      if (slot.slotEndDay) {
        // Parse slot end date (DD-MM-YYYY format) and calculate sowByDate
        const slotEndMoment = moment(slot.slotEndDay, "DD-MM-YYYY", true); // Strict parsing
        if (slotEndMoment.isValid()) {
          if (slotReadyDays > 0) {
            // Calculate: sowByDate = slotEndDate - plantReadyDays
            // Example: slotEndDate = 25-01-2025, plantReadyDays = 20, sowByDate = 05-01-2025
            const sowByMoment = slotEndMoment.clone().subtract(slotReadyDays, "days");
            sowByDate = sowByMoment.format("DD-MM-YYYY");
            
            // Check if overdue: sowByDate is in the past (before today)
            if (sowByMoment.isBefore(today, "day")) {
              isOverdue = true;
            }
          } else {
            // If no plantReadyDays configured, use slotEndDate as sowByDate (fallback)
            sowByDate = slotEndMoment.format("DD-MM-YYYY");
            // Check if overdue: slotEndDate is in the past
            if (slotEndMoment.isBefore(today, "day")) {
              isOverdue = true;
            }
          }
        } else {
          console.warn(`[getPlantsGapSummary] Invalid slot endDay: ${slot.slotEndDay} for slotId: ${slot.slotId}`);
        }
      }
      
      // Debug logging for Twinkle subtype
      if (slot.subtypeId && slot.plantId) {
        const plant = plantMap.get(slot.plantId.toString());
        const subtypes = plant?.subtypes || [];
        const subtypeDetails = subtypes.find(st => st._id.toString() === slot.subtypeId.toString());
        if (subtypeDetails?.name?.toLowerCase().includes("twinkle")) {
        }
      }
      
      // Calculate available plants (negative of rawGap when rawGap < 0)
      const availablePlants = rawGap < 0 ? Math.abs(rawGap) : 0;
      
      return {
        slotId: slot.slotId,
        plantId: slot.plantId,
        subtypeId: slot.subtypeId,
        totalBookedPlants,
        primarySowed,
        slotGap,
        rawGap, // Include raw gap for comparison
        availablePlants, // Available plants (surplus) - only when rawGap < 0
        slotStartDay: slot.slotStartDay, // Include start day for grouping
        slotEndDay: slot.slotEndDay, // Include end day for grouping
        gapCovered: slot.gapCovered || [], // Gap coverage details
        gapCoveredAmount, // Total amount covered
        gapFullyCovered: slot.gapFullyCovered || false, // Is gap fully covered
        isOverdue,
        sowByDate,
        plantReadyDays: slotReadyDays,
      };
    });

    // Step 6: Filter slots based on available parameter
    // For critical mode: include slots with positive gap OR overdue slots (even with 0 gap)
    // For available mode: only negative gap slots (primarySowed > totalBookedPlants = surplus)
    const isBoard = board === "true";
    const filteredSlots = isBoard
      ? slotsWithBookings
      : available === "true"
      ? slotsWithBookings.filter(s => {
          const hasSurplus = s.rawGap < 0;
          if (hasSurplus) {
            const plant = plantMap.get(s.plantId.toString());
            const subtypes = plant?.subtypes || [];
            const subtypeDetails = subtypes.find(st => st._id.toString() === s.subtypeId.toString());
          }
          return hasSurplus;
        })
      : slotsWithBookings.filter(s => {
          // Include if positive gap OR overdue
          if (s.slotGap > 0 || s.isOverdue) {
            // Debug logging for overdue slots
            if (s.isOverdue) {
            }
            return true;
          }
          return false;
        });
    
    // Debug: Log summary of filtered slots by plant
    if (available === "true") {
      const slotsByPlant = new Map();
      filteredSlots.forEach(slot => {
        const plantId = slot.plantId.toString();
        if (!slotsByPlant.has(plantId)) {
          const plant = plantMap.get(plantId);
          slotsByPlant.set(plantId, { plantName: plant?.name || 'Unknown', count: 0 });
        }
        slotsByPlant.get(plantId).count++;
      });
      console.log(`[getPlantsGapSummary] Available mode: Found ${filteredSlots.length} slots with surplus across ${slotsByPlant.size} plants:`, 
        Array.from(slotsByPlant.entries()).map(([id, data]) => `${data.plantName}(${data.count})`).join(', '));
    }

    // Step 7: Group by plant/subtype
    const subtypeGroupMap = new Map();
    filteredSlots.forEach(slot => {
      const key = `${slot.plantId.toString()}-${slot.subtypeId.toString()}`;
      if (!subtypeGroupMap.has(key)) {
        subtypeGroupMap.set(key, {
          plantId: slot.plantId,
          subtypeId: slot.subtypeId,
          totalBookedPlants: 0,
          totalPrimarySowed: 0,
          slotCount: 0,
          overdueSlotCount: 0,
          plantReadyDays: slot.plantReadyDays || 0,
          minPlantReadyDays: slot.plantReadyDays || 0,
          maxPlantReadyDays: slot.plantReadyDays || 0,
          slots: available === "true" || isBoard ? [] : undefined, // Slot details for board / available mode
        });
      }
      const group = subtypeGroupMap.get(key);
      group.totalBookedPlants += slot.totalBookedPlants;
      group.totalPrimarySowed += slot.primarySowed;
      group.slotCount += 1;
      if (slot.isOverdue) {
        group.overdueSlotCount += 1;
      }
      const readyDaysValue = Number(slot.plantReadyDays) || 0;
      group.minPlantReadyDays = Math.min(group.minPlantReadyDays, readyDaysValue);
      group.maxPlantReadyDays = Math.max(group.maxPlantReadyDays, readyDaysValue);
      if (group.minPlantReadyDays === group.maxPlantReadyDays) {
        group.plantReadyDays = group.maxPlantReadyDays;
      }
      // Store slot details for available mode (for grouping on frontend)
      if ((available === "true" || isBoard) && group.slots) {
        group.slots.push({
          slotId: slot.slotId,
          slotStartDay: slot.slotStartDay,
          slotEndDay: slot.slotEndDay,
          plantReadyDays: slot.plantReadyDays || 0,
          availablePlants: slot.availablePlants,
          totalBookedPlants: slot.totalBookedPlants,
          primarySowed: slot.primarySowed,
          rawGap: slot.rawGap,
          slotGap: slot.slotGap,
        });
      }
    });

    // Step 8: Convert to array and calculate gaps
    const allSubtypeSummary = Array.from(subtypeGroupMap.values()).map(item => {
      const totalBookingGap = Math.max(0, item.totalBookedPlants - item.totalPrimarySowed);
      const totalAvailableGap = Math.max(0, item.totalPrimarySowed - item.totalBookedPlants);
      const rawGap = item.totalBookedPlants - item.totalPrimarySowed;
      
      return {
        _id: {
          plantId: item.plantId,
          subtypeId: item.subtypeId,
        },
        totalBookedPlants: item.totalBookedPlants,
        totalPrimarySowed: item.totalPrimarySowed,
        slotCount: item.slotCount,
        overdueSlotCount: item.overdueSlotCount || 0,
        plantReadyDays: item.plantReadyDays || 0,
        minPlantReadyDays: item.minPlantReadyDays || 0,
        maxPlantReadyDays: item.maxPlantReadyDays || 0,
        hasMixedPlantReadyDays: (item.minPlantReadyDays || 0) !== (item.maxPlantReadyDays || 0),
        totalBookingGap,
        totalAvailableGap,
        rawGap,
        slots: item.slots || undefined, // Include slot details for available mode
      };
    });

    // Process results and group by plant
    const plantSubtypeMap = new Map();
    
    allSubtypeSummary.forEach((item) => {
      const plantId = item._id.plantId.toString();
      const subtypeId = item._id.subtypeId.toString();
      
      if (!plantSubtypeMap.has(plantId)) {
        plantSubtypeMap.set(plantId, []);
      }
      
      plantSubtypeMap.get(plantId).push({
        _id: subtypeId,
        totalBookingGap: item.totalBookingGap,
        totalAvailableGap: item.totalAvailableGap,
        totalBookedPlants: item.totalBookedPlants,
        totalPrimarySowed: item.totalPrimarySowed,
        slotCount: item.slotCount,
        overdueSlotCount: item.overdueSlotCount,
        plantReadyDays: item.plantReadyDays,
        slots: item.slots, // Include slot details for available mode
      });
    });

    // Process each plant and enrich with product/batch data
    let plantsWithGaps = plants.map((plant) => {
      const plantIdStr = plant._id.toString();
      const sowingBuffer = plant.sowingBuffer || 0;
      const subtypes = plant.subtypes || [];
      
      // Get subtypes for this plant from aggregation results
      const subtypeSummary = plantSubtypeMap.get(plantIdStr) || [];
      
      // Enrich with subtype names and product data
      const subtypesWithGaps = subtypeSummary.map((subtype) => {
        // Find subtype name from plant data
        const subtypeDetails = subtypes.find(
          st => st._id.toString() === subtype._id
        );
        const subtypeName = subtypeDetails?.name || "Unknown";
        
        // Apply sowing buffer
        const bookingGapWithBuffer = sowingBuffer > 0 
          ? Math.round(subtype.totalBookingGap * (1 + sowingBuffer / 100))
          : subtype.totalBookingGap;
        
        // Get product data from pre-fetched map
        const productKey = `${plantIdStr}-${subtype._id}`;
        const product = productMap.get(productKey);
        
        let conversionFactor = null;
        let secondaryUnit = null;
        let primaryUnit = null;
        let availablePackets = 0;
        
        if (product) {
          conversionFactor = product.conversionFactor || null;
          secondaryUnit = product.secondaryUnit || null;
          primaryUnit = product.primaryUnit || null;
          
          // Get batches from pre-fetched map
          const productBatches = batchMap.get(product._id.toString()) || [];
          
          let totalAvailable = 0;
          productBatches.forEach((batch) => {
            const batchUnitId = batch.unit?._id?.toString();
            const primaryUnitId = primaryUnit?._id?.toString();
            const secondaryUnitId = secondaryUnit?._id?.toString();

            if (batchUnitId === primaryUnitId) {
              totalAvailable += batch.remainingQuantity;
            } else if (batchUnitId === secondaryUnitId && conversionFactor) {
              totalAvailable += batch.remainingQuantity / conversionFactor;
            } else {
              totalAvailable += batch.remainingQuantity;
            }
          });
          
          availablePackets = Math.floor(totalAvailable);
        }
        
        return {
          _id: subtype._id,
          subtypeName: subtypeName,
          displaySowingQty: bookingGapWithBuffer,
          baseSowingQty: subtype.totalBookingGap,
          totalBookingGap: bookingGapWithBuffer,
          totalBookingGapRaw: subtype.totalBookingGap,
          totalAvailableGap: subtype.totalAvailableGap || 0,
          totalBookedPlants: subtype.totalBookedPlants,
          totalPrimarySowed: subtype.totalPrimarySowed,
          slotCount: subtype.slotCount,
          overdueSlotCount: subtype.overdueSlotCount || 0,
          plantReadyDays: subtype.plantReadyDays || subtypeDetails?.plantReadyDays || 0,
          sowingBuffer: sowingBuffer,
          conversionFactor: conversionFactor,
          secondaryUnit: secondaryUnit,
          primaryUnit: primaryUnit,
          availablePackets: availablePackets,
          slots: subtype.slots || undefined, // Include slot details for available mode (for grouping)
        };
      });

      // Filter based on available parameter
      // For critical mode: show subtypes with positive gap OR overdue slots
      // For available mode: show subtypes with negative gap
      let filteredSubtypes = subtypesWithGaps;
      if (isBoard) {
        filteredSubtypes = subtypesWithGaps.filter((st) => (st.slots?.length || 0) > 0);
      } else if (available === "true") {
        filteredSubtypes = subtypesWithGaps.filter((st) => {
          const rawGap = (st.totalBookedPlants || 0) - (st.totalPrimarySowed || 0);
          return rawGap < 0;
        });
      } else {
        filteredSubtypes = subtypesWithGaps.filter((st) => {
          const hasGap = (st.totalBookingGap || 0) > 0;
          const hasOverdue = (st.overdueSlotCount || 0) > 0;
          const shouldInclude = hasGap || hasOverdue;
          
          // Debug logging for overdue subtypes
          if (hasOverdue) {
          }
          
          return shouldInclude;
        });
      }

      const plantTotalGap = isBoard
        ? filteredSubtypes.reduce(
            (sum, st) => sum + Math.max(0, (st.totalBookedPlants || 0) - (st.totalPrimarySowed || 0)),
            0
          )
        : available === "true"
        ? filteredSubtypes.reduce((sum, st) => sum + (st.totalAvailableGap || 0), 0)
        : filteredSubtypes.reduce((sum, st) => sum + (st.totalBookingGap || 0), 0);

      return {
        _id: plant._id,
        plantName: plant.name,
        subtypes: filteredSubtypes,
        totalBookingGap: isBoard
          ? plantTotalGap
          : available === "true"
          ? 0
          : plantTotalGap,
        totalAvailableGap: isBoard
          ? filteredSubtypes.reduce((sum, st) => sum + (st.totalAvailableGap || 0), 0)
          : available === "true"
          ? plantTotalGap
          : 0,
      };
    });

    // Filter out plants with no subtypes when in available / board mode
    if (isBoard) {
      plantsWithGaps = plantsWithGaps.filter(
        (plant) => plant.subtypes && plant.subtypes.length > 0
      );
    } else if (available === "true") {
      plantsWithGaps = plantsWithGaps.filter(plant => 
        plant.subtypes && plant.subtypes.length > 0 && (plant.totalAvailableGap || 0) > 0
      );
    }
    
    // Sort by appropriate gap type
    if (isBoard) {
      plantsWithGaps.sort(
        (a, b) =>
          (b.totalAvailableGap || 0) + (b.totalBookingGap || 0) -
          ((a.totalAvailableGap || 0) + (a.totalBookingGap || 0))
      );
    } else if (available === "true") {
      plantsWithGaps.sort((a, b) => (b.totalAvailableGap || 0) - (a.totalAvailableGap || 0));
    } else {
      plantsWithGaps.sort((a, b) => (b.totalBookingGap || 0) - (a.totalBookingGap || 0));
    }

    // Calculate overall summary
    const totalBookingGap = plantsWithGaps.reduce(
      (sum, plant) => sum + (plant.totalBookingGap || 0),
      0
    );
    const totalAvailableGap = plantsWithGaps.reduce(
      (sum, plant) => sum + (plant.totalAvailableGap || 0),
      0
    );
    const totalSubtypes = plantsWithGaps.reduce(
      (sum, plant) => sum + (plant.subtypes?.length || 0),
      0
    );

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      plants: plantsWithGaps,
      summary: {
        totalPlants: plantsWithGaps.length,
        totalSubtypes,
        totalBookingGap: isBoard ? totalBookingGap : available === "true" ? 0 : totalBookingGap,
        totalAvailableGap: isBoard ? totalAvailableGap : available === "true" ? totalAvailableGap : 0,
      },
      mode: isBoard ? "board" : available === "true" ? "available" : "critical",
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("Error fetching plants gap summary:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching plants gap summary",
      error: error.message,
    });
  }
};

// NEW API: Get Slot Orders Summary (orders for a specific slot)
export const getSlotOrdersSummary = async (req, res) => {
  try {
    const { slotId } = req.params;

    if (!slotId || !mongoose.Types.ObjectId.isValid(slotId)) {
      return res.status(400).json({
        success: false,
        message: "Valid slot ID is required",
      });
    }

    // Get orders for this slot (exclude cancelled/rejected and dealer quota)
    const orders = await Order.aggregate([
      {
        $match: {
          bookingSlot: new mongoose.Types.ObjectId(slotId),
          orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
          $or: [
            { quotaSource: { $ne: "dealer" } },
            { quotaSource: { $exists: false } }
          ]
        }
      },
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer"
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName"
        }
      },
      {
        $unwind: { path: "$farmer", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$salesPerson", preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: "$plantName", preserveNullAndEmptyArrays: true }
      },
      {
        $project: {
          _id: 1,
          orderId: 1,
          numberOfPlants: 1,
          rate: 1,
          orderStatus: 1,
          orderPaymentStatus: 1,
          deliveryDate: 1,
          createdAt: 1,
          additionalPlants: 1,
          sowingDone: 1,
          sowingDoneAt: 1,
          sowingDoneRequestId: 1,
          bookingSlot: 1,
          farmer: {
            _id: { $ifNull: ["$farmer._id", null] },
            name: { $ifNull: ["$farmer.name", "Unknown"] },
            mobileNumber: { $ifNull: ["$farmer.mobileNumber", ""] },
            village: { $ifNull: ["$farmer.village", ""] },
            taluka: { $ifNull: ["$farmer.taluka", ""] },
            district: { $ifNull: ["$farmer.district", ""] },
          },
          salesPerson: {
            _id: { $ifNull: ["$salesPerson._id", null] },
            name: { $ifNull: ["$salesPerson.name", "Unknown"] },
            phoneNumber: { $ifNull: ["$salesPerson.phoneNumber", ""] },
          },
          plantName: { $ifNull: ["$plantName.name", "Unknown"] },
        }
      },
      {
        $sort: { createdAt: -1 }
      }
    ]);

    // Calculate summary
    const totalOrders = orders.length;
    const totalPlants = orders.reduce(
      (sum, order) =>
        sum +
        (order.numberOfPlants || 0) +
        (order.additionalPlants || 0),
      0
    );
    const totalValue = orders.reduce((sum, order) => sum + ((order.numberOfPlants || 0) * (order.rate || 0)), 0);
    const pendingPaymentCount = orders.filter(o => o.orderPaymentStatus === "PENDING").length;
    const completedPaymentCount = orders.filter(o => o.orderPaymentStatus === "COMPLETED").length;
    const sowedOrdersCount = orders.filter((o) => o.sowingDone).length;

    // Get slot info + sow batches
    const slotInfo = await PlantSlot.aggregate([
      {
        $unwind: "$subtypeSlots"
      },
      {
        $unwind: "$subtypeSlots.slots"
      },
      {
        $match: {
          "subtypeSlots.slots._id": new mongoose.Types.ObjectId(slotId)
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
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
          slot: "$subtypeSlots.slots"
        }
      },
      {
        $project: {
          plantId: "$plantId",
          plantName: { $ifNull: ["$plantInfo.name", "Unknown"] },
          subtypeId: "$subtypeSlots.subtypeId",
          slot: {
            _id: "$slot._id",
            startDay: "$slot.startDay",
            endDay: "$slot.endDay",
            month: "$slot.month",
            year: "$slot.year",
            totalPlants: { $ifNull: ["$slot.totalPlants", 0] },
            availablePlants: { $ifNull: ["$slot.availablePlants", 0] },
            orderReservedPlants: { $ifNull: ["$slot.orderReservedPlants", 0] },
            excessivePlants: {
              $ifNull: ["$slot.excessiveSowing.plants", 0],
            },
            primarySowed: { $ifNull: ["$slot.primarySowed", 0] },
            officeSowed: { $ifNull: ["$slot.officeSowed", 0] },
            plantsSowed: { $ifNull: ["$slot.plantsSowed", 0] },
            sowingDate: "$slot.sowingDate",
            plantReadyDate: "$slot.plantReadyDate",
            plantReadyDays: { $ifNull: ["$slot.plantReadyDays", 0] },
            sowingBatches: { $ifNull: ["$slot.sowingBatches", []] },
          }
        }
      }
    ]);

    const slot = slotInfo[0]?.slot || null;
    const sowBatches = Array.isArray(slot?.sowingBatches)
      ? [...slot.sowingBatches].sort(
          (a, b) =>
            new Date(b.sowedAt || 0).getTime() -
            new Date(a.sowedAt || 0).getTime()
        )
      : [];
    const totalSowedPlants = sowBatches.reduce(
      (s, b) => s + (Number(b.plantsSowed) || 0),
      0
    );
    const totalPacketsUsed = sowBatches.reduce(
      (s, b) => s + (Number(b.packetsUsed) || 0),
      0
    );
    const orderReservedPlants =
      Number(slot?.orderReservedPlants) ||
      sowBatches.reduce(
        (s, b) => s + (Number(b.orderCoveredPlants) || 0),
        0
      );
    const availableForSale = Number(slot?.availablePlants) || 0;
    const excessivePlants = Number(slot?.excessivePlants) || 0;

    // Covered orders reserved on THIS ready slot (booking may be prev/next)
    const batchReqIds = [
      ...new Set(
        sowBatches
          .map((b) => b.sowingRequestId)
          .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
          .map((id) => String(id))
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));

    let coveredOrders = [];
    if (batchReqIds.length) {
      coveredOrders = await Order.aggregate([
        {
          $match: {
            sowingDone: true,
            sowingDoneRequestId: { $in: batchReqIds },
            orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
          },
        },
        {
          $lookup: {
            from: "farmers",
            localField: "farmer",
            foreignField: "_id",
            as: "farmer",
          },
        },
        { $unwind: { path: "$farmer", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "plantslots",
            let: { bid: "$bookingSlot" },
            pipeline: [
              { $unwind: "$subtypeSlots" },
              { $unwind: "$subtypeSlots.slots" },
              {
                $match: {
                  $expr: { $eq: ["$subtypeSlots.slots._id", "$$bid"] },
                },
              },
              {
                $project: {
                  startDay: "$subtypeSlots.slots.startDay",
                  endDay: "$subtypeSlots.slots.endDay",
                  month: "$subtypeSlots.slots.month",
                  year: "$subtypeSlots.slots.year",
                },
              },
              { $limit: 1 },
            ],
            as: "bookingSlotMeta",
          },
        },
        {
          $project: {
            _id: 1,
            orderId: 1,
            numberOfPlants: 1,
            additionalPlants: 1,
            deliveryDate: 1,
            sowingDone: 1,
            sowingDoneAt: 1,
            sowingDoneRequestId: 1,
            bookingSlot: 1,
            farmer: {
              name: { $ifNull: ["$farmer.name", "Unknown"] },
              mobileNumber: { $ifNull: ["$farmer.mobileNumber", ""] },
            },
            bookingSlotMeta: { $arrayElemAt: ["$bookingSlotMeta", 0] },
          },
        },
        { $sort: { deliveryDate: 1, orderId: 1 } },
      ]);
    }

    const readySlotLabel =
      slot?.startDay === slot?.endDay || !slot?.endDay
        ? slot?.startDay || slot?.plantReadyDate || "—"
        : `${slot?.startDay || "—"} → ${slot?.endDay || "—"}`;

    const coveredMapped = coveredOrders.map((o) => {
      const plants =
        (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const bm = o.bookingSlotMeta;
      const bookedLabel = bm?.startDay
        ? bm.startDay === bm.endDay || !bm.endDay
          ? bm.startDay
          : `${bm.startDay} → ${bm.endDay}`
        : null;
      const bookedHere =
        o.bookingSlot && String(o.bookingSlot) === String(slotId);
      return {
        ...o,
        plants,
        farmerName: o.farmer?.name || "Unknown",
        farmerMobile: o.farmer?.mobileNumber || "",
        tab: "reserved",
        statusKey: "reserved_here",
        statusLabel: "Reserved here",
        bookedOnThisSlot: bookedHere,
        bookingSlotLabel: bookedLabel,
        reservedOnReadyLabel: readySlotLabel,
      };
    });

    // Resolve ready-slot label for sowed orders booked here but reserved elsewhere
    const sowedElsewhereReqIds = [
      ...new Set(
        orders
          .filter((o) => o.sowingDone && o.sowingDoneRequestId)
          .map((o) => String(o.sowingDoneRequestId))
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));

    const readyLabelByReq = new Map();
    if (sowedElsewhereReqIds.length) {
      const readyRows = await PlantSlot.aggregate([
        {
          $match: {
            "subtypeSlots.slots.sowingBatches.sowingRequestId": {
              $in: sowedElsewhereReqIds,
            },
          },
        },
        { $unwind: "$subtypeSlots" },
        { $unwind: "$subtypeSlots.slots" },
        { $unwind: "$subtypeSlots.slots.sowingBatches" },
        {
          $match: {
            "subtypeSlots.slots.sowingBatches.sowingRequestId": {
              $in: sowedElsewhereReqIds,
            },
          },
        },
        {
          $project: {
            reqId: "$subtypeSlots.slots.sowingBatches.sowingRequestId",
            startDay: "$subtypeSlots.slots.startDay",
            endDay: "$subtypeSlots.slots.endDay",
            plantReadyDate: {
              $ifNull: [
                "$subtypeSlots.slots.sowingBatches.plantReadyDate",
                "$subtypeSlots.slots.plantReadyDate",
              ],
            },
          },
        },
      ]);
      for (const r of readyRows) {
        const key = String(r.reqId);
        if (readyLabelByReq.has(key)) continue;
        const label =
          r.plantReadyDate ||
          (r.startDay === r.endDay || !r.endDay
            ? r.startDay
            : `${r.startDay} → ${r.endDay}`);
        readyLabelByReq.set(key, label || "—");
      }
    }

    const bookedMapped = orders.map((o) => {
      const plants =
        (Number(o.numberOfPlants) || 0) + (Number(o.additionalPlants) || 0);
      const coveredHere = coveredMapped.some(
        (c) => String(c._id) === String(o._id)
      );
      let statusKey = "need_sow";
      let statusLabel = "Need sow";
      let reservedOnReadyLabel = null;
      if (o.sowingDone) {
        if (coveredHere) {
          statusKey = "reserved_here";
          statusLabel = "Reserved here";
          reservedOnReadyLabel = readySlotLabel;
        } else {
          statusKey = "reserved_elsewhere";
          reservedOnReadyLabel =
            readyLabelByReq.get(String(o.sowingDoneRequestId)) || null;
          statusLabel = reservedOnReadyLabel
            ? `Sowed · reserved on ${reservedOnReadyLabel}`
            : "Sowed";
        }
      }
      return {
        ...o,
        plants,
        farmerName: o.farmer?.name || "Unknown",
        farmerMobile: o.farmer?.mobileNumber || "",
        tab: o.sowingDone ? "booked_sowed" : "pending",
        statusKey,
        statusLabel,
        reservedOnReadyLabel,
        bookedOnThisSlot: true,
      };
    });

    const pendingOrders = bookedMapped.filter((o) => !o.sowingDone);
    const pendingPlants = pendingOrders.reduce(
      (s, o) => s + (Number(o.plants) || 0),
      0
    );
    const coveredPlants = coveredMapped.reduce(
      (s, o) => s + (Number(o.plants) || 0),
      0
    );

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      slotInfo: slotInfo[0] || null,
      sowBatches,
      orders: bookedMapped,
      pendingOrders,
      coveredOrders: coveredMapped,
      summary: {
        totalOrders,
        totalPlants,
        totalValue,
        pendingPaymentCount,
        completedPaymentCount,
        sowedOrdersCount,
        pendingOrdersCount: pendingOrders.length,
        pendingPlants,
        coveredOrdersCount: coveredMapped.length,
        coveredPlants,
        orderReservedPlants,
        availablePlants: availableForSale,
        availableForSale,
        excessivePlants,
        totalSowedPlants:
          totalSowedPlants ||
          (Number(slot?.primarySowed) || 0) + (Number(slot?.officeSowed) || 0),
        totalPacketsUsed,
        sowingDate: slot?.sowingDate || null,
        plantReadyDate: slot?.plantReadyDate || null,
        plantReadyDays: slot?.plantReadyDays || 0,
        readySlotLabel,
      },
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("Error fetching slot orders summary:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching slot orders summary",
      error: error.message,
    });
  }
};

// NEW API: Get Today's Sowing Data (All plants with due and current day entries)
export const getTodaySowingData = async (req, res) => {
  try {
    const today = moment().startOf("day");
    const todayDate = today.toDate();

    // Get all plants with sowingAllowed = true
    const plants = await PlantCms.find({ sowingAllowed: true })
      .select("_id name subtypes")
      .lean();

    if (!plants || plants.length === 0) {
      return res.status(200).json({
        success: true,
        plants: [],
        summary: {
          totalPlants: 0,
          totalSubtypes: 0,
          totalDueGap: 0,
          totalTodayGap: 0,
          dueSlots: 0,
          todaySlots: 0,
        },
        generatedAt: new Date(),
      });
    }

    // Get today's sowing data for all plants
    const plantsWithTodayData = await Promise.all(
      plants.map(async (plant) => {
        // Get slots with sowByDate = today or overdue (due)
        const todaySlots = await PlantSlot.aggregate([
          {
            $match: {
              plantId: new mongoose.Types.ObjectId(plant._id),
            },
          },
          {
            $unwind: "$subtypeSlots",
          },
          {
            $unwind: "$subtypeSlots.slots",
          },
          {
            $lookup: {
              from: "plantcms",
              localField: "plantId",
              foreignField: "_id",
              as: "plantInfo",
            },
          },
          {
            $addFields: {
              plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
            },
          },
          {
            $match: {
              "plantInfo.sowingAllowed": true,
            },
          },
          {
            $addFields: {
              subtypeDetails: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: { $ifNull: ["$plantInfo.subtypes", []] },
                      as: "subtype",
                      cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                    },
                  },
                  0,
                ],
              },
              slotId: "$subtypeSlots.slots._id",
              primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
              totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
              slotReadyDays: {
                $cond: [
                  { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
                  "$subtypeSlots.slots.plantReadyDays",
                  { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
                ],
              },
            },
          },
          // Calculate totalBookedPlants from orders
          {
            $lookup: {
              from: "orders",
              let: { slotId: "$slotId" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$bookingSlot", "$$slotId"] },
                        { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                        {
                          $or: [
                            { $ne: ["$quotaSource", "dealer"] },
                            { $not: { $ifNull: ["$quotaSource", false] } }
                          ]
                        }
                      ]
                    }
                  }
                },
                {
                  $group: {
                    _id: null,
                    totalBookedPlants: { $sum: "$numberOfPlants" }
                  }
                }
              ],
              as: "orderStats"
            }
          },
          {
            $addFields: {
              totalBookedPlants: {
                $ifNull: [
                  { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
                  0
                ]
              }
            }
          },
          {
            $project: {
              orderStats: 0
            }
          },
          {
            $addFields: {
              bookingGap: {
                $subtract: ["$totalBookedPlants", "$primarySowed"],
              },
              slotEndISO: {
                $dateFromString: {
                  dateString: {
                    $concat: [
                      { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                      "-",
                      { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                      "-",
                      { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                    ],
                  },
                  format: "%Y-%m-%d",
                },
              },
            },
          },
          {
            $addFields: {
              sowByDateISO: {
                $cond: [
                  { $gt: ["$slotReadyDays", 0] },
                  {
                    $dateSubtract: {
                      startDate: "$slotEndISO",
                      unit: "day",
                      amount: "$slotReadyDays",
                    },
                  },
                  "$slotEndISO",
                ],
              },
            },
          },
          {
            $addFields: {
              daysUntilSow: {
                $round: [
                  {
                    $divide: [
                      { $subtract: ["$sowByDateISO", todayDate] },
                      1000 * 60 * 60 * 24,
                    ],
                  },
                  0,
                ],
              },
              sowByDate: {
                $dateToString: {
                  date: "$sowByDateISO",
                  format: "%d-%m-%Y",
                },
              },
            },
          },
          // Filter: only today (daysUntilSow === 0) or overdue (daysUntilSow < 0)
          {
            $match: {
              daysUntilSow: { $lte: 0 }, // Today or overdue
              bookingGap: { $gt: 0 }, // Only positive gaps (needs sowing)
            },
          },
          {
            $addFields: {
              priority: {
                $cond: [
                  { $lt: ["$daysUntilSow", 0] },
                  "due", // Overdue
                  "today", // Current day
                ],
              },
            },
          },
          {
            $project: {
              _id: "$subtypeSlots.slots._id",
              slotId: "$subtypeSlots.slots._id",
              subtypeId: "$subtypeSlots.subtypeId",
              subtypeName: { $ifNull: ["$subtypeDetails.name", "Subtype"] },
              slotStartDay: "$subtypeSlots.slots.startDay",
              slotEndDay: "$subtypeSlots.slots.endDay",
              month: "$subtypeSlots.slots.month",
              totalBookedPlants: 1,
              primarySowed: 1,
              totalPlants: 1,
              bookingGap: 1,
              sowByDate: 1,
              daysUntilSow: 1,
              priority: 1,
              plantReadyDays: "$slotReadyDays",
            },
          },
        ]);

        // Group by subtype
        const subtypeMap = new Map();
        
        todaySlots.forEach((slot) => {
          const subtypeKey = slot.subtypeId.toString();
          
          if (!subtypeMap.has(subtypeKey)) {
            subtypeMap.set(subtypeKey, {
              _id: slot.subtypeId,
              subtypeName: slot.subtypeName,
              dueGap: 0,
              todayGap: 0,
              dueSlots: 0,
              todaySlots: 0,
              slots: [],
            });
          }
          
          const subtype = subtypeMap.get(subtypeKey);
          subtype.slots.push(slot);
          
          if (slot.priority === "due") {
            subtype.dueGap += slot.bookingGap || 0;
            subtype.dueSlots += 1;
          } else {
            subtype.todayGap += slot.bookingGap || 0;
            subtype.todaySlots += 1;
          }
        });

        const subtypes = Array.from(subtypeMap.values());

        // Calculate plant totals
        const plantDueGap = subtypes.reduce((sum, st) => sum + st.dueGap, 0);
        const plantTodayGap = subtypes.reduce((sum, st) => sum + st.todayGap, 0);
        const plantDueSlots = subtypes.reduce((sum, st) => sum + st.dueSlots, 0);
        const plantTodaySlots = subtypes.reduce((sum, st) => sum + st.todaySlots, 0);

        return {
          _id: plant._id,
          plantName: plant.name,
          subtypes,
          dueGap: plantDueGap,
          todayGap: plantTodayGap,
          dueSlots: plantDueSlots,
          todaySlots: plantTodaySlots,
          totalGap: plantDueGap + plantTodayGap,
          totalSlots: plantDueSlots + plantTodaySlots,
        };
      })
    );

    // Filter out plants with no slots
    const plantsWithData = plantsWithTodayData.filter(
      (plant) => plant.totalSlots > 0
    );

    // Sort by total gap (highest first)
    plantsWithData.sort((a, b) => b.totalGap - a.totalGap);

    // Calculate overall summary
    const summary = {
      totalPlants: plantsWithData.length,
      totalSubtypes: plantsWithData.reduce(
        (sum, plant) => sum + plant.subtypes.length,
        0
      ),
      totalDueGap: plantsWithData.reduce((sum, plant) => sum + plant.dueGap, 0),
      totalTodayGap: plantsWithData.reduce(
        (sum, plant) => sum + plant.todayGap,
        0
      ),
      totalGap: plantsWithData.reduce((sum, plant) => sum + plant.totalGap, 0),
      dueSlots: plantsWithData.reduce((sum, plant) => sum + plant.dueSlots, 0),
      todaySlots: plantsWithData.reduce((sum, plant) => sum + plant.todaySlots, 0),
      totalSlots: plantsWithData.reduce((sum, plant) => sum + plant.totalSlots, 0),
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      plants: plantsWithData,
      summary,
      date: today.format("DD-MM-YYYY"),
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("Error fetching today's sowing data:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching today's sowing data",
      error: error.message,
    });
  }
};

// NEW API: Get All Plants Today Sowing Cards (Flat structure with subtype cards, today + overdue only) - OPTIMIZED
export const getAllPlantsTodaySowingCards = async (req, res) => {
  try {
    const today = moment().startOf("day");
    const todayDate = today.toDate();

    // Get all plants with sowingAllowed = true (including sowingBuffer) - single query
    const plants = await PlantCms.find({ sowingAllowed: true })
      .select("_id name subtypes sowingBuffer")
      .lean();

    if (!plants || plants.length === 0) {
      return res.status(200).json({
        success: true,
        subtypeCards: [],
        inProgressCards: [],
        availablePackets: [],
        summary: {
          totalPlants: 0,
          totalSubtypes: 0,
          totalDueGap: 0,
          totalTodayGap: 0,
          dueSlots: 0,
          todaySlots: 0,
        },
        generatedAt: new Date(),
      });
    }

    const plantIds = plants.map(p => p._id);
    const plantMap = new Map(plants.map(p => [p._id.toString(), p]));

    // Batch fetch all products for all plants at once
    const products = await Product.find({
      plantId: { $in: plantIds },
      category: { $regex: /^seeds$/i },
      isActive: true,
    })
      .select("plantId subtypeId conversionFactor secondaryUnit primaryUnit _id")
      .populate("secondaryUnit", "name symbol")
      .populate("primaryUnit", "name symbol")
      .lean();

    // Create product map: key = "plantId-subtypeId"
    const productMap = new Map();
    products.forEach(p => {
      const key = `${p.plantId}-${p.subtypeId}`;
      productMap.set(key, p);
    });

    // Batch fetch all batches for all products at once
    const productIds = products.map(p => p._id);
    const batches = await Batch.find({
      product: { $in: productIds },
      status: "active",
      remainingQuantity: { $gt: 0 },
    })
      .select("product remainingQuantity unit")
      .populate("unit", "name symbol _id")
      .lean();

    // Group batches by product
    const batchMap = new Map();
    batches.forEach(batch => {
      const productId = batch.product.toString();
      if (!batchMap.has(productId)) {
        batchMap.set(productId, []);
      }
      batchMap.get(productId).push(batch);
    });

    // Step 1: Get all slots with their data - FAST aggregation with PlantCMS lookup for plantReadyDays
    const allSlots = await PlantSlot.aggregate([
      {
        $match: {
          plantId: { $in: plantIds },
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          slotReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
          // Get slotBuffer from subtype (buffer field in PlantCMS subtype)
          slotBuffer: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.buffer", 0] }, 0] },
              "$subtypeSlots.slots.buffer",
              { $ifNull: ["$subtypeDetails.buffer", 0] },
            ],
          },
        },
      },
      {
        $project: {
          plantId: 1,
          subtypeId: "$subtypeSlots.subtypeId",
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
          slotReadyDays: 1,
          slotBuffer: 1,
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          gapCovered: { $ifNull: ["$subtypeSlots.slots.gapCovered", []] },
          gapFullyCovered: { $ifNull: ["$subtypeSlots.slots.gapFullyCovered", false] },
        },
      },
    ]);

    // Step 2: Collect all slot IDs
    const slotIds = allSlots.map(s => s.slotId);

    // Step 2.5: Get sowing in progress details directly from slots
    // This ensures we use the correct plantsExpected calculation
    // IMPORTANT: Check ALL slots for this plant/subtype, not just those in slotIds
    // Because slots with sowingInProgress might not have bookings (yet)
    const slotsWithProgress = await PlantSlot.aggregate([
      {
        $match: {
          plantId: { $in: plantIds }, // Match by plantIds (broader scope)
        },
      },
      {
        $unwind: '$subtypeSlots',
      },
      {
        $unwind: '$subtypeSlots.slots',
      },
      {
        $match: {
          'subtypeSlots.slots.sowingInProgress': { $exists: true, $ne: [] }, // Must have sowingInProgress
        },
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          slotReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
          // Get slotBuffer from subtype (buffer field in PlantCMS subtype)
          slotBuffer: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.buffer", 0] }, 0] },
              "$subtypeSlots.slots.buffer",
              { $ifNull: ["$subtypeDetails.buffer", 0] },
            ],
          },
        },
      },
      {
        $project: {
          slotId: '$subtypeSlots.slots._id',
          sowingInProgress: '$subtypeSlots.slots.sowingInProgress',
          plantId: 1,
          subtypeId: '$subtypeSlots.subtypeId',
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
          slotReadyDays: 1,
          slotBuffer: 1,
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
          gapCovered: { $ifNull: ["$subtypeSlots.slots.gapCovered", []] },
          gapFullyCovered: { $ifNull: ["$subtypeSlots.slots.gapFullyCovered", false] },
        },
      },
    ]);

    // Create map of slot IDs with sowing in progress details from slot data
    const sowingInProgressMap = new Map();
    slotsWithProgress.forEach(slotData => {
      const slotIdStr = slotData.slotId.toString();
      const plantIdStr = slotData.plantId?.toString();
      const subtypeIdStr = slotData.subtypeId?.toString();
      const productKeyForProgress = `${plantIdStr}-${subtypeIdStr}`;
      const productForProgress = productMap.get(productKeyForProgress);
      const cfProgress = resolveSowingPlantsPerPacket(productForProgress || {});
      const progressDetails = (slotData.sowingInProgress || []).map((prog) => {
        const packetsIssued = prog.packetsIssued || 0;
        const plantsExpected = prog.plantsExpected || 0;
        // If plantsExpected is 0 but packets were issued (e.g. gap math), derive expected plants for UI / inProgressCards
        const remainingPlants =
          plantsExpected > 0
            ? plantsExpected
            : packetsIssued > 0
              ? packetsIssued * cfProgress
              : 0;
        return {
          packetsIssued,
          remainingPlants,
          plantsExpected,
          outwardId: prog.outwardId || null,
          isExcessiveSowing: prog.isExcessiveSowing || false,
          requestNumber: prog.requestNumber,
          sowingRequestId: prog.sowingRequestId,
        };
      });
      if (progressDetails.length > 0) {
        sowingInProgressMap.set(slotIdStr, progressDetails);
      }
    });
    
    // Create a map of existing slots by slotId for quick lookup
    const existingSlotsMap = new Map();
    allSlots.forEach(slot => {
      existingSlotsMap.set(slot.slotId.toString(), slot);
    });
    
    // Merge slots with sowingInProgress into allSlots if they're not already there
    slotsWithProgress.forEach(slotData => {
      const slotIdStr = slotData.slotId.toString();
      if (!existingSlotsMap.has(slotIdStr)) {
        // Add this slot to allSlots with full data
        allSlots.push({
          plantId: slotData.plantId,
          subtypeId: slotData.subtypeId,
          slotId: slotData.slotId,
          primarySowed: slotData.primarySowed || 0,
          totalPlants: slotData.totalPlants || 0,
          slotReadyDays: slotData.slotReadyDays || 0,
          slotBuffer: slotData.slotBuffer || 0, // Include slotBuffer
          slotStartDay: slotData.slotStartDay,
          slotEndDay: slotData.slotEndDay,
          month: slotData.month,
          gapCovered: slotData.gapCovered || [],
          gapFullyCovered: slotData.gapFullyCovered || false,
        });
        existingSlotsMap.set(slotIdStr, slotData);
      }
    });
    
    // Also add these slotIds to the main slotIds array if they're not already there
    // This ensures slots with sowingInProgress are included even if they don't have bookings
    slotsWithProgress.forEach(slotData => {
      const slotId = slotData.slotId;
      if (!slotIds.find(id => id.toString() === slotId.toString())) {
        slotIds.push(slotId);
      }
    });

    // Step 3: Single aggregation on orders to get all bookings grouped by slot - MUCH FASTER
    const orderBookings = await Order.aggregate([
      {
        $match: {
          bookingSlot: { $in: slotIds },
          orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
          $or: [
            { quotaSource: { $ne: "dealer" } },
            { quotaSource: { $exists: false } },
            { quotaSource: null },
          ],
        },
      },
      {
        $group: {
          _id: "$bookingSlot",
          totalBookedPlants: { $sum: "$numberOfPlants" },
        },
      },
    ]);

    // Step 4: Create booking map for fast lookup
    const bookingMap = new Map();
    orderBookings.forEach(booking => {
      bookingMap.set(booking._id.toString(), booking.totalBookedPlants);
    });

    // Step 5: Join slots with bookings in memory and calculate dates/gaps
    const allTodaySlots = allSlots.map(slot => {
      const slotIdStr = slot.slotId.toString();
      const totalBookedPlants = bookingMap.get(slotIdStr) || 0;
      const primarySowed = slot.primarySowed || 0;
      
      // Calculate gap covered by later slots
      const gapCoveredAmount = (slot.gapCovered || []).reduce((sum, coverage) => {
        return sum + (coverage.plantsCovered || 0);
      }, 0);
      
      // Calculate raw gap and effective gap
      const rawBookingGap = totalBookedPlants - primarySowed;
      const bookingGap = Math.max(0, rawBookingGap - gapCoveredAmount); // Gap after coverage
      
      // Parse slot start date (countdown is now based on slot start)
      const startDayParts = slot.slotStartDay?.match(/(\d{2})-(\d{2})-(\d{4})/);
      const slotStartISO = startDayParts
        ? new Date(`${startDayParts[3]}-${startDayParts[2]}-${startDayParts[1]}`)
        : null;
      
      // Calculate sowByDateISO
      // slotReadyDays is already set from aggregation (slot-level first, then PlantCMS fallback)
      const slotReadyDays = slot.slotReadyDays || 0;
      
      let sowByDateISO = null;
      if (slotStartISO) {
        if (slotReadyDays > 0) {
          // Calculate: sowByDate = slotStartDate - plantReadyDays
          sowByDateISO = new Date(slotStartISO.getTime() - slotReadyDays * 24 * 60 * 60 * 1000);
        } else {
          // If no plantReadyDays configured, use slotStartDate as sowByDate (fallback)
          sowByDateISO = slotStartISO;
        }
      }
      
      // Calculate daysUntilSow (negative = overdue, 0 = today, positive = future)
      const daysUntilSow = sowByDateISO
        ? Math.round((sowByDateISO - todayDate) / (1000 * 60 * 60 * 24))
        : null;
      
      // Format sowByDate
      const sowByDate = sowByDateISO
        ? moment(sowByDateISO).format("DD-MM-YYYY")
        : null;
      
      // Determine priority: "due" for overdue, "urgent" for urgent (today only)
      // Urgent slots: daysUntilSow === 0 (today)
      // Overdue slots: daysUntilSow < 0
      const priority = daysUntilSow !== null
        ? (daysUntilSow < 0 ? "due" : (daysUntilSow === 0 ? "urgent" : null))
        : null;
      
      // Debug logging for Twinkle, Vijay, and Vivek subtypes to verify calculation
      if (slot.subtypeId && slot.plantId) {
        const plant = plantMap.get(slot.plantId.toString());
        const subtypes = plant?.subtypes || [];
        const subtypeDetails = subtypes.find(st => st._id.toString() === slot.subtypeId.toString());
        const plantName = plant?.name?.toLowerCase() || "";
        const subtypeName = subtypeDetails?.name?.toLowerCase() || "";
        
        if (subtypeName.includes("twinkle") || (plantName.includes("muskmelon") && (subtypeName.includes("vijay") || subtypeName.includes("vivek")))) {
        }
      }
      
      // Check if sowing is in progress for this slot (use slotIdStr already declared above)
      const sowingProgress = sowingInProgressMap.get(slotIdStr);
      
      // Calculate adjusted booking gap if sowing in progress
      let adjustedBookingGap = bookingGap;
      let totalPacketsIssued = 0;
      let totalPlantsInProgress = 0;
      
      if (sowingProgress && sowingProgress.length > 0) {
        // Sum up all plants that are in progress (coerce — avoid NaN if a field is missing)
        totalPlantsInProgress = sowingProgress.reduce(
          (sum, prog) => sum + (Number(prog.remainingPlants) || 0),
          0
        );
        totalPacketsIssued = sowingProgress.reduce(
          (sum, prog) => sum + (Number(prog.packetsIssued) || 0),
          0
        );
        
        // Reduce the booking gap by plants that have stock issued
        adjustedBookingGap = Math.max(0, bookingGap - totalPlantsInProgress);
      }
      
      // Buffer priority for today-sowing counts:
      // 1) subtype/slot buffer when configured
      // 2) plant-level sowingBuffer fallback
      const plantLevelSowingBuffer = plantMap.get(slot.plantId?.toString())?.sowingBuffer || 0;
      const slotBuffer = Number(slot.slotBuffer) || 0;
      const effectiveSowingBuffer = slotBuffer > 0 ? slotBuffer : plantLevelSowingBuffer;
      
      // Apply effective sowing buffer to the adjusted booking gap
      const bookingGapWithBuffer = effectiveSowingBuffer > 0 && adjustedBookingGap > 0
        ? Math.round(adjustedBookingGap * (1 + effectiveSowingBuffer / 100))
        : adjustedBookingGap;
      
      // Calculate buffer count (additional plants added by slot buffer)
      const slotBufferCount = bookingGapWithBuffer - adjustedBookingGap;
      
      // Apply effective sowing buffer to totalBookedPlants
      const totalBookedPlantsWithBuffer = effectiveSowingBuffer > 0 && totalBookedPlants > 0
        ? Math.round(totalBookedPlants * (1 + effectiveSowingBuffer / 100))
        : totalBookedPlants;
      
      // Calculate buffer amount for totalBookedPlants
      const totalBookedPlantsBufferCount = totalBookedPlantsWithBuffer - totalBookedPlants;
      
      // Calculate plants to sow with buffer: totalBookedPlantsWithBuffer - primarySowed
      const plantsToSowWithBuffer = Math.max(0, totalBookedPlantsWithBuffer - primarySowed);
      
      // Debug logging for December 24 slots - comprehensive details
      if (slot.slotEndDay && slot.slotEndDay.includes("24-12-2025")) {
        const plant = plantMap.get(slot.plantId.toString());
        const subtypes = plant?.subtypes || [];
        const subtypeDetails = subtypes.find(st => st._id.toString() === slot.subtypeId.toString());
        const plantName = plant?.name || "";
        const subtypeName = subtypeDetails?.name || "";
      }
      
      // Debug logging for December 3 slots
      if (slot.slotEndDay && slot.slotEndDay.includes("03-12-2025")) {
        const plant = plantMap.get(slot.plantId.toString());
        const subtypes = plant?.subtypes || [];
        const subtypeDetails = subtypes.find(st => st._id.toString() === slot.subtypeId.toString());
        const plantName = plant?.name || "";
        const subtypeName = subtypeDetails?.name || "";
      }
      
      return {
        _id: slot.slotId,
        slotId: slot.slotId,
        plantId: slot.plantId,
        subtypeId: slot.subtypeId,
        slotStartDay: slot.slotStartDay,
        slotEndDay: slot.slotEndDay,
        month: slot.month,
        totalBookedPlants,
        totalBookedPlantsWithBuffer, // Total booked plants with slot buffer applied
        totalBookedPlantsBufferCount, // Additional plants added by slot buffer to totalBookedPlants
        primarySowed,
        displaySowingQty: plantsToSowWithBuffer,
        baseSowingQty: adjustedBookingGap,
        plantsToSowWithBuffer, // Plants to sow with buffer (totalBookedPlantsWithBuffer - primarySowed)
        totalPlants: slot.totalPlants,
        bookingGap: bookingGapWithBuffer, // Show gap with slot buffer applied
        bookingGapRaw: rawBookingGap, // Original gap before coverage
        bookingGapEffective: bookingGap, // Gap after gapCovered (before in-progress)
        bookingGapBeforeBuffer: adjustedBookingGap, // Gap after in-progress but before buffer
        slotBuffer: effectiveSowingBuffer, // Effective sowing buffer (subtype buffer, else plant sowingBuffer)
        slotBufferCount: slotBufferCount, // Additional plants added by slot buffer
        gapCovered: slot.gapCovered || [], // Gap coverage details
        gapCoveredAmount, // Total covered by later slots
        gapFullyCovered: slot.gapFullyCovered || false, // Is fully covered
        sowByDate,
        daysUntilSow,
        priority,
        plantReadyDays: slotReadyDays,
        sowingInProgress: sowingProgress ? true : false,
        sowingProgressDetails: sowingProgress || null,
        totalPacketsIssued,
        totalPlantsInProgress,
      };
    });

    // Separate slots into two categories:
    // 1. Slots with plantsToSowWithBuffer > 0 AND NOT in progress (need action) - show in main cards
    // 2. Slots with sowing in progress (just tracking) - show separately in inProgressCards
    const slotsNeedingAction = allTodaySlots.filter(slot => {
      // CRITICAL FILTER: Only show urgent (daysUntilSow === 0) and overdue (daysUntilSow < 0) slots
      // Urgent: daysUntilSow === 0 (today only)
      // Overdue: daysUntilSow < 0
      // Exclude: daysUntilSow > 0 (future slots) or daysUntilSow === null
      if (slot.daysUntilSow === null || slot.daysUntilSow > 0) {
        // Debug log for excluded future slots
        if (slot.daysUntilSow !== null && slot.daysUntilSow > 0) {
        }
        return false;
      }
      // ✅ EXCLUDE slots that are in progress (they'll be shown in inProgressCards instead)
      // Count either plants or issued packets (gap math can yield 0 plants with packets > 0)
      if (slot.sowingInProgress) {
        const pip = Number(slot.totalPlantsInProgress) || 0;
        const pkt = Number(slot.totalPacketsIssued) || 0;
        if (pip > 0 || pkt > 0) {
          return false;
        }
      }
      // ✅ Filter: Show slots where plantsToSowWithBuffer > 0
      // Must still be urgent/overdue (already checked above) AND not in progress (checked above)
      const hasPlantsToSow = (slot.plantsToSowWithBuffer || 0) > 0;
      if (!hasPlantsToSow) {
        return false;
      }
      // Additional validation: ensure priority is set correctly
      if (slot.priority === null && slot.daysUntilSow !== null) {
      }
      return true;
    });
    slotsNeedingAction.forEach(slot => {
      const plant = plantMap.get(slot.plantId?.toString());
      const plantName = plant?.name?.toLowerCase() || "";
      const subtypes = plant?.subtypes || [];
      const subtypeDetails = subtypes.find(st => st._id.toString() === slot.subtypeId?.toString());
      const subtypeName = subtypeDetails?.name?.toLowerCase() || "";
      const isMuskmelonVijay = plantName.includes("muskmelon") && subtypeName.includes("vijay");
      
      if (isMuskmelonVijay) {
      } else {
      }
    });

    const slotsInProgressOnly = allTodaySlots.filter(slot => {
      // Slots with sowingInProgress: show if either plants or issued packets remain (gap math can yield 0 plants)
      if (!slot.sowingInProgress) {
        return false;
      }
      const plantsInProgress = Number(slot.totalPlantsInProgress) || 0;
      const packetsIssued = Number(slot.totalPacketsIssued) || 0;
      if (plantsInProgress <= 0 && packetsIssued <= 0) {
        return false;
      }
      return true;
    });
    slotsInProgressOnly.forEach(slot => {
    });
    slotsInProgressOnly.forEach(slot => {
    });

    // Process results and group by plant/subtype for MAIN cards (with gap)
    const subtypeCardMap = new Map();
    
    slotsNeedingAction.forEach((slot) => {
      const plantId = slot.plantId.toString();
      const subtypeId = slot.subtypeId.toString();
      const key = `${plantId}-${subtypeId}`;
      
      if (!subtypeCardMap.has(key)) {
        const plant = plantMap.get(plantId);
        const subtypes = plant?.subtypes || [];
        const subtypeDetails = subtypes.find(st => st._id.toString() === subtypeId);
        
        subtypeCardMap.set(key, {
          plantId: plantId,
          plantName: plant?.name || "Unknown",
          subtypeId: subtypeId,
          subtypeName: subtypeDetails?.name || "Subtype",
          slots: [],
          dueGap: 0,
          todayGap: 0,
          dueSlots: 0,
          todaySlots: 0,
          totalBookedPlants: 0,
          totalPrimarySowed: 0,
          sowingBuffer: plant?.sowingBuffer || 0,
        });
      }
      
      const card = subtypeCardMap.get(key);
      card.slots.push(slot);
      card.totalBookedPlants += slot.totalBookedPlants || 0;
      card.totalPrimarySowed += slot.primarySowed || 0;
      
      // Use slot.bookingGap which already includes slot-level buffer
      if (slot.priority === "due") {
        // Overdue slots - bookingGap already includes slot-level buffer
        card.dueGap += slot.bookingGap || 0;
        card.dueSlots += 1;
      } else if (slot.priority === "urgent") {
        // Urgent slots (today only) - bookingGap already includes slot-level buffer
        card.todayGap += slot.bookingGap || 0;
        card.todaySlots += 1;
      }
      // Note: slots with priority === null are excluded by the filter above
    });
    subtypeCardMap.forEach((card, key) => {
    });

    // Process each subtype card and enrich with product/batch data
    const allSubtypeCards = Array.from(subtypeCardMap.values()).map((card) => {
      const sowingBuffer = card.sowingBuffer || 0;
      
      // Get product data from pre-fetched map
      const productKey = `${card.plantId}-${card.subtypeId}`;
      const product = productMap.get(productKey);
      
      let conversionFactor = null;
      let secondaryUnit = null;
      let primaryUnit = null;
      let availablePackets = 0;
      
      if (product) {
        conversionFactor = product.conversionFactor || null;
        secondaryUnit = product.secondaryUnit || null;
        primaryUnit = product.primaryUnit || null;
        
        // Get batches from pre-fetched map
        const productBatches = batchMap.get(product._id.toString()) || [];
        
        let totalAvailable = 0;
        productBatches.forEach((batch) => {
          const batchUnitId = batch.unit?._id?.toString();
          const primaryUnitId = primaryUnit?._id?.toString();
          const secondaryUnitId = secondaryUnit?._id?.toString();

          if (batchUnitId === primaryUnitId) {
            totalAvailable += batch.remainingQuantity;
          } else if (batchUnitId === secondaryUnitId && conversionFactor) {
            totalAvailable += batch.remainingQuantity / conversionFactor;
          } else {
            totalAvailable += batch.remainingQuantity;
          }
        });
        
        availablePackets = Math.floor(totalAvailable);
      }
      
      // Apply buffer to individual slots
      // SAFETY CHECK: Filter out any future slots that might have slipped through
      // Also filter to only include slots where plantsToSowWithBuffer > 0
      const slotsWithBuffer = card.slots.filter(slot => {
        // Only include urgent (daysUntilSow === 0) and overdue (daysUntilSow < 0) slots
        if (slot.daysUntilSow === null || slot.daysUntilSow > 0) {
          const isMuskmelonVijay = card.plantName?.toLowerCase().includes("muskmelon") && card.subtypeName?.toLowerCase().includes("vijay");
          if (isMuskmelonVijay) {
          } else {
          }
          return false;
        }
        // Filter to only include slots where plantsToSowWithBuffer > 0
        const plantsToSow = (slot.plantsToSowWithBuffer || 0);
        if (plantsToSow <= 0) {
          return false;
        }
        return true;
      });
      
      // Recalculate card totals based on filtered slots (only slots with plantsToSowWithBuffer > 0)
      const recalculatedTotalBookedPlants = slotsWithBuffer.reduce((sum, slot) => sum + (slot.totalBookedPlants || 0), 0);
      const recalculatedTotalPrimarySowed = slotsWithBuffer.reduce((sum, slot) => sum + (slot.primarySowed || 0), 0);
      const recalculatedDueGap = slotsWithBuffer
        .filter(slot => slot.priority === "due")
        .reduce((sum, slot) => sum + (slot.plantsToSowWithBuffer || 0), 0);
      const recalculatedTodayGap = slotsWithBuffer
        .filter(slot => slot.priority === "urgent")
        .reduce((sum, slot) => sum + (slot.plantsToSowWithBuffer || 0), 0);
      const recalculatedTotalGap = recalculatedDueGap + recalculatedTodayGap;
      const recalculatedDueSlots = slotsWithBuffer.filter(slot => slot.priority === "due").length;
      const recalculatedTodaySlots = slotsWithBuffer.filter(slot => slot.priority === "urgent").length;
      
      // Recalculate slot buffer counts from filtered slots
      const recalculatedTotalSlotBufferCount = slotsWithBuffer.reduce((sum, slot) => {
        return sum + (slot.slotBufferCount || 0);
      }, 0);
      
      const recalculatedDueSlotBufferCount = slotsWithBuffer
        .filter(slot => slot.priority === "due")
        .reduce((sum, slot) => sum + (slot.slotBufferCount || 0), 0);
      
      const recalculatedTodaySlotBufferCount = slotsWithBuffer
        .filter(slot => slot.priority === "urgent")
        .reduce((sum, slot) => sum + (slot.slotBufferCount || 0), 0);
      
      return {
        plantId: card.plantId,
        plantName: card.plantName,
        subtypeId: card.subtypeId,
        subtypeName: card.subtypeName,
        dueGap: recalculatedDueGap, // Recalculated from filtered slots
        todayGap: recalculatedTodayGap, // Recalculated from filtered slots
        dueSlots: recalculatedDueSlots, // Recalculated from filtered slots
        todaySlots: recalculatedTodaySlots, // Recalculated from filtered slots
        totalBookedPlants: recalculatedTotalBookedPlants, // Recalculated from filtered slots
        totalPrimarySowed: recalculatedTotalPrimarySowed, // Recalculated from filtered slots
        slots: slotsWithBuffer, // Only slots with plantsToSowWithBuffer > 0
        totalGap: recalculatedTotalGap, // Recalculated from filtered slots (sum of plantsToSowWithBuffer)
        totalSlots: slotsWithBuffer.length, // Use filtered count
        sowingBuffer: sowingBuffer, // Plant-level buffer (for reference)
        slotBufferCount: recalculatedTotalSlotBufferCount, // Total slot-level buffer count from all filtered slots
        dueSlotBufferCount: recalculatedDueSlotBufferCount, // Slot-level buffer count for overdue slots
        todaySlotBufferCount: recalculatedTodaySlotBufferCount, // Slot-level buffer count for today slots
        conversionFactor: conversionFactor,
        secondaryUnit: secondaryUnit,
        primaryUnit: primaryUnit,
        availablePackets: availablePackets,
      };
    });

    // Filter cards to only include those with at least one slot where plantsToSowWithBuffer > 0
    const filteredSubtypeCards = allSubtypeCards.filter((card) => {
      if (!card.slots || card.slots.length === 0) {
        return false;
      }
      // Check if at least one slot has plantsToSowWithBuffer > 0
      return card.slots.some(slot => (slot.plantsToSowWithBuffer || 0) > 0);
    });

    // Sort by total gap (descending)
    filteredSubtypeCards.sort((a, b) => (b.totalGap || 0) - (a.totalGap || 0));

    // Process "in progress only" slots (gap = 0, but sowing in progress)
    const inProgressCardMap = new Map();
    
    slotsInProgressOnly.forEach((slot) => {
      const plantId = slot.plantId.toString();
      const subtypeId = slot.subtypeId.toString();
      const key = `${plantId}-${subtypeId}`;
      
      if (!inProgressCardMap.has(key)) {
        const plant = plantMap.get(plantId);
        const subtypes = plant?.subtypes || [];
        const subtypeDetails = subtypes.find(st => st._id.toString() === subtypeId);
        
        inProgressCardMap.set(key, {
          plantId: plantId,
          plantName: plant?.name || "Unknown",
          subtypeId: subtypeId,
          subtypeName: subtypeDetails?.name || "Subtype",
          slots: [],
          totalPacketsInProgress: 0,
          totalPlantsInProgress: 0,
        });
      }
      
      const card = inProgressCardMap.get(key);
      card.slots.push(slot);
      card.totalPacketsInProgress += slot.totalPacketsIssued || 0;
      card.totalPlantsInProgress += slot.totalPlantsInProgress || 0;
    });

    const inProgressCards = Array.from(inProgressCardMap.values()).map((card) => {
      // Get product data from pre-fetched map
      const productKey = `${card.plantId}-${card.subtypeId}`;
      const product = productMap.get(productKey);
      
      return {
        plantId: card.plantId,
        plantName: card.plantName,
        subtypeId: card.subtypeId,
        subtypeName: card.subtypeName,
        slots: card.slots,
        totalPacketsInProgress: card.totalPacketsInProgress,
        totalPlantsInProgress: card.totalPlantsInProgress,
        totalSlots: card.slots.length,
        conversionFactor: product?.conversionFactor || null,
        primaryUnit: product?.primaryUnit || null,
        secondaryUnit: product?.secondaryUnit || null,
      };
    });

    // Calculate summary using filtered cards (only cards with plantsToSowWithBuffer > 0)
    // Count plants with slot-level buffer (any slot in the card has slotBuffer > 0)
    const plantsWithSlotBuffer = new Set();
    filteredSubtypeCards.forEach(card => {
      const hasSlotBuffer = card.slots.some(slot => (slot.slotBuffer || 0) > 0);
      if (hasSlotBuffer) {
        plantsWithSlotBuffer.add(card.plantId);
      }
    });
    
    // Calculate total plantsToSowWithBuffer from all slots in all filtered cards
    const totalPlantsToSowWithBuffer = filteredSubtypeCards.reduce((sum, card) => {
      const cardTotal = (card.slots || []).reduce((slotSum, slot) => 
        slotSum + (slot.plantsToSowWithBuffer || 0), 0
      );
      return sum + cardTotal;
    }, 0);
    
    // Collect December 24 slot details for debugging/verification
    // Also get raw slot data from aggregation for comparison and direct DB query
    const dec24SlotDetails = [];
    for (const slot of allTodaySlots) {
      if (slot.slotEndDay && slot.slotEndDay.includes("24-12-2025")) {
        const plant = plantMap.get(slot.plantId?.toString());
        const subtypes = plant?.subtypes || [];
        const subtypeDetails = subtypes.find(st => st._id?.toString() === slot.subtypeId?.toString());
        
        // Find the raw slot data from allSlots aggregation
        const rawSlotData = allSlots.find(s => s.slotId?.toString() === slot.slotId?.toString());
        
        // Direct database query to get the latest value
        let directDBSlotData = null;
        try {
          const slotObjectId = new mongoose.Types.ObjectId(slot.slotId);
          const plantSlotDoc = await PlantSlot.findOne({
            "subtypeSlots.slots._id": slotObjectId,
          });
          
          if (plantSlotDoc) {
            for (const subtypeSlot of plantSlotDoc.subtypeSlots || []) {
              const foundSlot = (subtypeSlot.slots || []).find(
                s => s._id.toString() === slot.slotId.toString()
              );
              if (foundSlot) {
                directDBSlotData = {
                  primarySowed: foundSlot.primarySowed || 0,
                  totalPlants: foundSlot.totalPlants || 0,
                  officeSowed: foundSlot.officeSowed || 0,
                  plantsSowed: foundSlot.plantsSowed || 0,
                  totalBookedPlants: foundSlot.totalBookedPlants || 0,
                };
                break;
              }
            }
          }
        } catch (dbError) {
          console.error(`[getAllPlantsTodaySowingCards] Error fetching direct DB slot data for ${slot.slotId}:`, dbError);
        }
        
        dec24SlotDetails.push({
          slotId: slot.slotId?.toString(),
          plantId: slot.plantId?.toString(),
          plantName: plant?.name || "",
          subtypeId: slot.subtypeId?.toString(),
          subtypeName: subtypeDetails?.name || "",
          slotStartDay: slot.slotStartDay,
          slotEndDay: slot.slotEndDay,
          // Raw data from database aggregation
          rawData: {
            primarySowed: rawSlotData?.primarySowed || 0,
            totalPlants: rawSlotData?.totalPlants || 0,
            slotBuffer: rawSlotData?.slotBuffer || 0,
          },
          // Direct database query (latest value from DB)
          directDBData: directDBSlotData || null,
          // Calculated values
          totalBookedPlants: slot.totalBookedPlants,
          primarySowed: slot.primarySowed, // This is from rawSlotData.primarySowed
          slotBuffer: slot.slotBuffer,
          totalBookedPlantsWithBuffer: slot.totalBookedPlantsWithBuffer,
          totalBookedPlantsBufferCount: slot.totalBookedPlantsBufferCount,
          plantsToSowWithBuffer: slot.plantsToSowWithBuffer,
          calculation: {
            formula: "totalBookedPlantsWithBuffer - primarySowed",
            totalBookedPlantsWithBuffer: slot.totalBookedPlantsWithBuffer,
            primarySowed: slot.primarySowed,
            result: slot.plantsToSowWithBuffer,
          },
          bookingGap: slot.bookingGap,
          bookingGapRaw: slot.bookingGapRaw,
          bookingGapEffective: slot.bookingGapEffective,
          bookingGapBeforeBuffer: slot.bookingGapBeforeBuffer,
          slotBufferCount: slot.slotBufferCount,
          gapCoveredAmount: slot.gapCoveredAmount,
          gapFullyCovered: slot.gapFullyCovered,
          sowByDate: slot.sowByDate,
          daysUntilSow: slot.daysUntilSow,
          priority: slot.priority,
          plantReadyDays: slot.plantReadyDays,
          sowingInProgress: slot.sowingInProgress,
          totalPacketsIssued: slot.totalPacketsIssued,
          totalPlantsInProgress: slot.totalPlantsInProgress,
        });
      }
    }
    
    const summary = {
      totalPlants: new Set(filteredSubtypeCards.map(c => c.plantId)).size,
      totalSubtypes: filteredSubtypeCards.length,
      totalDueGap: filteredSubtypeCards.reduce((sum, c) => sum + (c.dueGap || 0), 0),
      totalTodayGap: filteredSubtypeCards.reduce((sum, c) => sum + (c.todayGap || 0), 0),
      totalGap: totalPlantsToSowWithBuffer, // Total plants to sow with buffer (sum of all slots' plantsToSowWithBuffer)
      totalDueSlotBufferCount: filteredSubtypeCards.reduce((sum, c) => sum + (c.dueSlotBufferCount || 0), 0),
      totalTodaySlotBufferCount: filteredSubtypeCards.reduce((sum, c) => sum + (c.todaySlotBufferCount || 0), 0),
      totalSlotBufferCount: filteredSubtypeCards.reduce((sum, c) => sum + (c.slotBufferCount || 0), 0),
      plantsWithSlotBuffer: plantsWithSlotBuffer.size, // Count of unique plants with slot-level buffer > 0
      dueSlots: filteredSubtypeCards.reduce((sum, c) => sum + (c.dueSlots || 0), 0),
      todaySlots: filteredSubtypeCards.reduce((sum, c) => sum + (c.todaySlots || 0), 0),
      totalSlots: filteredSubtypeCards.reduce((sum, c) => sum + (c.totalSlots || 0), 0),
      inProgressSlots: slotsInProgressOnly.length,
      inProgressCards: inProgressCards.length,
    };

    // ADDITION: Fetch available packets for sowing (for PrimarySowingEntry)
    let availablePacketsData = [];
    try {
      // First, collect all in-progress outwardIds to exclude them
      const inProgressOutwardIds = new Set();
      const sowingRequestIds = [];
      
      // Extract sowingRequestIds from all in-progress entries
      slotsWithProgress.forEach(slotData => {
        if (slotData.sowingInProgress && slotData.sowingInProgress.length > 0) {
          slotData.sowingInProgress.forEach(prog => {
            if (prog.sowingRequestId) {
              sowingRequestIds.push(prog.sowingRequestId);
            }
          });
        }
      });

      // Fetch SowingRequest documents to get outwardIds
      if (sowingRequestIds.length > 0) {
        const inProgressRequests = await SowingRequest.find({
          _id: { $in: sowingRequestIds }
        }).select('outwardId').lean();
        
        inProgressRequests.forEach(req => {
          if (req.outwardId) {
            inProgressOutwardIds.add(req.outwardId.toString());
          }
        });
      }

      console.log(`[availablePackets] ${inProgressOutwardIds.size} outward(s) linked to active sowing-in-progress (flagged on packets)`);

      // Seeds category: DBs may use "Seeds"/"SEEDS" — match case-insensitively (same idea as product.controller)
      const SEEDS_CATEGORY_REGEX = /^seeds$/i;

      let seedsProducts = await Product.find({
        category: { $regex: SEEDS_CATEGORY_REGEX },
        isActive: true,
      })
        .select('_id name code plantId subtypeId conversionFactor tentativePlantsPerPacket')
        .populate('plantId', 'name')
        .lean();

      // In-progress sowing always references outwardId on slots — include those products even if isActive is false or product was missing from the query above
      const progressOutwardIdsRaw = [];
      slotsWithProgress.forEach((slotData) => {
        (slotData.sowingInProgress || []).forEach((prog) => {
          if (prog.outwardId) progressOutwardIdsRaw.push(prog.outwardId);
        });
      });
      const uniqueProgressOutwardIds = [...new Set(progressOutwardIdsRaw.map((id) => id.toString()))];

      if (uniqueProgressOutwardIds.length > 0) {
        // Include production OR sowing-linked outwards so legacy rows without purpose still merge products
        const progressOutwardsForProducts = await InventoryOutward.find({
          _id: { $in: uniqueProgressOutwardIds },
          status: 'issued',
          $or: [
            { purpose: 'production' },
            { sowingRequestId: { $exists: true, $ne: null } },
          ],
        })
          .select('items.product')
          .lean();
        const seenProduct = new Set(seedsProducts.map((p) => p._id.toString()));
        const extraProductIds = [];
        progressOutwardsForProducts.forEach((ow) => {
          ow.items?.forEach((item) => {
            const pid = item.product?.toString();
            if (pid && !seenProduct.has(pid)) {
              seenProduct.add(pid);
              extraProductIds.push(item.product);
            }
          });
        });
        if (extraProductIds.length > 0) {
          const extraProducts = await Product.find({
            _id: { $in: extraProductIds },
            category: { $regex: SEEDS_CATEGORY_REGEX },
          })
            .select('_id name code plantId subtypeId conversionFactor tentativePlantsPerPacket')
            .populate('plantId', 'name')
            .lean();
          const merged = [...seedsProducts, ...extraProducts];
          const dedup = new Map();
          merged.forEach((p) => dedup.set(p._id.toString(), p));
          seedsProducts = [...dedup.values()];
        }
      }

      if (seedsProducts && seedsProducts.length > 0) {
        const productIds = seedsProducts.map((p) => p._id);

        // Primary sowing: only production-purpose issued outwards (sales/transfer seed lines excluded).
        const outwards = await InventoryOutward.find({
          status: 'issued',
          purpose: 'production',
          'items.product': { $in: productIds },
        })
          .populate([
            {
              path: 'items.product',
              populate: {
                path: 'plantId',
                select: 'name',
              },
            },
            'items.batch',
            'items.unit',
            'items.sowing',
          ])
          .sort({ outwardDate: -1 })
          .lean();

        // Extract request numbers for excessive sowing check
        const requestNumberPattern = /SR\d+/;
        const requestNumbers = outwards
          .map(o => o.purposeDetails?.match(requestNumberPattern)?.[0])
          .filter(Boolean);

        const sowingRequests = requestNumbers.length > 0
          ? await SowingRequest.find({
              requestNumber: { $in: requestNumbers }
            }).select('requestNumber isExcessiveSowing').lean()
          : [];

        const excessiveSowingMap = new Map();
        sowingRequests.forEach(req => {
          if (req.isExcessiveSowing) {
            excessiveSowingMap.set(req.requestNumber, true);
          }
        });

        // Build product map
        const productPacketMap = new Map();
        seedsProducts.forEach(product => {
          const plantId = product.plantId?._id || product.plantId;
          productPacketMap.set(product._id.toString(), {
            productId: product._id,
            productName: product.name,
            productCode: product.code,
            plantId: plantId && plantId.toString() !== 'unknown' ? plantId : null,
            plantName: product.plantId?.name || 'Unknown Plant',
            subtypeId: product.subtypeId || null,
            conversionFactor: resolveSowingPlantsPerPacket(product),
            tentativePlantsPerPacket: product.tentativePlantsPerPacket ?? null,
          });
        });

        const allPackets = [];

        outwards.forEach((outward) => {
          const outwardIdStr = outward._id.toString();
          const isInProgressOutward = inProgressOutwardIds.has(outwardIdStr);
          // Include all issued seed outwards with remaining quantity (Primary Sowing Entry).

          outward.items.forEach((item) => {
            const productIdStr = item.product?._id?.toString() || item.product?.toString();
            const productInfo = productPacketMap.get(productIdStr);

            if (productInfo) {
              const availableQty = item.quantity - (item.usedQuantity || 0);
              if (availableQty > 0) {
                const populatedProduct = item.product;
                const finalPlantId = populatedProduct?.plantId?._id?.toString() || populatedProduct?.plantId?.toString() || productInfo.plantId?.toString();
                const finalPlantName = populatedProduct?.plantId?.name || productInfo.plantName;
                const finalSubtypeId = populatedProduct?.subtypeId?.toString() || productInfo.subtypeId?.toString();
                const finalConversionFactor = resolveSowingPlantsPerPacket(
                  populatedProduct || productInfo
                );

                const isExcessiveSowing = outward.purposeDetails && 
                  Array.from(excessiveSowingMap.keys()).some(reqNum => 
                    outward.purposeDetails.includes(reqNum)
                  );

                allPackets.push({
                  outwardId: outward._id,
                  outwardNumber: outward.outwardNumber,
                  outwardDate: outward.outwardDate,
                  itemId: item._id,
                  batch: item.batch,
                  batchNumber: item.batch?.batchNumber || 'N/A',
                  quantity: item.quantity,
                  usedQuantity: item.usedQuantity || 0,
                  availableQuantity: availableQty,
                  unit: item.unit,
                  rate: item.rate,
                  amount: item.amount,
                  sowing: item.sowing,
                  productId: productInfo.productId,
                  productName: productInfo.productName,
                  productCode: productInfo.productCode,
                  plantId: finalPlantId,
                  plantName: finalPlantName,
                  subtypeId: finalSubtypeId,
                  conversionFactor: finalConversionFactor,
                  isExcessiveSowing: isExcessiveSowing || false,
                  purpose: outward.purpose,
                  isInProgressOutward,
                });
              }
            }
          });
        });

        // Group packets by plant -> subtype
        const groupedPacketsData = {};

        allPackets.forEach(packet => {
          let plantKey = packet.plantId;
          let plantName = packet.plantName || 'Unknown Plant';

          if (!plantKey || 
              typeof plantKey !== 'string' || 
              plantKey === 'unknown' ||
              !/^[0-9a-fA-F]{24}$/.test(plantKey)) {
            plantKey = 'no-plant';
            plantName = 'Unassigned Products';
          }

          const subtypeKey = packet.subtypeId || 'no-subtype';

          if (!groupedPacketsData[plantKey]) {
            groupedPacketsData[plantKey] = {
              plantId: plantKey === 'no-plant' ? null : plantKey,
              plantName: plantName,
              subtypes: {},
            };
          }

          if (!groupedPacketsData[plantKey].subtypes[subtypeKey]) {
            groupedPacketsData[plantKey].subtypes[subtypeKey] = {
              subtypeId: subtypeKey === 'no-subtype' ? null : subtypeKey,
              packets: [],
            };
          }

          groupedPacketsData[plantKey].subtypes[subtypeKey].packets.push(packet);
        });

        // Convert to array and get subtype names with plantReadyDays
        availablePacketsData = await Promise.all(
          Object.values(groupedPacketsData).map(async (plantGroup) => {
            if (!plantGroup.plantId || plantGroup.plantId === 'no-plant') {
              const subtypes = Object.entries(plantGroup.subtypes).map(([subtypeId, subtypeData]) => {
                return {
                  subtypeId: subtypeId === 'no-subtype' ? null : subtypeId,
                  subtypeName: subtypeId === 'no-subtype' ? 'No Subtype' : 'Unknown Subtype',
                  plantReadyDays: 0,
                  packets: subtypeData.packets.map(p => ({ ...p, plantReadyDays: 0 })),
                };
              });

              return {
                plantId: null,
                plantName: plantGroup.plantName,
                subtypes: subtypes,
              };
            }

            if (!mongoose.Types.ObjectId.isValid(plantGroup.plantId)) {
              const subtypes = Object.entries(plantGroup.subtypes).map(([subtypeId, subtypeData]) => {
                return {
                  subtypeId: subtypeId === 'no-subtype' ? null : subtypeId,
                  subtypeName: 'Unknown Subtype',
                  plantReadyDays: 0,
                  packets: subtypeData.packets.map(p => ({ ...p, plantReadyDays: 0 })),
                };
              });
              return {
                plantId: null,
                plantName: 'Unassigned Products',
                subtypes: subtypes,
              };
            }

            const plant = await PlantCms.findById(plantGroup.plantId).select('name subtypes');
            if (!plant) {
              const subtypes = Object.entries(plantGroup.subtypes).map(([subtypeId, subtypeData]) => {
                return {
                  subtypeId: subtypeId === 'no-subtype' ? null : subtypeId,
                  subtypeName: 'Unknown Subtype',
                  plantReadyDays: 0,
                  packets: subtypeData.packets.map(p => ({ ...p, plantReadyDays: 0 })),
                };
              });
              return {
                plantId: null,
                plantName: 'Unassigned Products',
                subtypes: subtypes,
              };
            }

            const subtypes = await Promise.all(
              Object.entries(plantGroup.subtypes).map(async ([subtypeId, subtypeData]) => {
                if (subtypeId === 'no-subtype') {
                  return {
                    subtypeId: null,
                    subtypeName: 'No Subtype',
                    plantReadyDays: 0,
                    packets: subtypeData.packets.map(p => ({ ...p, plantReadyDays: 0 })),
                  };
                }

                const subtype = plant.subtypes.id(subtypeId);
                const plantReadyDays = subtype?.plantReadyDays || 0;

                return {
                  subtypeId: subtypeId,
                  subtypeName: subtype?.name || 'Unknown Subtype',
                  plantReadyDays: plantReadyDays,
                  packets: subtypeData.packets.map(p => ({
                    ...p,
                    plantReadyDays: plantReadyDays,
                  })),
                };
              })
            );

            return {
              plantId: plantGroup.plantId,
              plantName: plantGroup.plantName,
              subtypes: subtypes,
            };
          })
        );
      }
    } catch (packetsError) {
      console.error("Error fetching available packets:", packetsError);
      // Don't fail the whole request, just return empty packets
      availablePacketsData = [];
    }

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      subtypeCards: filteredSubtypeCards, // Filtered to only include cards with plantsToSowWithBuffer > 0
      inProgressCards: inProgressCards, // Separate array for cards with gap = 0 but in progress
      availablePackets: availablePacketsData, // Available packets for PrimarySowingEntry
      summary,
      date: moment().format("DD-MM-YYYY"),
      generatedAt: new Date(),
      dec24SlotDetails: dec24SlotDetails, // Detailed slot information for December 24 slots
    });
  } catch (error) {
    console.error("Error fetching today's sowing cards:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching today's sowing cards",
      error: error.message,
    });
  }
};

// Easy sowing cards for rolling window (default: today + 30 days)
export const getEasy30DaySowingCards = async (req, res) => {
  try {
    const {
      startDate,
      days = 30,
      plantId,
      subtypeId,
    } = req.query;

    const parsedDays = Math.max(1, Math.min(90, Number(days) || 30));
    const rangeStart = startDate
      ? moment(startDate, "DD-MM-YYYY", true)
      : moment().startOf("day");

    if (!rangeStart.isValid()) {
      return res.status(400).json({
        success: false,
        message: "Invalid startDate. Expected DD-MM-YYYY",
      });
    }

    const rangeEnd = rangeStart.clone().add(parsedDays - 1, "days").endOf("day");

    const plantQuery = { sowingAllowed: true };
    if (plantId && mongoose.Types.ObjectId.isValid(String(plantId))) {
      plantQuery._id = new mongoose.Types.ObjectId(String(plantId));
    }

    const plants = await PlantCms.find(plantQuery)
      .select("_id name subtypes sowingBuffer")
      .lean();

    if (!plants.length) {
      return res.status(200).json({
        success: true,
        data: [],
        summary: {
          totalPlants: 0,
          totalSubtypes: 0,
          totalSlots: 0,
          totalGap: 0,
        },
        window: {
          startDate: rangeStart.format("DD-MM-YYYY"),
          endDate: rangeEnd.format("DD-MM-YYYY"),
          days: parsedDays,
        },
      });
    }

    const plantMap = new Map(plants.map((p) => [p._id.toString(), p]));
    const plantIds = plants.map((p) => p._id);

    const slotDocs = await PlantSlot.find({ plantId: { $in: plantIds } })
      .select("plantId year subtypeSlots")
      .lean();

    const slotRows = [];
    for (const doc of slotDocs) {
      const plant = plantMap.get(doc.plantId.toString());
      if (!plant) continue;
      for (const subtypeSlot of doc.subtypeSlots || []) {
        if (subtypeId && subtypeSlot.subtypeId?.toString() !== String(subtypeId)) continue;
        const subtypeDetails = (plant.subtypes || []).find(
          (st) => st._id.toString() === subtypeSlot.subtypeId?.toString()
        );
        for (const slot of subtypeSlot.slots || []) {
          const slotStart = moment(slot.startDay, "DD-MM-YYYY", true);
          const slotEnd = moment(slot.endDay, "DD-MM-YYYY", true);
          if (!slotStart.isValid() || !slotEnd.isValid()) continue;
          if (slotEnd.isBefore(rangeStart, "day") || slotStart.isAfter(rangeEnd, "day")) continue;

          const readyDaysEffective =
            Number(slot.plantReadyDays) > 0
              ? Number(slot.plantReadyDays)
              : Number(subtypeDetails?.plantReadyDays) || 0;

          slotRows.push({
            slotId: slot._id,
            slotStartDay: slot.startDay,
            slotEndDay: slot.endDay,
            month: slot.month,
            plantId: doc.plantId,
            plantName: plant.name,
            subtypeId: subtypeSlot.subtypeId,
            subtypeName: subtypeDetails?.name || "Unknown Subtype",
            plantReadyDaysEffective: readyDaysEffective,
            plantReadyDaysDefault: Number(subtypeDetails?.plantReadyDays) || 0,
            isReadyDaysOverride: Number(slot.plantReadyDays) > 0,
            primarySowed: Number(slot.primarySowed) || 0,
            officeSowed: Number(slot.officeSowed) || 0,
            totalPlants: Number(slot.totalPlants) || 0,
            availablePlants: Number(slot.availablePlants) || 0,
            totalBookedPlantsCached: Number(slot.totalBookedPlants) || 0,
            slotBuffer: Number(slot.buffer) || Number(subtypeDetails?.buffer) || 0,
            sowingInProgress: slot.sowingInProgress || [],
            gapCovered: slot.gapCovered || [],
            gapFullyCovered: Boolean(slot.gapFullyCovered),
          });
        }
      }
    }

    const slotIds = slotRows.map((s) => s.slotId);
    const bookingMap = new Map();
    if (slotIds.length) {
      const orderBookings = await Order.aggregate([
        {
          $match: {
            bookingSlot: { $in: slotIds },
            orderStatus: { $nin: ["CANCELLED", "REJECTED"] },
            $or: [{ quotaSource: { $ne: "dealer" } }, { quotaSource: { $exists: false } }, { quotaSource: null }],
          },
        },
        { $group: { _id: "$bookingSlot", totalBookedPlants: { $sum: "$numberOfPlants" } } },
      ]);
      orderBookings.forEach((ob) => bookingMap.set(ob._id.toString(), Number(ob.totalBookedPlants) || 0));
    }

    const groupedMap = new Map();
    let totalGap = 0;

    for (const row of slotRows) {
      const slotIdStr = row.slotId.toString();
      const totalBookedPlants = bookingMap.get(slotIdStr) || row.totalBookedPlantsCached || 0;
      const gapCoveredAmount = (row.gapCovered || []).reduce(
        (sum, g) => sum + (Number(g?.plantsCovered) || 0),
        0
      );
      const inProgressPlants = (row.sowingInProgress || []).reduce(
        (sum, p) => sum + (Number(p?.plantsExpected) || 0),
        0
      );
      const packetsInProgress = (row.sowingInProgress || []).reduce(
        (sum, p) => sum + (Number(p?.packetsIssued) || 0),
        0
      );
      const rawGap = totalBookedPlants - row.primarySowed;
      const effectiveGap = Math.max(0, rawGap - gapCoveredAmount - inProgressPlants);
      totalGap += effectiveGap;

      const sowByDate = moment(row.slotEndDay, "DD-MM-YYYY", true).isValid()
        ? moment(row.slotEndDay, "DD-MM-YYYY", true)
            .subtract(row.plantReadyDaysEffective || 0, "days")
            .format("DD-MM-YYYY")
        : null;

      const groupKey = `${row.plantId.toString()}-${row.subtypeId?.toString() || "no-subtype"}`;
      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, {
          plantId: row.plantId,
          plantName: row.plantName,
          subtypeId: row.subtypeId,
          subtypeName: row.subtypeName,
          plantReadyDaysDefault: row.plantReadyDaysDefault,
          slots: [],
        });
      }

      groupedMap.get(groupKey).slots.push({
        slotId: row.slotId,
        slotStartDay: row.slotStartDay,
        slotEndDay: row.slotEndDay,
        month: row.month,
        plantReadyDaysEffective: row.plantReadyDaysEffective,
        isReadyDaysOverride: row.isReadyDaysOverride,
        plantReadyDaysDefault: row.plantReadyDaysDefault,
        sowByDate,
        totalBookedPlants,
        primarySowed: row.primarySowed,
        officeSowed: row.officeSowed,
        totalPlants: row.totalPlants,
        availablePlants: row.availablePlants,
        bookingGap: effectiveGap,
        rawGap,
        gapCoveredAmount,
        inProgress: row.sowingInProgress.length > 0,
        packetContext: {
          packetsInProgress,
          plantsInProgress: inProgressPlants,
          progressEntries: row.sowingInProgress.length,
        },
        slotBuffer: row.slotBuffer || 0,
      });
    }

    const data = Array.from(groupedMap.values()).map((group) => {
      const monthMap = new Map();
      for (const slot of group.slots) {
        const monthKey =
          moment(slot.slotStartDay, "DD-MM-YYYY", true).isValid()
            ? moment(slot.slotStartDay, "DD-MM-YYYY").format("MMM YYYY")
            : slot.month || "Unknown";
        if (!monthMap.has(monthKey)) monthMap.set(monthKey, []);
        monthMap.get(monthKey).push(slot);
      }
      const months = Array.from(monthMap.entries()).map(([monthKey, slots]) => ({
        monthKey,
        totalSlots: slots.length,
        totalGap: slots.reduce((sum, s) => sum + (s.bookingGap || 0), 0),
        slots: slots.sort((a, b) =>
          moment(a.slotStartDay, "DD-MM-YYYY").valueOf() - moment(b.slotStartDay, "DD-MM-YYYY").valueOf()
        ),
      }));
      return {
        ...group,
        totalGap: group.slots.reduce((sum, s) => sum + (s.bookingGap || 0), 0),
        totalSlots: group.slots.length,
        months,
      };
    });

    return res.status(200).json({
      success: true,
      data,
      summary: {
        totalPlants: new Set(data.map((d) => d.plantId.toString())).size,
        totalSubtypes: data.length,
        totalSlots: slotRows.length,
        totalGap,
      },
      window: {
        startDate: rangeStart.format("DD-MM-YYYY"),
        endDate: rangeEnd.format("DD-MM-YYYY"),
        days: parsedDays,
      },
      generatedAt: new Date(),
    });
  } catch (error) {
    console.error("Error fetching easy 30-day sowing cards:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching easy 30-day sowing cards",
      error: error.message,
    });
  }
};

// Update plantReadyDays for future slots only and store audit metadata
export const bulkUpdatePlantReadyDaysForFutureSlots = async (req, res) => {
  try {
    const { slotIds = [], plantReadyDays, reason = "" } = req.body || {};
    const requestedBy = req.user?._id || null;
    const requestedByName = req.user?.name || req.user?.phoneNumber || "Unknown";

    const parsedReadyDays = Number(plantReadyDays);
    if (!Array.isArray(slotIds) || slotIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slotIds array is required",
      });
    }
    if (!Number.isFinite(parsedReadyDays) || parsedReadyDays < 0) {
      return res.status(400).json({
        success: false,
        message: "plantReadyDays must be a valid non-negative number",
      });
    }

    const today = moment().startOf("day");
    const updated = [];
    const skippedPast = [];
    const skippedNoChange = [];
    const notFound = [];

    for (const id of slotIds) {
      if (!mongoose.Types.ObjectId.isValid(String(id))) {
        notFound.push({ slotId: id, reason: "Invalid slotId" });
        continue;
      }
      const slotObjectId = new mongoose.Types.ObjectId(String(id));
      const slotDoc = await PlantSlot.findOne({ "subtypeSlots.slots._id": slotObjectId });
      if (!slotDoc) {
        notFound.push({ slotId: id, reason: "Slot not found" });
        continue;
      }

      let slotToUpdate = null;
      let subtypeId = null;
      for (const st of slotDoc.subtypeSlots || []) {
        const slot = (st.slots || []).find((s) => s._id.toString() === slotObjectId.toString());
        if (slot) {
          slotToUpdate = slot;
          subtypeId = st.subtypeId;
          break;
        }
      }

      if (!slotToUpdate) {
        notFound.push({ slotId: id, reason: "Slot structure missing" });
        continue;
      }

      const slotEnd = moment(slotToUpdate.endDay, "DD-MM-YYYY", true);
      if (!slotEnd.isValid() || slotEnd.isBefore(today, "day")) {
        skippedPast.push({ slotId: id, endDay: slotToUpdate.endDay });
        continue;
      }

      const oldReadyDays = Number(slotToUpdate.plantReadyDays) || 0;
      if (oldReadyDays === parsedReadyDays) {
        skippedNoChange.push({ slotId: id, plantReadyDays: oldReadyDays });
        continue;
      }

      let plantName = "Unknown Plant";
      let subtypeName = "Unknown Subtype";
      const plant = await PlantCms.findById(slotDoc.plantId).select("name subtypes").lean();
      if (plant) {
        plantName = plant.name;
        const st = (plant.subtypes || []).find((s) => s._id.toString() === subtypeId?.toString());
        if (st?.name) subtypeName = st.name;
      }

      slotToUpdate.plantReadyDays = parsedReadyDays;
      slotToUpdate.logSowingActivity({
        action: "READY_DAYS_UPDATED",
        activityName: "Plant Ready Days Updated",
        quantity: parsedReadyDays,
        before: { plantReadyDays: oldReadyDays },
        after: { plantReadyDays: parsedReadyDays },
        performedBy: requestedBy,
        reason: reason || "Updated from easy sowing admin cards portal",
        notes: `Plant ready days changed from ${oldReadyDays} to ${parsedReadyDays}`,
        metadata: {
          changedByUserId: requestedBy ? String(requestedBy) : null,
          changedByName: requestedByName,
          changedAt: new Date().toISOString(),
          plantId: String(slotDoc.plantId),
          plantName,
          subtypeId: subtypeId ? String(subtypeId) : null,
          subtypeName,
          slotId: String(slotObjectId),
          slotStartDay: slotToUpdate.startDay,
          slotEndDay: slotToUpdate.endDay,
          oldPlantReadyDays: oldReadyDays,
          newPlantReadyDays: parsedReadyDays,
          changeScope: "month_bulk_future_only",
          changeReason: reason || null,
        },
      });

      slotDoc.markModified("subtypeSlots");
      await slotDoc.save();

      updated.push({
        slotId: String(slotObjectId),
        slotStartDay: slotToUpdate.startDay,
        slotEndDay: slotToUpdate.endDay,
        oldPlantReadyDays: oldReadyDays,
        newPlantReadyDays: parsedReadyDays,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Updated ${updated.length} future slot(s), skipped ${skippedPast.length} past slot(s), ${skippedNoChange.length} unchanged.`,
      data: {
        updatedCount: updated.length,
        skippedPastCount: skippedPast.length,
        skippedNoChangeCount: skippedNoChange.length,
        notFoundCount: notFound.length,
        updated,
        skippedPast,
        skippedNoChange,
        notFound,
      },
    });
  } catch (error) {
    console.error("Error updating plant ready days for future slots:", error);
    return res.status(500).json({
      success: false,
      message: "Error updating plant ready days for future slots",
      error: error.message,
    });
  }
};

// Unified sowing insights records feed for side drawer timeline
export const getSowingInsightsRecords = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      plantId,
      subtypeId,
      slotId,
      userId,
      actionType,
      startDate,
      endDate,
    } = req.query;

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const sowingQuery = {};
    if (plantId && mongoose.Types.ObjectId.isValid(String(plantId))) {
      sowingQuery.plantId = new mongoose.Types.ObjectId(String(plantId));
    }
    if (subtypeId && mongoose.Types.ObjectId.isValid(String(subtypeId))) {
      sowingQuery.subtypeId = new mongoose.Types.ObjectId(String(subtypeId));
    }
    if (slotId && mongoose.Types.ObjectId.isValid(String(slotId))) {
      sowingQuery.$or = [
        { slotId: new mongoose.Types.ObjectId(String(slotId)) },
        { entrySlotId: new mongoose.Types.ObjectId(String(slotId)) },
        { targetSlotId: new mongoose.Types.ObjectId(String(slotId)) },
      ];
    }
    if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
      sowingQuery.$or = [...(sowingQuery.$or || []), { createdBy: new mongoose.Types.ObjectId(String(userId)) }];
    }

    if (startDate || endDate) {
      sowingQuery.createdAt = {};
      if (startDate) sowingQuery.createdAt.$gte = new Date(startDate);
      if (endDate) sowingQuery.createdAt.$lte = new Date(endDate);
    }

    const sowings = await Sowing.find(sowingQuery)
      .select(
        "_id plantId plantName subtypeId subtypeName sowingDate expectedReadyDate plantReadyDays batchNumber createdBy createdAt metadata entrySlotId targetSlotId mappedByRule slotId notes"
      )
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .skip(skip)
      .lean();

    const slotTrailPipeline = [
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      { $unwind: "$subtypeSlots.slots.slotTrail" },
      {
        $project: {
          plantId: 1,
          slotId: "$subtypeSlots.slots._id",
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          subtypeId: "$subtypeSlots.subtypeId",
          trail: "$subtypeSlots.slots.slotTrail",
        },
      },
    ];
    if (slotId && mongoose.Types.ObjectId.isValid(String(slotId))) {
      slotTrailPipeline.push({
        $match: { slotId: new mongoose.Types.ObjectId(String(slotId)) },
      });
    }
    if (actionType) {
      slotTrailPipeline.push({
        $match: { "trail.action": actionType },
      });
    }
    slotTrailPipeline.push({ $sort: { "trail.timestamp": -1 } }, { $limit: safeLimit });
    const trailRows = await PlantSlot.aggregate(slotTrailPipeline);

    const records = [];

    for (const s of sowings) {
      records.push({
        recordId: `sowing-${s._id}`,
        eventType: "SOWING_CREATED",
        timestamp: s.createdAt,
        performedBy: s.createdBy || null,
        performedByName: s.metadata?.changedByName || null,
        plantId: s.plantId,
        plantName: s.plantName,
        subtypeId: s.subtypeId,
        subtypeName: s.subtypeName,
        entrySlotId: s.entrySlotId || s.metadata?.entrySlotId || null,
        targetSlotId: s.targetSlotId || s.metadata?.targetSlotId || s.slotId || null,
        slotStartDay: null,
        slotEndDay: null,
        sowingDate: s.sowingDate,
        expectedReadyDate: s.expectedReadyDate,
        batchNumber: s.batchNumber,
        before: null,
        after: null,
        reason: s.notes || null,
        metadata: s.metadata || {},
      });
    }

    for (const row of trailRows) {
      const t = row.trail || {};
      if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
        if (!t.performedBy || t.performedBy.toString() !== String(userId)) continue;
      }
      if (startDate || endDate) {
        const ts = t.timestamp ? new Date(t.timestamp) : null;
        if (startDate && ts && ts < new Date(startDate)) continue;
        if (endDate && ts && ts > new Date(endDate)) continue;
      }
      records.push({
        recordId: `trail-${row.slotId}-${t.timestamp || Date.now()}-${t.action || "UNKNOWN"}`,
        eventType: t.action || "SLOT_TRAIL_EVENT",
        timestamp: t.timestamp || null,
        performedBy: t.performedBy || null,
        performedByName: t.metadata?.changedByName || null,
        plantId: row.plantId,
        plantName: t.metadata?.plantName || null,
        subtypeId: row.subtypeId || null,
        subtypeName: t.metadata?.subtypeName || null,
        entrySlotId: t.metadata?.entrySlotId || null,
        targetSlotId: t.metadata?.targetSlotId || row.slotId || null,
        slotStartDay: row.slotStartDay || null,
        slotEndDay: row.slotEndDay || null,
        sowingDate: t.sowingDate || null,
        expectedReadyDate: t.metadata?.expectedReadyDate || null,
        batchNumber: t.batchNumber || null,
        before: t.before || null,
        after: t.after || null,
        reason: t.reason || null,
        metadata: t.metadata || {},
      });
    }

    const sorted = records
      .sort((a, b) => new Date(b.timestamp || 0).valueOf() - new Date(a.timestamp || 0).valueOf())
      .slice(0, safeLimit);

    return res.status(200).json({
      success: true,
      data: sorted,
      pagination: {
        page: safePage,
        limit: safeLimit,
        returned: sorted.length,
      },
    });
  } catch (error) {
    console.error("Error fetching sowing insights records:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching sowing insights records",
      error: error.message,
    });
  }
};
