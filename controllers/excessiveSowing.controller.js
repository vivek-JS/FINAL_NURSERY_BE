import PlantCms from '../models/plantCms.model.js';
import PlantSlot from '../models/slots.model.js';
import SowingRequest from '../models/sowingRequest.model.js';
import Product from '../models/product.model.js';
import InventoryOutward from '../models/inventoryOutward.model.js';
import Batch from '../models/batch.model.js';
import moment from 'moment';
import mongoose from 'mongoose';
import {
  logSowingRequestCreated,
  logExcessiveSowingAdded,
} from '../helpers/slotTransactionLogger.js';

/**
 * Create excessive sowing request (no orders, just want to sow extra plants)
 * POST /api/v1/sowing/excessive/create-request
 */
export const createExcessiveSowingRequest = async (req, res) => {
  try {
    const {
      plantId,
      subtypeId,
      packetsRequested,
      sowingDate, // Expected sowing date
      notes,
    } = req.body;

    // Validate required fields
    if (!plantId || !subtypeId || !packetsRequested || packetsRequested <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Plant ID, Subtype ID, and Packets Requested (> 0) are required',
      });
    }

    // Validate plant and subtype
    const plant = await PlantCms.findById(plantId);
    if (!plant) {
      return res.status(404).json({
        success: false,
        message: 'Plant not found',
      });
    }

    if (!plant.sowingAllowed) {
      return res.status(400).json({
        success: false,
        message: 'Sowing is not allowed for this plant',
      });
    }

    const subtype = plant.subtypes.id(subtypeId);
    if (!subtype) {
      return res.status(404).json({
        success: false,
        message: 'Subtype not found',
      });
    }

    // Get product (seed) for this subtype (removed purpose: 'production' filter)
    // Try multiple strategies to find a matching product
    let product = await Product.findOne({
      plantId,
      'plantSubtypeInfo.subtypeId': subtypeId,
      isActive: true,
    }).populate('primaryUnit secondaryUnit');

    // Fallback 1: Find by plantId only
    if (!product) {
      product = await Product.findOne({
        plantId,
        isActive: true,
      }).populate('primaryUnit secondaryUnit');
    }

    // Fallback 2: Find any active product for this plant
    if (!product) {
      const products = await Product.find({
        plantId,
        isActive: true,
      }).populate('primaryUnit secondaryUnit').limit(1);
      product = products[0];
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'No active product found for this plant/subtype. Please ensure products are linked to plants and are active.',
      });
    }

    // Get conversion factor
    let conversionFactor = 1;
    if (product.plantSubtypeInfo && product.plantSubtypeInfo.length > 0) {
      const plantSubtypeInfo = product.plantSubtypeInfo.find(
        (info) => info.subtypeId?.toString() === subtypeId.toString()
      );
      conversionFactor = plantSubtypeInfo?.conversionFactor || product.conversionFactor || 1;
    } else {
      conversionFactor = product.conversionFactor || 1;
    }

    // Get plantReadyDays from subtype
    const plantReadyDays = subtype.plantReadyDays || 0;

    // Calculate plant ready by date (sowingDate + plantReadyDays)
    let plantReadyBy = null;
    if (sowingDate) {
      const sowingDateMoment = moment(sowingDate, 'DD-MM-YYYY');
      if (sowingDateMoment.isValid() && plantReadyDays > 0) {
        plantReadyBy = sowingDateMoment.clone().add(plantReadyDays, 'days').format('DD-MM-YYYY');
      } else if (sowingDateMoment.isValid()) {
        // If plantReadyDays is 0, plants are ready on sowing date
        plantReadyBy = sowingDateMoment.format('DD-MM-YYYY');
      }
    }

    // Generate request number
    const requestNumber = await SowingRequest.generateRequestNumber();

    // Create request
    const requestData = {
      requestNumber,
      plantId,
      plantName: plant.name,
      subtypeId,
      subtypeName: subtype.name,
      productId: product._id,
      packetsNeeded: packetsRequested,
      packetsRequested,
      excessPackets: 0,
      primaryUnit: product.primaryUnit,
      secondaryUnit: product.secondaryUnit,
      conversionFactor,
      unitName: product.primaryUnit?.symbol || product.secondaryUnit?.symbol || 'packets',
      status: 'pending',
      requestedDate: new Date(),
      requestedBy: req.user._id,
      isExcessiveSowing: true,
      notes: notes || 'Excessive sowing request (no orders)',
      remainingSowingNeeded: packetsRequested * conversionFactor,
      plantReadyDays: plantReadyDays,
      plantReadyBy: plantReadyBy, // Date when plants will be ready (sowingDate + plantReadyDays)
      actualSowingDate: sowingDate ? moment(sowingDate, 'DD-MM-YYYY').format('DD-MM-YYYY') : null, // Store actual sowing date for stock issue reference
    };

    const newRequest = await SowingRequest.create(requestData);

    // Find or create slot for this request
    // Slot date = sowingDate + plantReadyDays (when plants will be ready)
    const sowingDateMoment = sowingDate
      ? moment(sowingDate, 'DD-MM-YYYY')
      : moment().add(7, 'days');
    
    // Calculate slot date: sowing date + plant ready days
    const slotDate = sowingDateMoment.clone().add(plantReadyDays, 'days');
    const startDay = slotDate.format('DD-MM-YYYY');
    const endDay = startDay; // Single-day slot
    const month = slotDate.format('MMMM');
    const year = slotDate.year();
    
    console.log(`[DEBUG] Slot creation: sowingDate=${sowingDateMoment.format('DD-MM-YYYY')}, plantReadyDays=${plantReadyDays}, slotDate=${startDay}`);

    // Try to find existing slot for this date
    let plantSlotDoc = await PlantSlot.findOne({
      plantId,
      year,
    });

    if (!plantSlotDoc) {
      // Create new plant slot document
      plantSlotDoc = await PlantSlot.create({
        plantId,
        year,
        subtypeSlots: [],
      });
    }

    // Find or create subtype slot
    let subtypeSlot = plantSlotDoc.subtypeSlots.find(
      (st) => st.subtypeId?.toString() === subtypeId.toString()
    );

    if (!subtypeSlot) {
      subtypeSlot = {
        subtypeId,
        slots: [],
      };
      plantSlotDoc.subtypeSlots.push(subtypeSlot);
    }

    // Find or create slot for the target date
    let slot = subtypeSlot.slots.find(
      (s) => s.startDay === startDay && s.endDay === endDay
    );

    if (!slot) {
      // Create new slot
      const expectedPlants = packetsRequested * conversionFactor;
      slot = {
        startDay,
        endDay,
        totalPlants: expectedPlants,
        availablePlants: expectedPlants,
        buffer: 0,
        effectiveBuffer: 0,
        bufferAdjustedCapacity: expectedPlants,
        bufferAmount: 0,
        originalTotalPlants: expectedPlants,
        month,
        isManual: true,
        plantReadyDays: subtype.plantReadyDays || 0,
        actualSowingDate: sowingDate ? moment(sowingDate, 'DD-MM-YYYY').format('DD-MM-YYYY') : null, // Store actual sowing date
        excessiveSowing: {
          packets: packetsRequested,
          plants: expectedPlants,
        },
        sowingInProgress: false,
        sowingCompleted: false,
        linkedSowingRequests: [newRequest._id],
        slotTrail: [],
      };
      subtypeSlot.slots.push(slot);
    } else {
      // Update existing slot with excessive sowing
      const expectedPlants = packetsRequested * conversionFactor;
      if (!slot.excessiveSowing) {
        slot.excessiveSowing = { packets: 0, plants: 0 };
      }
      slot.excessiveSowing.packets += packetsRequested;
      slot.excessiveSowing.plants += expectedPlants;
      slot.totalPlants += expectedPlants;
      slot.availablePlants += expectedPlants;
      
      // Store actual sowing date if not already set
      if (!slot.actualSowingDate && sowingDate) {
        slot.actualSowingDate = moment(sowingDate, 'DD-MM-YYYY').format('DD-MM-YYYY');
      }
      
      if (!slot.linkedSowingRequests) {
        slot.linkedSowingRequests = [];
      }
      slot.linkedSowingRequests.push(newRequest._id);
    }

    // Log transaction
    logSowingRequestCreated(
      slot,
      newRequest._id,
      packetsRequested,
      req.user._id,
      {
        isExcessive: true,
        notes: `Excessive sowing request: ${packetsRequested} packets`,
      }
    );

    await plantSlotDoc.save();

    // Link request to slot
    newRequest.linkedSlotIds = [slot._id];
    await newRequest.save();

    return res.status(201).json({
      success: true,
      message: 'Excessive sowing request created successfully',
      data: {
        request: newRequest,
        slot: {
          slotId: slot._id,
          startDay: slot.startDay, // This is sowingDate + plantReadyDays (when plants will be ready)
          endDay: slot.endDay,
          totalPlants: slot.totalPlants,
          excessiveSowing: slot.excessiveSowing,
          actualSowingDate: slot.actualSowingDate, // Actual sowing date (for stock issue)
        },
        plantReadyBy: plantReadyBy, // Date when plants will be ready (sowingDate + plantReadyDays)
        plantReadyDays: plantReadyDays,
        sowingDate: sowingDate ? moment(sowingDate, 'DD-MM-YYYY').format('DD-MM-YYYY') : null, // Actual sowing date
      },
    });
  } catch (error) {
    console.error('Error creating excessive sowing request:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create excessive sowing request',
      error: error.message,
    });
  }
};

