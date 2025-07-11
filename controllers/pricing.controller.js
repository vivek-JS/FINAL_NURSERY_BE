import Pricing from "../models/pricing.model.js";
import PlantCms from "../models/plantCms.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";

// Create or Update Pricing
export const createOrUpdatePricing = catchAsync(async (req, res, next) => {
  const { plantId, subtypeId, plantName, subtypeName, costPrice, salePrice, overhead } = req.body;

  if (!plantId || !subtypeId || !costPrice || !salePrice) {
    return next(new AppError("Plant ID, Subtype ID, cost price, and sale price are required", 400));
  }

  // Validate that the plant and subtype exist
  const plant = await PlantCms.findById(plantId);
  if (!plant) {
    return next(new AppError("Plant not found", 404));
  }

  const subtype = plant.subtypes.id(subtypeId);
  if (!subtype) {
    return next(new AppError("Subtype not found", 404));
  }

  // Check if pricing already exists
  let pricing = await Pricing.findOne({ plantId, subtypeId });

  if (pricing) {
    // Update existing pricing
    pricing.costPrice = costPrice;
    pricing.salePrice = salePrice;
    pricing.overhead = overhead || 0;
    pricing.plantName = plantName || plant.name;
    pricing.subtypeName = subtypeName || subtype.name;
    pricing.updatedBy = req.user?._id;
    
    await pricing.save();
  } else {
    // Create new pricing
    pricing = new Pricing({
      plantId,
      subtypeId,
      plantName: plantName || plant.name,
      subtypeName: subtypeName || subtype.name,
      costPrice,
      salePrice,
      overhead: overhead || 0,
      updatedBy: req.user?._id,
    });
    
    await pricing.save();
  }

  res.status(200).json({
    success: true,
    message: "Pricing saved successfully",
    data: pricing,
  });
});

// Get All Pricing
export const getAllPricing = catchAsync(async (req, res, next) => {
  const pricing = await Pricing.find({ isActive: true })
    .populate('plantId', 'name')
    .populate('updatedBy', 'name')
    .sort({ plantName: 1, subtypeName: 1 });

  res.status(200).json({
    success: true,
    count: pricing.length,
    data: pricing,
  });
});

// Get Pricing by Plant
export const getPricingByPlant = catchAsync(async (req, res, next) => {
  const { plantId } = req.params;

  if (!plantId) {
    return next(new AppError("Plant ID is required", 400));
  }

  const pricing = await Pricing.findByPlant(plantId);

  res.status(200).json({
    success: true,
    count: pricing.length,
    data: pricing,
  });
});

// Get Pricing by Plant and Subtype
export const getPricingByPlantSubtype = catchAsync(async (req, res, next) => {
  const { plantId, subtypeId } = req.params;

  if (!plantId || !subtypeId) {
    return next(new AppError("Plant ID and Subtype ID are required", 400));
  }

  const pricing = await Pricing.findByPlantSubtype(plantId, subtypeId);

  if (!pricing) {
    return next(new AppError("Pricing not found", 404));
  }

  res.status(200).json({
    success: true,
    data: pricing,
  });
});

// Delete Pricing
export const deletePricing = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!id) {
    return next(new AppError("Pricing ID is required", 400));
  }

  const pricing = await Pricing.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true }
  );

  if (!pricing) {
    return next(new AppError("Pricing not found", 404));
  }

  res.status(200).json({
    success: true,
    message: "Pricing deleted successfully",
    data: pricing,
  });
});

// Get Pricing Analytics
export const getPricingAnalytics = catchAsync(async (req, res, next) => {
  const analytics = await Pricing.aggregate([
    {
      $match: { isActive: true }
    },
    {
      $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        avgCostPrice: { $avg: "$costPrice" },
        avgSalePrice: { $avg: "$salePrice" },
        avgMargin: { $avg: "$margin" },
        totalProfitPerUnit: { $sum: "$profitPerUnit" },
        highestMargin: { $max: "$margin" },
        lowestMargin: { $min: "$margin" },
      }
    }
  ]);

  // Get top profitable products
  const topProfitable = await Pricing.find({ isActive: true })
    .sort({ profitPerUnit: -1 })
    .limit(10)
    .select('plantName subtypeName costPrice salePrice margin profitPerUnit');

  // Get low margin products
  const lowMargin = await Pricing.find({ isActive: true })
    .sort({ margin: 1 })
    .limit(10)
    .select('plantName subtypeName costPrice salePrice margin profitPerUnit');

  res.status(200).json({
    success: true,
    data: {
      summary: analytics[0] || {},
      topProfitable,
      lowMargin,
    },
  });
});

// Get Plants without Pricing
export const getPlantsWithoutPricing = catchAsync(async (req, res, next) => {
  // Get all plants
  const plants = await PlantCms.find({});
  
  // Get all pricing data
  const pricing = await Pricing.find({ isActive: true });
  
  // Create a map of existing pricing
  const pricingMap = new Map();
  pricing.forEach(p => {
    pricingMap.set(`${p.plantId}-${p.subtypeId}`, true);
  });
  
  // Find plants/subtypes without pricing
  const missingPricing = [];
  
  plants.forEach(plant => {
    plant.subtypes.forEach(subtype => {
      const key = `${plant._id}-${subtype._id}`;
      if (!pricingMap.has(key)) {
        missingPricing.push({
          plantId: plant._id,
          plantName: plant.name,
          subtypeId: subtype._id,
          subtypeName: subtype.name,
        });
      }
    });
  });

  res.status(200).json({
    success: true,
    count: missingPricing.length,
    data: missingPricing,
  });
});

// Bulk Update Pricing
export const bulkUpdatePricing = catchAsync(async (req, res, next) => {
  const { updates } = req.body;

  if (!Array.isArray(updates) || updates.length === 0) {
    return next(new AppError("Updates array is required", 400));
  }

  const results = [];
  
  for (const update of updates) {
    const { plantId, subtypeId, costPrice, salePrice, overhead } = update;
    
    if (!plantId || !subtypeId || !costPrice || !salePrice) {
      continue;
    }

    try {
      let pricing = await Pricing.findOne({ plantId, subtypeId });
      
      if (pricing) {
        pricing.costPrice = costPrice;
        pricing.salePrice = salePrice;
        pricing.overhead = overhead || 0;
        pricing.updatedBy = req.user?._id;
        await pricing.save();
      } else {
        const plant = await PlantCms.findById(plantId);
        if (plant) {
          const subtype = plant.subtypes.id(subtypeId);
          if (subtype) {
            pricing = new Pricing({
              plantId,
              subtypeId,
              plantName: plant.name,
              subtypeName: subtype.name,
              costPrice,
              salePrice,
              overhead: overhead || 0,
              updatedBy: req.user?._id,
            });
            await pricing.save();
          }
        }
      }
      
      results.push({
        plantId,
        subtypeId,
        success: true,
        data: pricing,
      });
    } catch (error) {
      results.push({
        plantId,
        subtypeId,
        success: false,
        error: error.message,
      });
    }
  }

  res.status(200).json({
    success: true,
    message: "Bulk update completed",
    data: results,
  });
}); 