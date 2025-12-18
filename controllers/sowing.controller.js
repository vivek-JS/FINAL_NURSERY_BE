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

    // Create sowing record
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
      createdBy,
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
        
        // If sowedPlant is provided, update primarySowed and totalPlants with that value
        if (sowedPlantValue !== null && sowedPlantValue > 0) {
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed'] = sowedPlantValue;
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants'] = sowedPlantValue;
          console.log(`📊 Will update primarySowed and totalPlants with sowedPlant: ${sowedPlantValue}`);
        } else if (location === "PRIMARY") {
          // Fallback: For PRIMARY location without sowedPlant, use totalQuantityRequired
          updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed'] = totalQuantityRequired;
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
            console.log(`   - primarySowed += ${sowedPlantValue} (from sowedPlant)`);
            console.log(`   - totalPlants += ${sowedPlantValue} (from sowedPlant)`);
          }
          if (officeQuantity > 0) {
            console.log(`   - officeSowed += ${officeQuantity}`);
          }
          
          // Update plantsSowed separately if primarySowed was updated
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
          slotId,
          orderId,
          orderNumber,
          reminderBeforeDays,
          notes,
          batchNumber, // Batch number (mandatory - from packets or form field)
          createdBy,
          sowingLocation, // OFFICE or PRIMARY
          packets, // Array of packets from outward entries
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

        // Validate slot if provided
        let slotObjectId = null;
        if (slotId) {
          if (!mongoose.Types.ObjectId.isValid(slotId)) {
            errors.push({ index: i, error: "Invalid slotId provided" });
            continue;
          }
          slotObjectId = new mongoose.Types.ObjectId(slotId);

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

        // Create sowing record
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
          sowingLocation: sowingLocation || "OFFICE",
          orderId,
          orderNumber,
          reminderBeforeDays: reminderBeforeDays || 5,
          notes,
          batchNumber: batchNumber.trim(), // Store batch number (mandatory)
          createdBy,
        });

        const savedSowing = await sowing.save();

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
            
            // If sowedPlant is provided, update primarySowed and totalPlants with that value
            if (sowedPlantValue !== null && sowedPlantValue > 0) {
              updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed'] = sowedPlantValue;
              updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants'] = sowedPlantValue;
              console.log(`📊 Will update primarySowed and totalPlants with sowedPlant: ${sowedPlantValue}`);
            } else if (location === "PRIMARY") {
              // Fallback: For PRIMARY location without sowedPlant, use totalQuantityRequired
              updateOperation.$inc['subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed'] = totalQuantityRequired;
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
                console.log(`   - primarySowed += ${sowedPlantValue} (from sowedPlant)`);
                console.log(`   - totalPlants += ${sowedPlantValue} (from sowedPlant)`);
              }
              if (officeQuantity > 0) {
                console.log(`   - officeSowed += ${officeQuantity}`);
              }
              
              // Update plantsSowed separately if primarySowed was updated
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
          // Get sowingBuffer from plantInfo
          sowingBuffer: { $ifNull: ["$plantInfo.sowingBuffer", 0] },
        },
      },
      {
        $addFields: {
          // Apply sowing buffer to positive gaps: gapWithBuffer = gap * (1 + sowingBuffer/100)
          bookingGap: {
            $cond: [
              {
                $and: [
                  { $gt: ["$bookingGapRaw", 0] }, // Only apply to positive gaps
                  { $gt: ["$sowingBuffer", 0] }, // Only if buffer > 0
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
                          { $divide: ["$sowingBuffer", 100] },
                        ],
                      },
                    ],
                  },
                ],
              },
              "$bookingGapRaw", // Use raw gap if buffer is 0 or gap is negative
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
          availablePlants: 1,
          surplus: "$availablePlants", // Explicit surplus field (available for booking)
          totalBookedPlants: 1,
          totalPlants: 1,
          primarySowed: 1,
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
          sowingBuffer: { $ifNull: ["$plantInfo.sowingBuffer", 0] },
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
          sowingBuffer: { $first: "$sowingBuffer" }, // Get buffer from first record
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
          // Apply sowing buffer: gapWithBuffer = gap * (1 + sowingBuffer/100)
          totalBookingGap: {
            $cond: [
              {
                $and: [
                  { $gt: ["$totalBookingGapRaw", 0] },
                  { $gt: ["$sowingBuffer", 0] },
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
                          { $divide: ["$sowingBuffer", 100] },
                        ],
                      },
                    ],
                  },
                ],
              },
              "$totalBookingGapRaw",
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
            category: "seeds",
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
    const { available } = req.query; // If "true", return negative gaps (available/surplus) instead of positive gaps
    
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
      category: "seeds",
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
        },
      },
      {
        $project: {
          plantId: 1,
          subtypeId: "$subtypeSlots.subtypeId",
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          slotEndDay: "$subtypeSlots.slots.endDay",
          slotReadyDays: 1,
        },
      },
    ]);

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
      const slotGap = totalBookedPlants - primarySowed;
      
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
          console.log(`[getPlantsGapSummary] Twinkle: slotEndDay=${slot.slotEndDay}, plantReadyDays=${slotReadyDays}, sowByDate=${sowByDate}, isOverdue=${isOverdue}, slotGap=${slotGap}`);
        }
      }
      
      return {
        plantId: slot.plantId,
        subtypeId: slot.subtypeId,
        totalBookedPlants,
        primarySowed,
        slotGap,
        isOverdue,
        sowByDate,
        plantReadyDays: slotReadyDays,
      };
    });

    // Step 6: Filter slots based on available parameter
    // For critical mode: include slots with positive gap OR overdue slots (even with 0 gap)
    // For available mode: only negative gap slots
    const filteredSlots = available === "true"
      ? slotsWithBookings.filter(s => s.slotGap < 0) // Negative gap = available/surplus
      : slotsWithBookings.filter(s => {
          // Include if positive gap OR overdue
          if (s.slotGap > 0 || s.isOverdue) {
            // Debug logging for overdue slots
            if (s.isOverdue) {
              console.log(`[getPlantsGapSummary] Overdue slot found: plantId=${s.plantId}, subtypeId=${s.subtypeId}, slotGap=${s.slotGap}, sowByDate=${s.sowByDate}`);
            }
            return true;
          }
          return false;
        });

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
          plantReadyDays: slot.plantReadyDays || 0, // Store plantReadyDays from first slot
        });
      }
      const group = subtypeGroupMap.get(key);
      group.totalBookedPlants += slot.totalBookedPlants;
      group.totalPrimarySowed += slot.primarySowed;
      group.slotCount += 1;
      if (slot.isOverdue) {
        group.overdueSlotCount += 1;
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
        totalBookingGap,
        totalAvailableGap,
        rawGap,
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
      });
    });

    // Process each plant and enrich with product/batch data
    const plantsWithGaps = plants.map((plant) => {
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
        };
      });

      // Filter based on available parameter
      // For critical mode: show subtypes with positive gap OR overdue slots
      // For available mode: show subtypes with negative gap
      let filteredSubtypes = subtypesWithGaps;
      if (available === "true") {
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
            console.log(`[getPlantsGapSummary] Overdue subtype found: plant=${plant.name}, subtype=${st.subtypeName}, gap=${st.totalBookingGap}, overdueSlots=${st.overdueSlotCount}`);
          }
          
          return shouldInclude;
        });
      }

      const plantTotalGap = available === "true"
        ? filteredSubtypes.reduce((sum, st) => sum + (st.totalAvailableGap || 0), 0)
        : filteredSubtypes.reduce((sum, st) => sum + (st.totalBookingGap || 0), 0);

      return {
        _id: plant._id,
        plantName: plant.name,
        subtypes: filteredSubtypes,
        totalBookingGap: available === "true" ? 0 : plantTotalGap,
        totalAvailableGap: available === "true" ? plantTotalGap : 0,
      };
    });

    // Sort by appropriate gap type
    if (available === "true") {
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
        totalBookingGap: available === "true" ? 0 : totalBookingGap,
        totalAvailableGap: available === "true" ? totalAvailableGap : 0,
      },
      mode: available === "true" ? "available" : "critical", // Indicate which mode
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
    const totalPlants = orders.reduce((sum, order) => sum + (order.numberOfPlants || 0), 0);
    const totalValue = orders.reduce((sum, order) => sum + ((order.numberOfPlants || 0) * (order.rate || 0)), 0);
    const pendingPaymentCount = orders.filter(o => o.orderPaymentStatus === "PENDING").length;
    const completedPaymentCount = orders.filter(o => o.orderPaymentStatus === "COMPLETED").length;

    // Get slot info
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
            totalPlants: { $ifNull: ["$slot.totalPlants", 0] },
            primarySowed: { $ifNull: ["$slot.primarySowed", 0] },
            officeSowed: { $ifNull: ["$slot.officeSowed", 0] },
          }
        }
      }
    ]);

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      slotInfo: slotInfo[0] || null,
      orders,
      summary: {
        totalOrders,
        totalPlants,
        totalValue,
        pendingPaymentCount,
        completedPaymentCount,
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
      category: "seeds",
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
          slotStartDay: "$subtypeSlots.slots.startDay",
          slotEndDay: "$subtypeSlots.slots.endDay",
          month: "$subtypeSlots.slots.month",
        },
      },
    ]);

    // Step 2: Collect all slot IDs
    const slotIds = allSlots.map(s => s.slotId);

    // Step 2.5: Get sowing in progress details directly from slots
    // This ensures we use the correct plantsExpected calculation
    const slotsWithProgress = await PlantSlot.aggregate([
      {
        $match: {
          'subtypeSlots.slots._id': { $in: slotIds },
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
          'subtypeSlots.slots._id': { $in: slotIds },
          'subtypeSlots.slots.sowingInProgress': { $exists: true, $ne: [] },
        },
      },
      {
        $project: {
          slotId: '$subtypeSlots.slots._id',
          sowingInProgress: '$subtypeSlots.slots.sowingInProgress',
        },
      },
    ]);

    // Create map of slot IDs with sowing in progress details from slot data
    const sowingInProgressMap = new Map();
    slotsWithProgress.forEach(slotData => {
      const slotIdStr = slotData.slotId.toString();
      const progressDetails = (slotData.sowingInProgress || []).map(prog => ({
        packetsIssued: prog.packetsIssued || 0,
        remainingPlants: prog.plantsExpected || 0, // Use plantsExpected from slot
        isExcessiveSowing: prog.isExcessiveSowing || false,
        requestNumber: prog.requestNumber,
      }));
      if (progressDetails.length > 0) {
        sowingInProgressMap.set(slotIdStr, progressDetails);
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
      const bookingGap = totalBookedPlants - primarySowed;
      
      // Parse slot end date
      const endDayParts = slot.slotEndDay.match(/(\d{2})-(\d{2})-(\d{4})/);
      const slotEndISO = endDayParts 
        ? new Date(`${endDayParts[3]}-${endDayParts[2]}-${endDayParts[1]}`)
        : null;
      
      // Calculate sowByDateISO
      // slotReadyDays is already set from aggregation (slot-level first, then PlantCMS fallback)
      const slotReadyDays = slot.slotReadyDays || 0;
      
      let sowByDateISO = null;
      if (slotEndISO) {
        if (slotReadyDays > 0) {
          // Calculate: sowByDate = slotEndDate - plantReadyDays
          sowByDateISO = new Date(slotEndISO.getTime() - slotReadyDays * 24 * 60 * 60 * 1000);
        } else {
          // If no plantReadyDays configured, use slotEndDate as sowByDate (fallback)
          sowByDateISO = slotEndISO;
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
      
      // Determine priority: "due" for overdue, "today" for today
      // Note: Filter below only includes slots with daysUntilSow <= 0, so "future" slots are excluded
      const priority = daysUntilSow !== null
        ? (daysUntilSow < 0 ? "due" : "today")
        : null;
      
      // Debug logging for Twinkle subtype to verify calculation
      if (slot.subtypeId && slot.plantId) {
        const plant = plantMap.get(slot.plantId.toString());
        const subtypes = plant?.subtypes || [];
        const subtypeDetails = subtypes.find(st => st._id.toString() === slot.subtypeId.toString());
        if (subtypeDetails?.name?.toLowerCase().includes("twinkle")) {
          console.log(`[getAllPlantsTodaySowingCards] Twinkle: slotEndDay=${slot.slotEndDay}, plantReadyDays=${slotReadyDays}, sowByDate=${sowByDate}, daysUntilSow=${daysUntilSow}, priority=${priority}, bookingGap=${bookingGap}`);
        }
      }
      
      // Check if sowing is in progress for this slot (use slotIdStr already declared above)
      const sowingProgress = sowingInProgressMap.get(slotIdStr);
      
      // Calculate adjusted booking gap if sowing in progress
      let adjustedBookingGap = bookingGap;
      let totalPacketsIssued = 0;
      let totalPlantsInProgress = 0;
      
      if (sowingProgress && sowingProgress.length > 0) {
        // Sum up all plants that are in progress
        totalPlantsInProgress = sowingProgress.reduce((sum, prog) => sum + prog.remainingPlants, 0);
        totalPacketsIssued = sowingProgress.reduce((sum, prog) => sum + prog.packetsIssued, 0);
        
        // Reduce the booking gap by plants that have stock issued
        adjustedBookingGap = Math.max(0, bookingGap - totalPlantsInProgress);
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
        primarySowed,
        totalPlants: slot.totalPlants,
        bookingGap: adjustedBookingGap, // Show adjusted gap
        bookingGapRaw: bookingGap, // Keep original for reference
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
    // 1. Slots with gap (need action) - show in main cards
    // 2. Slots with 0 gap but in progress (just tracking) - show separately
    const slotsNeedingAction = allTodaySlots.filter(slot => {
      // Basic filters: must be due/today
      if (slot.daysUntilSow === null || slot.daysUntilSow > 0) {
        return false;
      }
      // Show ONLY if there's actual gap remaining
      if (slot.bookingGap <= 0) {
        return false;
      }
      return true;
    });

    const slotsInProgressOnly = allTodaySlots.filter(slot => {
      // Basic filters: must be due/today
      if (slot.daysUntilSow === null || slot.daysUntilSow > 0) {
        return false;
      }
      // Show ONLY slots that are in progress but have 0 gap (fully covered)
      if (slot.bookingGap > 0) {
        return false; // Has gap, so it's in the main cards
      }
      if (!slot.sowingInProgress) {
        return false; // No progress, just ignore
      }
      return true;
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
      
      if (slot.priority === "due") {
        card.dueGap += slot.bookingGap || 0;
        card.dueSlots += 1;
      } else {
        card.todayGap += slot.bookingGap || 0;
        card.todaySlots += 1;
      }
    });

    // Process each subtype card and enrich with product/batch data
    const allSubtypeCards = Array.from(subtypeCardMap.values()).map((card) => {
      const sowingBuffer = card.sowingBuffer || 0;
      
      // Apply sowing buffer to gaps
      const dueGapWithBuffer = sowingBuffer > 0 && card.dueGap > 0
        ? Math.round(card.dueGap * (1 + sowingBuffer / 100))
        : card.dueGap;
      const todayGapWithBuffer = sowingBuffer > 0 && card.todayGap > 0
        ? Math.round(card.todayGap * (1 + sowingBuffer / 100))
        : card.todayGap;
      const totalGap = dueGapWithBuffer + todayGapWithBuffer;
      
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
      const slotsWithBuffer = card.slots.map(slot => {
        const gapWithBuffer = sowingBuffer > 0 && slot.bookingGapRaw > 0
          ? Math.round(slot.bookingGapRaw * (1 + sowingBuffer / 100))
          : slot.bookingGapRaw;
        
        return {
          ...slot,
          bookingGap: gapWithBuffer,
          bookingGapRaw: slot.bookingGapRaw,
        };
      });
      
      return {
        plantId: card.plantId,
        plantName: card.plantName,
        subtypeId: card.subtypeId,
        subtypeName: card.subtypeName,
        dueGap: dueGapWithBuffer,
        todayGap: todayGapWithBuffer,
        dueSlots: card.dueSlots,
        todaySlots: card.todaySlots,
        totalBookedPlants: card.totalBookedPlants,
        totalPrimarySowed: card.totalPrimarySowed,
        slots: slotsWithBuffer,
        totalGap: totalGap,
        totalSlots: card.slots.length,
        sowingBuffer: sowingBuffer,
        conversionFactor: conversionFactor,
        secondaryUnit: secondaryUnit,
        primaryUnit: primaryUnit,
        availablePackets: availablePackets,
      };
    });

    // Sort by total gap (descending)
    allSubtypeCards.sort((a, b) => (b.totalGap || 0) - (a.totalGap || 0));

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

    // Calculate summary
    const summary = {
      totalPlants: new Set(allSubtypeCards.map(c => c.plantId)).size,
      totalSubtypes: allSubtypeCards.length,
      totalDueGap: allSubtypeCards.reduce((sum, c) => sum + (c.dueGap || 0), 0),
      totalTodayGap: allSubtypeCards.reduce((sum, c) => sum + (c.todayGap || 0), 0),
      dueSlots: allSubtypeCards.reduce((sum, c) => sum + (c.dueSlots || 0), 0),
      todaySlots: allSubtypeCards.reduce((sum, c) => sum + (c.todaySlots || 0), 0),
      totalSlots: allSubtypeCards.reduce((sum, c) => sum + (c.totalSlots || 0), 0),
      inProgressSlots: slotsInProgressOnly.length,
      inProgressCards: inProgressCards.length,
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    return res.status(200).json({
      success: true,
      subtypeCards: allSubtypeCards,
      inProgressCards: inProgressCards, // Separate array for cards with gap = 0 but in progress
      summary,
      date: moment().format("DD-MM-YYYY"),
      generatedAt: new Date(),
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