/**
 * Get all plant/subtypes available for excessive sowing
 * GET /api/v1/sowing/excessive/available-plants
 */
export const getAvailablePlantsForExcessiveSowing = async (req, res) => {
  try {
    console.log('[DEBUG] Fetching plants for excessive sowing...');
    
    // Step 1: Get all plants (no filter on fetch)
    const allPlants = await PlantCms.find({})
      .select('name subtypes sowingAllowed')
      .lean();

    console.log(`[DEBUG] Found ${allPlants.length} total plants in DB`);

    // Filter only plants with sowingAllowed: true
    const plants = allPlants.filter(plant => plant.sowingAllowed === true);
    console.log(`[DEBUG] Filtered to ${plants.length} plants with sowingAllowed=true`);

    const result = [];

    for (const plant of plants) {
      console.log(`[DEBUG] Processing plant: ${plant.name} (${plant._id})`);
      
      const subtypes = plant.subtypes
        .map((st) => ({
          subtypeId: st._id,
          subtypeName: st.name,
          plantReadyDays: st.plantReadyDays || 0,
        }));

      console.log(`[DEBUG] - Found ${subtypes.length} active subtypes`);

      if (subtypes.length > 0) {
        // Step 2: Get all active products for this plant (removed purpose: 'production' filter)
        const products = await Product.find({
          plantId: plant._id,
          isActive: true,
        })
          .populate('primaryUnit secondaryUnit')
          .lean();

        console.log(`[DEBUG] - Found ${products.length} active products (all purposes)`);

        // Step 3: Get available packets for each subtype
        const subtypesWithProducts = [];
        for (const subtype of subtypes) {
          // Find product for this subtype - handle missing plantSubtypeInfo
          const product = products.find((p) => {
            // Check if plantSubtypeInfo exists and has matching subtypeId
            if (p.plantSubtypeInfo && p.plantSubtypeInfo.length > 0) {
              return p.plantSubtypeInfo.some(
                (info) => info.subtypeId?.toString() === subtype.subtypeId.toString()
              );
            }
            // Fallback: check if subtypeId matches directly
            if (p.subtypeId) {
              return p.subtypeId.toString() === subtype.subtypeId.toString();
            }
            return false;
          }) || products[0]; // Use first product as ultimate fallback if no match found

          if (product) {
            console.log(`[DEBUG] -- Subtype ${subtype.subtypeName}: Found matching product ${product.name}`);
            
            // Get conversion factor - handle missing plantSubtypeInfo
            let conversionFactor = 1;
            if (product.plantSubtypeInfo && product.plantSubtypeInfo.length > 0) {
              const plantSubtypeInfo = product.plantSubtypeInfo.find(
                (info) => info.subtypeId?.toString() === subtype.subtypeId.toString()
              );
              conversionFactor = plantSubtypeInfo?.conversionFactor || 1;
            } else {
              // Use product's direct conversionFactor if available
              conversionFactor = product.conversionFactor || 1;
            }

            // Step 4: Get available packets from warehouse batches
            // Use batch remainingQuantity (total warehouse stock)
            const batches = await Batch.find({
              product: product._id,
              status: 'active', // Only active batches
            }).lean();

            console.log(`[DEBUG] -- Found ${batches.length} active batches`);

            // Calculate available packets from batch remainingQuantity
            const availablePackets = batches.reduce((sum, batch) => {
              const remaining = batch.remainingQuantity || 0;
              return sum + remaining;
            }, 0);

            console.log(`[DEBUG] -- Available packets (warehouse stock): ${availablePackets}`);

            // Debug: Check if no batches
            if (batches.length === 0) {
              const allBatches = await Batch.find({
                product: product._id,
              }).select('batchNumber status quantity remainingQuantity').lean();
              console.log(`[DEBUG] -- Total batches for product: ${allBatches.length}`);
              if (allBatches.length > 0) {
                console.log('[DEBUG] -- Sample batch:', {
                  batchNumber: allBatches[0].batchNumber,
                  status: allBatches[0].status,
                  quantity: allBatches[0].quantity,
                  remainingQuantity: allBatches[0].remainingQuantity
                });
              }
            }

            console.log(`[DEBUG] -- Total warehouse stock: ${availablePackets}`);

            subtypesWithProducts.push({
              ...subtype,
              productId: product._id,
              productName: product.name,
              conversionFactor,
              primaryUnit: product.primaryUnit,
              secondaryUnit: product.secondaryUnit,
              availablePackets,
            });
          } else {
            console.log(`[DEBUG] -- Subtype ${subtype.subtypeName}: No matching product found`);
          }
        }

        if (subtypesWithProducts.length > 0) {
          console.log(`[DEBUG] - Adding plant ${plant.name} with ${subtypesWithProducts.length} subtypes to result`);
          result.push({
            plantId: plant._id,
            plantName: plant.name,
            subtypes: subtypesWithProducts,
          });
        } else {
          console.log(`[DEBUG] - Skipping plant ${plant.name}: no subtypes with products`);
        }
      }
    }

    console.log(`[DEBUG] Final result: ${result.length} plants`);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Error fetching available plants for excessive sowing:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch available plants',
      error: error.message,
    });
  }
};

