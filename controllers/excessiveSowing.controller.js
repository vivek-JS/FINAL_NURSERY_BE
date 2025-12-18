import PlantCms from '../models/plantCms.model.js';
import PlantSlot from '../models/slots.model.js';
import SowingRequest from '../models/sowingRequest.model.js';
import Product from '../models/product.model.js';
import InventoryOutward from '../models/inventoryOutward.model.js';
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

    // Get product (seed) for this subtype
    // Try multiple strategies to find a matching product
    let product = await Product.findOne({
      plantId,
      'plantSubtypeInfo.subtypeId': subtypeId,
      purpose: 'production',
    }).populate('primaryUnit secondaryUnit');

    // Fallback 1: Find by plantId only
    if (!product) {
      product = await Product.findOne({
        plantId,
        purpose: 'production',
      }).populate('primaryUnit secondaryUnit');
    }

    // Fallback 2: Find any production product
    if (!product) {
      const products = await Product.find({
        purpose: 'production',
        isActive: true,
      }).populate('primaryUnit secondaryUnit').limit(1);
      product = products[0];
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'No seed product found for this plant/subtype. Please ensure products have purpose="production" and are linked to plants.',
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
    };

    const newRequest = await SowingRequest.create(requestData);

    // Find or create slot for this request
    // Use the provided sowingDate or default to today + 7 days
    const targetSowingDate = sowingDate
      ? moment(sowingDate, 'DD-MM-YYYY')
      : moment().add(7, 'days');
    
    const startDay = targetSowingDate.format('DD-MM-YYYY');
    const endDay = startDay; // Single-day slot
    const month = targetSowingDate.format('MMMM');
    const year = targetSowingDate.year();

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
          startDay: slot.startDay,
          endDay: slot.endDay,
          totalPlants: slot.totalPlants,
          excessiveSowing: slot.excessiveSowing,
        },
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
    
    // Step 1: Get all plants with sowing allowed
    const plants = await PlantCms.find({
      sowingAllowed: true,
    })
      .select('name subtypes')
      .lean();

    console.log(`[DEBUG] Found ${plants.length} plants with sowingAllowed=true`);

    // Check if no plants found, try to see total plants
    if (plants.length === 0) {
      const allPlants = await PlantCms.find({})
        .select('name sowingAllowed')
        .lean();
      console.log(`[DEBUG] Total plants in DB: ${allPlants.length}`);
      console.log('[DEBUG] Plants with sowingAllowed:', allPlants.filter(p => p.sowingAllowed).length);
    }

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
        // Step 2: Get seed products for this plant
        const products = await Product.find({
          plantId: plant._id,
          purpose: 'production',
          isActive: true,
        })
          .populate('primaryUnit secondaryUnit')
          .lean();

        console.log(`[DEBUG] - Found ${products.length} products with purpose='production'`);

        // Check if no products, try without purpose filter
        if (products.length === 0) {
          const allProducts = await Product.find({
            plantId: plant._id,
            isActive: true,
          }).select('name purpose').lean();
          console.log(`[DEBUG] - Total active products for plant: ${allProducts.length}`);
          if (allProducts.length > 0) {
            console.log('[DEBUG] - Product purposes:', allProducts.map(p => p.purpose));
          }
        }

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
          }) || products[0]; // Use first product as ultimate fallback

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

            // Step 4: Get available packets from inventory
            // Available = quantity - usedQuantity
            const outwardEntries = await InventoryOutward.find({
              'items.product': product._id,
              purpose: 'production',
              status: { $in: ['approved', 'issued'] }, // Only approved/issued entries
            }).lean();

            console.log(`[DEBUG] -- Found ${outwardEntries.length} outward entries with purpose=production`);

            // Calculate available packets (quantity - usedQuantity)
            const availablePackets = outwardEntries.reduce((sum, outward) => {
              const items = outward.items.filter(
                (item) => item.product?.toString() === product._id.toString()
              );
              
              const itemTotal = items.reduce((itemSum, item) => {
                const quantity = item.quantity || 0;
                const usedQuantity = item.usedQuantity || 0;
                const available = Math.max(0, quantity - usedQuantity);
                return itemSum + available;
              }, 0);
              
              return sum + itemTotal;
            }, 0);

            console.log(`[DEBUG] -- Available packets calculated: ${availablePackets}`);

            // Debug: Check if no inventory
            if (outwardEntries.length === 0) {
              const allOutwards = await InventoryOutward.find({
                'items.product': product._id,
              }).select('purpose status items').lean();
              console.log(`[DEBUG] -- Total outward entries for product: ${allOutwards.length}`);
              if (allOutwards.length > 0) {
                console.log('[DEBUG] -- Sample outward:', {
                  purpose: allOutwards[0].purpose,
                  status: allOutwards[0].status,
                  itemsCount: allOutwards[0].items.length
                });
              }
            }

            console.log(`[DEBUG] -- Available packets: ${availablePackets}`);

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
    const productionOutwards = await InventoryOutward.countDocuments({
      purpose: 'production',
      status: { $in: ['approved', 'issued'] }
    });
    
    // Count outwards with available stock (quantity > usedQuantity)
    const outwardsWithStock = await InventoryOutward.find({
      purpose: 'production',
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
      withPurposeProduction: productionOutwards,
      withAvailableStock: outwardsWithAvailable
    };

    // Get sample outward
    const sampleOutward = await InventoryOutward.findOne({
      purpose: 'production',
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
      purpose: 'production',
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

export default {
  createExcessiveSowingRequest,
  getAvailablePlantsForExcessiveSowing,
  checkExcessiveSowingCard,
  getDiagnosticInfo,
  fixExcessiveSowingData,
  checkInventoryStock,
  addTestInventoryStock,
};
