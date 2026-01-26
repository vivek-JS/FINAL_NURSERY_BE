import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import RamAgriSalesTarget from "../models/ramAgriSalesTarget.model.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import mongoose from "mongoose";

const buildRangeKey = (startDate, endDate) => {
  const startKey = new Date(startDate).toISOString().slice(0, 10);
  const endKey = new Date(endDate).toISOString().slice(0, 10);
  return `${startKey}_${endKey}`;
};

export const getRamAgriSalesTargets = catchAsync(async (req, res, next) => {
  const { userId, startDate, endDate } = req.query;

  const filter = {};
  if (userId && mongoose.isValidObjectId(userId)) {
    filter.userId = new mongoose.Types.ObjectId(userId);
  }

  if (startDate && endDate) {
    filter.rangeKey = buildRangeKey(startDate, endDate);
  }

  // Fetch targets with proper indexing and selective population
  const targets = await RamAgriSalesTarget.find(filter)
    .populate("userId", "name phoneNumber jobTitle")
    .populate("cropId", "cropName productType")
    .select("userId cropId varietyId startDate endDate rangeKey targetAmount createdAt updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  // Calculate achieved amounts for each target by aggregating orders
  const targetsWithAchieved = await Promise.all(
    targets.map(async (target) => {
      // Build query to match orders to this target
      const orderMatch = {
        createdBy: target.userId._id || target.userId,
        isRamAgriProduct: true,
        ramAgriCropId: target.cropId._id || target.cropId,
        ramAgriVarietyId: target.varietyId,
        orderDate: {
          $gte: new Date(target.startDate),
          $lte: new Date(target.endDate),
        },
        orderStatus: {
          $in: ["ACCEPTED", "DISPATCHED", "COMPLETED"], // Only count completed/active orders
        },
      };

      // Aggregate orders to calculate achieved amount and get product details
      const orderAggregation = await AgriSalesOrder.aggregate([
        {
          $match: orderMatch,
        },
        {
          $group: {
            _id: null,
            achievedAmount: {
              $sum: "$totalAmount", // Sum of totalAmount from all matching orders
            },
            orderCount: {
              $sum: 1,
            },
            // Also calculate based on delivered quantity for completed orders
            achievedAmountDelivered: {
              $sum: {
                $cond: [
                  { $eq: ["$orderStatus", "COMPLETED"] },
                  { $multiply: ["$deliveredQuantity", "$rate"] },
                  "$totalAmount",
                ],
              },
            },
            // Collect product names and details
            products: {
              $push: {
                productName: "$productName",
                ramAgriCropName: "$ramAgriCropName",
                ramAgriVarietyName: "$ramAgriVarietyName",
                quantity: "$quantity",
                rate: "$rate",
                totalAmount: "$totalAmount",
                orderNumber: "$orderNumber",
                orderDate: "$orderDate",
                orderStatus: "$orderStatus",
              },
            },
          },
        },
      ]);

      const achievedData = orderAggregation[0] || {
        achievedAmount: 0,
        orderCount: 0,
        achievedAmountDelivered: 0,
        products: [],
      };

      // Calculate progress percentage
      const progressPercent =
        target.targetAmount > 0
          ? Math.min((achievedData.achievedAmount / target.targetAmount) * 100, 100)
          : 0;

      // Get unique product names from orders (for display)
      const productNames = achievedData.products 
        ? [...new Set(achievedData.products.map(p => p.productName || p.ramAgriCropName || "Unknown").filter(Boolean))]
        : [];

      return {
        ...target,
        achievedAmount: achievedData.achievedAmount || 0,
        achievedAmountDelivered: achievedData.achievedAmountDelivered || 0,
        orderCount: achievedData.orderCount || 0,
        progressPercent: Math.round(progressPercent * 100) / 100, // Round to 2 decimal places
        remainingAmount: Math.max(0, target.targetAmount - (achievedData.achievedAmount || 0)),
        // Product details - what was sold to achieve this target
        achievedProducts: productNames, // Array of product names (e.g., ["Phosphoric Acid", "Seaweed"])
        achievedOrders: achievedData.products || [], // Full order details for reference
      };
    })
  );

  const response = generateResponse(
    "Success",
    "Ram Agri sales targets fetched successfully",
    targetsWithAchieved,
    undefined
  );

  return res.status(200).json(response);
});

export const upsertRamAgriSalesTarget = catchAsync(async (req, res, next) => {
  const { userId, startDate, endDate, targets } = req.body;

  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({
      status: "Error",
      message: "Valid userId is required",
    });
  }

  if (!startDate || !endDate) {
    return res.status(400).json({
      status: "Error",
      message: "startDate and endDate are required",
    });
  }

  if (!Array.isArray(targets)) {
    return res.status(400).json({
      status: "Error",
      message: "targets array is required",
    });
  }

  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);
  const rangeKey = buildRangeKey(startDateObj, endDateObj);
  const userIdObj = new mongoose.Types.ObjectId(userId);

  // Log input for debugging
  console.log(`Processing targets: userId=${userId}, rangeKey=${rangeKey}, targets count=${targets.length}`);
  console.log(`Input targets:`, JSON.stringify(targets, null, 2));

  // Drop old conflicting index if it exists (userId_1_rangeKey_1)
  // This old index conflicts with our compound unique index
  try {
    const indexes = await RamAgriSalesTarget.collection.getIndexes();
    const indexNames = Object.keys(indexes);
    const oldIndexName = indexNames.find(name => 
      name === "userId_1_rangeKey_1" || 
      (name.includes("userId") && name.includes("rangeKey") && !name.includes("cropId") && !name.includes("varietyId"))
    );
    
    if (oldIndexName) {
      console.log(`Dropping old conflicting index: ${oldIndexName}`);
      await RamAgriSalesTarget.collection.dropIndex(oldIndexName);
      console.log(`Successfully dropped index: ${oldIndexName}`);
    }
  } catch (indexError) {
    // Ignore errors if index doesn't exist or can't be dropped
    console.warn(`Could not drop old index (this is OK if it doesn't exist):`, indexError.message);
  }

  // Use a session/transaction to ensure atomicity
  const session = await mongoose.startSession();
  session.startTransaction();

  let finalValidatedTargets = []; // Declare outside try block for error handling

  try {
    // Delete existing targets for this user and date range first
    // Use ObjectId for proper query matching - this ensures we remove old targets before inserting new ones
    const deleteResult = await RamAgriSalesTarget.deleteMany({ 
      userId: userIdObj, 
      rangeKey: rangeKey 
    }).session(session);
    
    console.log(`Deleted ${deleteResult.deletedCount} existing targets for userId: ${userId}, rangeKey: ${rangeKey}`);
    
    // Verify deletion worked by checking if any documents still exist
    const remainingCount = await RamAgriSalesTarget.countDocuments({ 
      userId: userIdObj, 
      rangeKey: rangeKey 
    }).session(session);
    
    if (remainingCount > 0) {
      console.warn(`WARNING: ${remainingCount} targets still exist after deleteMany. Attempting to delete again...`);
      await RamAgriSalesTarget.deleteMany({ 
        userId: userIdObj, 
        rangeKey: rangeKey 
      }).session(session);
    }

    // Sanitize and validate targets
    const sanitizedTargets = targets
      .filter((item) => {
        // Validate that all required fields are present and valid ObjectIds
        return (
          item?.cropId &&
          mongoose.isValidObjectId(item.cropId) &&
          item?.varietyId &&
          mongoose.isValidObjectId(item.varietyId) &&
          Number(item.targetAmount || 0) > 0
        );
      })
      .map((item) => {
        // Ensure all ObjectId fields are properly set
        const target = {
          userId: userIdObj,
          cropId: new mongoose.Types.ObjectId(item.cropId),
          varietyId: new mongoose.Types.ObjectId(item.varietyId),
          startDate: startDateObj,
          endDate: endDateObj,
          rangeKey,
          targetAmount: Math.max(Number(item.targetAmount || 0), 0),
        };
        
        // Only set createdBy/updatedBy if req.user exists
        if (req.user?._id || req.user?.id) {
          target.createdBy = new mongoose.Types.ObjectId(req.user._id || req.user.id);
          target.updatedBy = new mongoose.Types.ObjectId(req.user._id || req.user.id);
        }
        
        return target;
      });

    // Deduplicate targets based on the unique index fields (userId, rangeKey, cropId, varietyId)
    // Convert ObjectIds to strings for proper comparison
    // If duplicates exist, keep the one with the highest targetAmount
    const uniqueTargetsMap = new Map();
    const duplicateCount = { count: 0 };
    
    sanitizedTargets.forEach((target, index) => {
      // Convert all ObjectIds to strings for consistent key generation
      const userIdStr = target.userId.toString();
      const cropIdStr = target.cropId.toString();
      const varietyIdStr = target.varietyId.toString();
      const key = `${userIdStr}_${target.rangeKey}_${cropIdStr}_${varietyIdStr}`;
      
      const existing = uniqueTargetsMap.get(key);
      if (existing) {
        duplicateCount.count++;
        console.warn(`Duplicate target found at index ${index}: ${key}. Keeping one with higher amount.`);
        // Keep the one with higher targetAmount
        if (target.targetAmount > existing.targetAmount) {
          uniqueTargetsMap.set(key, target);
        }
      } else {
        uniqueTargetsMap.set(key, target);
      }
    });

    const finalTargets = Array.from(uniqueTargetsMap.values());
    
    // Additional validation: Check for duplicates one more time using ObjectId comparison
    const seen = new Set();
    const validatedTargets = [];
    for (const target of finalTargets) {
      const checkKey = `${target.userId.toString()}_${target.rangeKey}_${target.cropId.toString()}_${target.varietyId.toString()}`;
      if (!seen.has(checkKey)) {
        seen.add(checkKey);
        validatedTargets.push(target);
      } else {
        console.warn(`Duplicate target detected in final validation and removed: ${checkKey}`);
      }
    }
    
    finalValidatedTargets = validatedTargets;
    
    // Final safety check: Verify no duplicates remain using a Set with proper ObjectId comparison
    const finalCheckSet = new Set();
    const trulyUniqueTargets = [];
    for (const target of finalValidatedTargets) {
      // Create a unique key using ObjectId strings
      const uniqueKey = `${target.userId.toString()}_${target.rangeKey}_${target.cropId.toString()}_${target.varietyId.toString()}`;
      if (!finalCheckSet.has(uniqueKey)) {
        finalCheckSet.add(uniqueKey);
        trulyUniqueTargets.push(target);
      } else {
        console.error(`CRITICAL: Duplicate still found after all deduplication: ${uniqueKey}`);
      }
    }
    
    finalValidatedTargets = trulyUniqueTargets;
    
    console.log(`Target processing: ${targets.length} input, ${sanitizedTargets.length} sanitized, ${duplicateCount.count} duplicates removed, ${finalValidatedTargets.length} final unique targets`);
    
    // Log final targets before insertion for debugging
    console.log(`Final targets to insert:`, finalValidatedTargets.map(t => ({
      userId: t.userId.toString(),
      rangeKey: t.rangeKey,
      cropId: t.cropId.toString(),
      varietyId: t.varietyId.toString(),
      targetAmount: t.targetAmount,
    })));

    // Insert new targets using individual findOneAndUpdate operations sequentially
    // Sequential execution avoids any potential race conditions within the transaction
    if (finalValidatedTargets.length > 0) {
      let successCount = 0;
      let errorCount = 0;
      
      for (let index = 0; index < finalValidatedTargets.length; index++) {
        const target = finalValidatedTargets[index];
        try {
          const result = await RamAgriSalesTarget.findOneAndUpdate(
            {
              userId: target.userId,
              rangeKey: target.rangeKey,
              cropId: target.cropId,
              varietyId: target.varietyId,
            },
            {
              $set: {
                startDate: target.startDate,
                endDate: target.endDate,
                targetAmount: target.targetAmount,
                updatedBy: target.updatedBy,
                updatedAt: new Date(),
              },
              $setOnInsert: {
                createdBy: target.createdBy,
                createdAt: new Date(),
              },
            },
            {
              upsert: true,
              new: true,
              session: session,
              runValidators: false, // Skip validators for performance
            }
          );
          successCount++;
        } catch (err) {
          errorCount++;
          console.error(`Error inserting target at index ${index}:`, {
            target: {
              userId: target.userId.toString(),
              rangeKey: target.rangeKey,
              cropId: target.cropId.toString(),
              varietyId: target.varietyId.toString(),
            },
            error: {
              code: err.code,
              message: err.message,
              name: err.name,
              keyPattern: err.keyPattern,
              keyValue: err.keyValue,
              errmsg: err.errmsg,
            },
          });
          throw err; // Re-throw to abort transaction
        }
      }
      
      console.log(`Successfully inserted/updated ${successCount} targets, ${errorCount} errors`);
    }

    // Commit the transaction
    await session.commitTransaction();

    // Fetch the results after successful commit
    const result = await RamAgriSalesTarget.find({ userId: userIdObj, rangeKey })
      .populate("userId", "name phoneNumber jobTitle")
      .populate("cropId", "cropName productType")
      .sort({ createdAt: -1 })
      .lean();

    const response = generateResponse(
      "Success",
      "Ram Agri sales targets saved successfully",
      result,
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    // Abort transaction on error
    await session.abortTransaction();
    
    // Log full error details for debugging
    console.error("Error saving targets - Full error object:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    console.error("Error saving targets - Summary:", {
      code: error.code,
      message: error.message,
      name: error.name,
      keyPattern: error.keyPattern,
      keyValue: error.keyValue,
      errmsg: error.errmsg,
      userId,
      rangeKey,
      targetsCount: targets?.length,
      finalValidatedTargetsCount: finalValidatedTargets?.length,
    });
    
    // Handle duplicate key errors gracefully
    if (error.code === 11000 || error.code === 11001 || error.name === 'MongoServerError' || error.message?.includes('duplicate')) {
      // Try to extract duplicate information from various error formats
      let duplicateFields = "unknown";
      let duplicateValues = "unknown";
      
      if (error.keyPattern && error.keyValue) {
        duplicateFields = Object.keys(error.keyPattern).join(", ");
        duplicateValues = Object.entries(error.keyValue)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ");
      } else if (error.errmsg) {
        // Try to parse from errmsg
        const match = error.errmsg.match(/index:\s*([^\s]+)\s+dup key:\s*\{[^}]*\}/);
        if (match) {
          duplicateFields = match[1];
        }
        const valueMatch = error.errmsg.match(/dup key:\s*\{([^}]+)\}/);
        if (valueMatch) {
          duplicateValues = valueMatch[1];
        }
      }
      
      return res.status(400).json({
        status: "Error",
        message: `Duplicate target detected. Fields: ${duplicateFields}. Values: ${duplicateValues}. Please ensure each crop-variety combination is unique for this user and date range.`,
        details: {
          duplicateFields,
          duplicateValues,
          errorCode: error.code,
          errorMessage: error.message,
        },
      });
    }
    
    // Re-throw other errors to be handled by error middleware
    throw error;
  } finally {
    // End the session
    session.endSession();
  }
});