/**
 * Check if excessive sowing card exists for plant/subtype
 * GET /api/v1/sowing/excessive/check-card/:plantId/:subtypeId
 */
export const checkExcessiveSowingCard = async (req, res) => {
  try {
    const { plantId, subtypeId } = req.params;

    // Find today's date
    const today = moment().format('DD-MM-YYYY');
    const year = moment().year();

    // Check if card exists in today's sowing
    const plantSlotDoc = await PlantSlot.findOne({
      plantId,
      year,
      'subtypeSlots.subtypeId': subtypeId,
    }).lean();

    if (!plantSlotDoc) {
      return res.status(200).json({
        success: true,
        exists: false,
        message: 'No card found for this plant/subtype',
      });
    }

    const subtypeSlot = plantSlotDoc.subtypeSlots.find(
      (st) => st.subtypeId?.toString() === subtypeId.toString()
    );

    if (!subtypeSlot) {
      return res.status(200).json({
        success: true,
        exists: false,
        message: 'No subtype slot found',
      });
    }

    // Check for today's or overdue slots with excessive sowing
    const relevantSlots = subtypeSlot.slots.filter((slot) => {
      const slotDate = moment(slot.startDay, 'DD-MM-YYYY');
      const isToday = slotDate.isSame(moment(), 'day');
      const isOverdue = slotDate.isBefore(moment(), 'day');
      const hasExcessiveSowing =
        slot.excessiveSowing?.packets > 0 || slot.excessiveSowing?.plants > 0;

      return (isToday || isOverdue) && hasExcessiveSowing;
    });

    if (relevantSlots.length > 0) {
      return res.status(200).json({
        success: true,
        exists: true,
        message: 'Card exists with excessive sowing',
        data: {
          slots: relevantSlots.map((slot) => ({
            slotId: slot._id,
            startDay: slot.startDay,
            endDay: slot.endDay,
            totalPlants: slot.totalPlants,
            excessiveSowing: slot.excessiveSowing,
            sowingInProgress: slot.sowingInProgress,
            sowingCompleted: slot.sowingCompleted,
          })),
        },
      });
    }

    return res.status(200).json({
      success: true,
      exists: false,
      message: 'No excessive sowing found for today',
    });
  } catch (error) {
    console.error('Error checking excessive sowing card:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check excessive sowing card',
      error: error.message,
    });
  }
};

/**
 * Get all slots with excessive sowing data
 * GET /api/v1/sowing/excessive/all-slots
 */
export const getAllExcessiveSowingSlots = async (req, res) => {
  try {
    // Find all excessive sowing requests
    const excessiveRequests = await SowingRequest.find({ isExcessiveSowing: true })
      .select('_id requestNumber plantId subtypeId linkedSlotIds isExcessiveSowing')
      .lean();
    
    // Create a map of slot IDs to excessive requests
    const slotToRequestMap = new Map();
    excessiveRequests.forEach(req => {
      if (req.linkedSlotIds && req.linkedSlotIds.length > 0) {
        req.linkedSlotIds.forEach(slotId => {
          const slotIdStr = slotId.toString();
          if (!slotToRequestMap.has(slotIdStr)) {
            slotToRequestMap.set(slotIdStr, []);
          }
          slotToRequestMap.get(slotIdStr).push({
            requestId: req._id.toString(),
            requestNumber: req.requestNumber,
          });
        });
      }
    });

    // Find all slots with excessive sowing data
    const plantSlots = await PlantSlot.find({})
      .populate('plantId', 'name subtypes')
      .lean();

    const excessiveSlots = [];

    plantSlots.forEach(plantSlot => {
      plantSlot.subtypeSlots.forEach(subtypeSlot => {
        subtypeSlot.slots.forEach(slot => {
          const excessivePackets = slot.excessiveSowing?.packets || 0;
          const excessivePlants = slot.excessiveSowing?.plants || 0;
          const slotIdStr = slot._id.toString();
          const linkedExcessiveRequests = slotToRequestMap.get(slotIdStr) || [];

          // Include slot if it has excessive sowing data OR is linked to excessive requests
          if (excessivePackets > 0 || excessivePlants > 0 || linkedExcessiveRequests.length > 0) {
            // Get plant name
            const plantName = plantSlot.plantId?.name || 'Unknown';
            
            // Get subtype name
            const plant = plantSlot.plantId;
            let subtypeName = 'Unknown';
            if (plant && plant.subtypes) {
              const subtype = plant.subtypes.find(
                st => st._id.toString() === subtypeSlot.subtypeId?.toString()
              );
              subtypeName = subtype?.name || 'Unknown';
            }

            excessiveSlots.push({
              slotId: slot._id.toString(),
              plantId: plantSlot.plantId?._id?.toString() || 'Unknown',
              plantName: plantName,
              subtypeId: subtypeSlot.subtypeId?.toString() || 'Unknown',
              subtypeName: subtypeName,
              startDay: slot.startDay,
              endDay: slot.endDay,
              month: slot.month,
              excessiveSowing: {
                packets: excessivePackets,
                plants: excessivePlants,
              },
              totalPlants: slot.totalPlants || 0,
              primarySowed: slot.primarySowed || 0,
              availablePlants: slot.availablePlants || 0,
              sowingInProgress: slot.sowingInProgress || false,
              sowingCompleted: slot.sowingCompleted || false,
              actualSowingDate: slot.actualSowingDate || null,
              linkedSowingRequests: slot.linkedSowingRequests?.map(id => id.toString()) || [],
              linkedExcessiveRequests: linkedExcessiveRequests,
              hasExcessiveSowingData: excessivePackets > 0 || excessivePlants > 0,
              isLinkedToExcessiveRequest: linkedExcessiveRequests.length > 0,
            });
          }
        });
      });
    });

    return res.status(200).json({
      success: true,
      message: `Found ${excessiveSlots.length} slots with excessive sowing data`,
      data: {
        slots: excessiveSlots,
        count: excessiveSlots.length,
        summary: {
          totalExcessivePackets: excessiveSlots.reduce((sum, slot) => sum + slot.excessiveSowing.packets, 0),
          totalExcessivePlants: excessiveSlots.reduce((sum, slot) => sum + slot.excessiveSowing.plants, 0),
          slotsWithData: excessiveSlots.filter(s => s.hasExcessiveSowingData).length,
          slotsLinkedToRequests: excessiveSlots.filter(s => s.isLinkedToExcessiveRequest).length,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching excessive sowing slots:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch excessive sowing slots',
      error: error.message,
    });
  }
};

/**
 * Diagnostic endpoint to check data availability
 * GET /api/v1/sowing/excessive/diagnostic
 */
export const getDiagnosticInfo = async (req, res) => {
  try {
    const diagnostic = {};

    // Check plants
    console.log('[DIAGNOSTIC] Checking PlantCms collection...');
    const totalPlants = await PlantCms.countDocuments({});
    console.log('[DIAGNOSTIC] Total plants (no filter):', totalPlants);
    
    const plantsWithSowing = await PlantCms.countDocuments({ 
      sowingAllowed: true 
    });
    console.log('[DIAGNOSTIC] Plants with sowing allowed:', plantsWithSowing);
    
    diagnostic.plants = {
      totalInDB: totalPlants,
      withSowingAllowed: plantsWithSowing,
      withoutSowingAllowed: totalPlants - plantsWithSowing
    };

    // Get sample plant
    const samplePlant = await PlantCms.findOne({})
      .select('name sowingAllowed subtypes')
      .lean();
    
    if (samplePlant) {
      diagnostic.samplePlant = {
        name: samplePlant.name,
        sowingAllowed: samplePlant.sowingAllowed,
        subtypesCount: samplePlant.subtypes?.length || 0
      };
    }

    // Check products
    console.log('[DIAGNOSTIC] Checking Product collection...');
    const totalProducts = await Product.countDocuments({});
    console.log('[DIAGNOSTIC] Total products (no filter):', totalProducts);
    
    const activeProducts = await Product.countDocuments({ isActive: true });
    console.log('[DIAGNOSTIC] Active products:', activeProducts);
    
    const productionProducts = await Product.countDocuments({
      isActive: true,
      purpose: 'production'
    });
    console.log('[DIAGNOSTIC] Products with purpose=production:', productionProducts);

    diagnostic.products = {
      totalInDB: totalProducts,
      totalActive: activeProducts,
      withPurposeProduction: productionProducts,
      otherPurposes: activeProducts - productionProducts
    };

    // Get sample product
    const sampleProduct = await Product.findOne({ isActive: true })
      .select('name purpose plantId plantSubtypeInfo')
      .lean();
    
    if (sampleProduct) {
      diagnostic.sampleProduct = {
        name: sampleProduct.name,
        purpose: sampleProduct.purpose,
        hasPlantId: !!sampleProduct.plantId,
        plantSubtypeInfoCount: sampleProduct.plantSubtypeInfo?.length || 0
      };
    }

    // Check inventory outwards
    const totalOutwards = await InventoryOutward.countDocuments();
    const approvedOutwards = await InventoryOutward.countDocuments({
      status: { $in: ['approved', 'issued'] }
    });
    
    // Count outwards with available stock (quantity > usedQuantity)
    const outwardsWithStock = await InventoryOutward.find({
      status: { $in: ['approved', 'issued'] }
    }).lean();
    
    const outwardsWithAvailable = outwardsWithStock.filter(outward => {
      return outward.items.some(item => {
        const available = (item.quantity || 0) - (item.usedQuantity || 0);
        return available > 0;
      });
    }).length;

    diagnostic.inventoryOutwards = {
      total: totalOutwards,
      approvedOrIssued: approvedOutwards,
      withAvailableStock: outwardsWithAvailable
    };

    // Get sample outward
    const sampleOutward = await InventoryOutward.findOne({
      status: { $in: ['approved', 'issued'] }
    })
      .select('purpose status items')
      .lean();
    
    if (sampleOutward) {
      const itemsWithStock = sampleOutward.items.filter(item => {
        const available = (item.quantity || 0) - (item.usedQuantity || 0);
        return available > 0;
      });
      
      const totalAvailable = sampleOutward.items.reduce((sum, item) => {
        const available = Math.max(0, (item.quantity || 0) - (item.usedQuantity || 0));
        return sum + available;
      }, 0);
      
      diagnostic.sampleOutward = {
        purpose: sampleOutward.purpose,
        status: sampleOutward.status,
        totalItems: sampleOutward.items.length,
        itemsWithStock: itemsWithStock.length,
        totalAvailable,
        calculation: 'Available = quantity - usedQuantity'
      };
    }

    // Recommendations
    diagnostic.recommendations = [];
    
    if (plantsWithSowing === 0) {
      diagnostic.recommendations.push({
        issue: 'No plants have sowingAllowed=true',
        fix: 'Go to Plant CMS → Edit Plant → Enable "Sowing Allowed" checkbox'
      });
    }

    if (productionProducts === 0) {
      diagnostic.recommendations.push({
        issue: 'No products have purpose="production"',
        fix: 'Go to Products → Edit Product → Set Purpose to "production"'
      });
    }

    if (outwardsWithAvailable === 0 && productionOutwards > 0) {
      diagnostic.recommendations.push({
        issue: 'No inventory outward entries with available stock (all stock used)',
        fix: 'Create new inventory outward entries with purpose="production" for seed products'
      });
    } else if (outwardsWithAvailable === 0 && productionOutwards === 0) {
      diagnostic.recommendations.push({
        issue: 'No inventory outward entries with purpose="production"',
        fix: 'Create inventory outward entries: Go to Inventory → Outward → Set purpose="production" → Add seed products'
      });
    }

    return res.status(200).json({
      success: true,
      diagnostic,
    });
  } catch (error) {
    console.error('Error getting diagnostic info:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get diagnostic info',
      error: error.message,
    });
  }
};

/**
 * Fix data - Enable sowing and set purposes
 * POST /api/v1/sowing/excessive/fix-data
 */
export const fixExcessiveSowingData = async (req, res) => {
  try {
    console.log('[FIX] Starting data fix...');
    const results = {};

    // Fix 1: Enable sowingAllowed for all plants
    const plantResult = await PlantCms.updateMany(
      {},
      { $set: { sowingAllowed: true }}
    );
    results.plantsUpdated = plantResult.modifiedCount;
    console.log(`[FIX] Updated ${plantResult.modifiedCount} plants`);

    // Fix 2: Set purpose='production' for products with plantId
    const productResult1 = await Product.updateMany(
      { plantId: { $exists: true, $ne: null }},
      { $set: { purpose: 'production' }}
    );
    results.productsUpdatedByPlantId = productResult1.modifiedCount;
    console.log(`[FIX] Updated ${productResult1.modifiedCount} products by plantId`);

    // Fix 3: Set purpose='production' for seed products by name
    const productResult2 = await Product.updateMany(
      {
        plantId: { $exists: false },
        $or: [
          { name: { $regex: /seed/i }},
          { name: { $regex: /बीज/}},
          { category: { $regex: /seed/i }},
          { category: { $regex: /बीज/}}
        ]
      },
      { $set: { purpose: 'production' }}
    );
    results.productsUpdatedByName = productResult2.modifiedCount;
    console.log(`[FIX] Updated ${productResult2.modifiedCount} products by name/category`);

    // Verify
    const plantsWithSowing = await PlantCms.countDocuments({ sowingAllowed: true });
    const productsWithProduction = await Product.countDocuments({ purpose: 'production' });

    results.verification = {
      plantsWithSowingAllowed: plantsWithSowing,
      productsWithPurposeProduction: productsWithProduction
    };

    console.log('[FIX] Complete!');
    console.log(`[FIX] Plants with sowingAllowed: ${plantsWithSowing}`);
    console.log(`[FIX] Products with purpose=production: ${productsWithProduction}`);

    return res.status(200).json({
      success: true,
      message: 'Data fixed successfully',
      results,
    });
  } catch (error) {
    console.error('Error fixing data:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fix data',
      error: error.message,
    });
  }
};

/**
 * Check inventory stock - Debug endpoint
 * GET /api/v1/sowing/excessive/check-inventory
 */
export const checkInventoryStock = async (req, res) => {
  try {
    const outwards = await InventoryOutward.find({
      status: { $in: ['approved', 'issued'] }
    })
      .populate('items.product', 'name')
      .select('outwardNumber purpose status items')
      .limit(5)
      .lean();

    const inventoryDetails = outwards.map(outward => ({
      outwardNumber: outward.outwardNumber,
      purpose: outward.purpose,
      status: outward.status,
      items: outward.items.map(item => ({
        productName: item.product?.name || 'Unknown',
        quantity: item.quantity || 0,
        usedQuantity: item.usedQuantity || 0,
        available: Math.max(0, (item.quantity || 0) - (item.usedQuantity || 0)),
        calculation: `${item.quantity} - ${item.usedQuantity} = ${Math.max(0, (item.quantity || 0) - (item.usedQuantity || 0))}`
      }))
    }));

    const totalAvailable = outwards.reduce((sum, outward) => {
      return sum + outward.items.reduce((itemSum, item) => {
        return itemSum + Math.max(0, (item.quantity || 0) - (item.usedQuantity || 0));
      }, 0);
    }, 0);

    return res.status(200).json({
      success: true,
      data: {
        totalOutwards: outwards.length,
        totalAvailableAcrossAll: totalAvailable,
        outwards: inventoryDetails,
        message: totalAvailable === 0 
          ? 'All inventory stock has been used. Create new outward entries to add stock.'
          : `${totalAvailable} packets available in inventory`
      }
    });
  } catch (error) {
    console.error('Error checking inventory:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check inventory',
      error: error.message,
    });
  }
};

/**
 * Add test inventory stock - For testing purposes
 * POST /api/v1/sowing/excessive/add-test-stock
 */
export const addTestInventoryStock = async (req, res) => {
  try {
    const { productId, quantity = 100 } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'Product ID is required'
      });
    }

    // Get product details
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Generate outward number
    const count = await InventoryOutward.countDocuments();
    const outwardNumber = `OUT-TEST-${String(count + 1).padStart(4, '0')}`;

    // Create inventory outward with available stock
    const newOutward = await InventoryOutward.create({
      outwardNumber,
      outwardDate: new Date(),
      purpose: 'production',
      status: 'issued',
      items: [{
        product: productId,
        batch: '000000000000000000000000', // Dummy batch ID
        quantity: quantity,
        usedQuantity: 0, // Important: 0 used means all available
        unit: product.primaryUnit,
        rate: 0,
        amount: 0,
        notes: 'Test inventory for excessive sowing'
      }],
      totalAmount: 0,
      issuedBy: req.user._id,
      issuedDate: new Date(),
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      message: `Added ${quantity} packets of ${product.name} to inventory`,
      data: {
        outwardNumber: newOutward.outwardNumber,
        product: product.name,
        quantity,
        available: quantity,
        calculation: `${quantity} - 0 = ${quantity}`
      }
    });
  } catch (error) {
    console.error('Error adding test stock:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to add test stock',
      error: error.message,
    });
  }
};

/**
 * Analyze inventory purpose breakdown
 * GET /api/v1/sowing/excessive/analyze-inventory-purpose/:productId
 */
export const analyzeInventoryPurpose = async (req, res) => {
  try {
    const { productId } = req.params;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid product ID is required'
      });
    }

    // Get all inventory entries for this product
    const allEntries = await InventoryOutward.find({
      'items.product': new mongoose.Types.ObjectId(productId),
      status: { $in: ['approved', 'issued'] }
    })
      .select('purpose status items outwardNumber outwardDate')
      .lean();

    const byPurpose = {};
    let totalPackets = 0;
    let totalProduction = 0;

    allEntries.forEach(entry => {
      const purpose = entry.purpose || 'undefined';
      
      if (!byPurpose[purpose]) {
        byPurpose[purpose] = {
          count: 0,
          packets: 0,
          entries: []
        };
      }

      // Find matching items
      const matchingItems = entry.items.filter(
        item => item.product?.toString() === productId
      );

      matchingItems.forEach(item => {
        const available = Math.max(0, (item.quantity || 0) - (item.usedQuantity || 0));
        
        byPurpose[purpose].count++;
        byPurpose[purpose].packets += available;
        byPurpose[purpose].entries.push({
          outwardNumber: entry.outwardNumber,
          outwardDate: entry.outwardDate,
          quantity: item.quantity,
          usedQuantity: item.usedQuantity,
          available
        });

        totalPackets += available;
        if (purpose === 'production') {
          totalProduction += available;
        }
      });
    });

    return res.status(200).json({
      success: true,
      productId,
      totalEntries: allEntries.length,
      breakdown: byPurpose,
      summary: {
        totalPackets,
        productionOnly: totalProduction,
        otherPurposes: totalPackets - totalProduction,
        explanation: `When filtering by purpose='production', only ${totalProduction} packets were found. After removing the filter, all ${totalPackets} packets are now visible.`
      }
    });
  } catch (error) {
    console.error('[analyzeInventoryPurpose] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to analyze inventory purpose',
      error: error.message
    });
  }
};

export default {
  createExcessiveSowingRequest,
  getAvailablePlantsForExcessiveSowing,
  checkExcessiveSowingCard,
  getDiagnosticInfo,
  fixExcessiveSowingData,
  checkInventoryStock,
  addTestInventoryStock,
  analyzeInventoryPurpose,
};








