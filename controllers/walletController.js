import DealerWallet from "../models/dealerWallet.js";
import Order from "../models/order.model.js";
import catchAsync from "../utility/catchAsync.js";
import mongoose from "mongoose";
import moment from 'moment';
import {
  aggregateDerivedFromOrders,
  attachReconcileHintsToPlantDetails,
  getWalletPlantDetailsWithDerivedOverlay,
  reconcileDealerWalletEntries,
} from "../utils/dealerWalletReconcile.js";

const getDealerWalletDetails = catchAsync(async (req, res) => {
  const { dealerId } = req.params;
  const wantReconcile =
    req.query.reconcile === "1" || req.query.reconcile === "true";

  // First get dealer's orders and calculate total order amount
  // totalOrderAmount = rate * (numberOfPlants + additionalPlants) for each order
  // totalPaidAmount = sum of COLLECTED payments only (excludes PENDING/REJECTED)
  const orderDetails = await Order.aggregate([
    {
      $match: {
        dealer: new mongoose.Types.ObjectId(dealerId)
      }
    },
    {
      $group: {
        _id: null,
        totalOrderAmount: {
          $sum: {
            $multiply: [
              "$rate",
              { $add: [{ $ifNull: ["$numberOfPlants", 0] }, { $ifNull: ["$additionalPlants", 0] }] }
            ]
          }
        },
        totalPaidAmount: {
          $sum: {
            $reduce: {
              input: {
                $filter: {
                  input: "$payment",
                  as: "payment",
                  cond: { $eq: ["$$payment.paymentStatus", "COLLECTED"] }
                }
              },
              initialValue: 0,
              in: { $add: ["$$value", { $ifNull: ["$$this.paidAmount", 0] }] }
            }
          }
        }
      }
    }
  ]);

  const walletInfoAgg = await DealerWallet.aggregate([
    { $match: { dealer: new mongoose.Types.ObjectId(dealerId) } },
    { $project: { availableAmount: 1, _id: 0 } },
    { $limit: 1 },
  ]);
  const walletInfo = walletInfoAgg[0] || { availableAmount: 0 };

  // Combine all details
  const financialDetails = orderDetails[0] || { 
    totalOrderAmount: 0, 
    totalPaidAmount: 0 
  };

  // Calculate pending payment (total order amount - total paid amount)
  const pendingPayment = financialDetails.totalOrderAmount - financialDetails.totalPaidAmount;

  let plantDetails = await getWalletPlantDetailsWithDerivedOverlay(dealerId);
  if (wantReconcile && plantDetails.length > 0) {
    const derivedMap = await aggregateDerivedFromOrders(dealerId);
    plantDetails = attachReconcileHintsToPlantDetails(plantDetails, derivedMap);
  }

  // Format response
  return res.status(200).json({
    status: "success",
    data: {
      financial: {
        availableAmount: walletInfo.availableAmount,
        totalOrderAmount: financialDetails.totalOrderAmount,
        totalPaidAmount: financialDetails.totalPaidAmount,
        pendingPayment: pendingPayment,
        remainingAmount: pendingPayment // Keep for backward compatibility
      },
      plantDetails,
    },
  });
});

/**
 * SUPER_ADMIN: apply Order-derived corrections to wallet entries (bulk vs farmer booked).
 */
const postReconcileDealerWallet = catchAsync(async (req, res) => {
  const { dealerId } = req.params;
  const dryRun = req.body?.dryRun !== false && req.body?.dryRun !== "false";

  const result = await reconcileDealerWalletEntries(dealerId, { dryRun });
  return res.status(200).json({
    status: "success",
    data: result,
  });
});

const getDealerWalletSummary = async (req, res) => {
  try {
    const { startDate, endDate, dealerName, bookingSlotId } = req.query;

    let pipeline = [
      {
        $lookup: {
          from: 'users',
          localField: 'dealer',
          foreignField: '_id',
          as: 'dealerInfo'
        }
      }
    ];

    if (dealerName) {
      pipeline.push({
        $match: {
          'dealerInfo.name': { $regex: dealerName, $options: 'i' }
        }
      });
    }

    // Unwind entries for detailed processing
    pipeline.push(
      { $unwind: { path: "$entries", preserveNullAndEmptyArrays: true } }
    );

    // Add plant and subtype lookups
    pipeline.push(
      {
        $lookup: {
          from: 'plantcms',
          localField: 'entries.plantType',
          foreignField: '_id',
          as: 'plantInfo'
        }
      },
      {
        $lookup: {
          from: 'plantcms',
          let: { subTypeId: "$entries.subType" },
          pipeline: [
            { $unwind: "$subtypes" },
            {
              $match: {
                $expr: { $eq: ["$subtypes._id", "$$subTypeId"] }
              }
            }
          ],
          as: 'subtypeInfo'
        }
      }
    );

    // Booking slot lookup and filtering
    pipeline.push({
      $lookup: {
        from: 'plantslots',
        let: { slotId: "$entries.bookingSlot" },
        pipeline: [
          { $unwind: "$subtypeSlots" },
          { $unwind: "$subtypeSlots.slots" },
          {
            $match: {
              $expr: { $eq: ["$subtypeSlots.slots._id", "$$slotId"] }
            }
          }
        ],
        as: 'slotInfo'
      }
    });

    // Apply date range and booking slot filters
    if (startDate || endDate || bookingSlotId) {
      let dateFilter = {};
      
      if (startDate && endDate) {
        dateFilter = {
          'slotInfo.subtypeSlots.slots.startDay': {
            $gte: moment(startDate, 'YYYY-MM-DD').format('DD-MM-YYYY')
          },
          'slotInfo.subtypeSlots.slots.endDay': {
            $lte: moment(endDate, 'YYYY-MM-DD').format('DD-MM-YYYY')
          }
        };
      }

      if (bookingSlotId) {
        dateFilter['entries.bookingSlot'] = new mongoose.Types.ObjectId(bookingSlotId);
      }

      if (Object.keys(dateFilter).length > 0) {
        pipeline.push({ $match: dateFilter });
      }
    }

    // Group back with all required fields
    pipeline.push({
      $group: {
        _id: "$dealer",
        dealerName: { $first: { $arrayElemAt: ['$dealerInfo.name', 0] } },
        availableAmount: { $first: "$availableAmount" },
        entries: {
          $push: {
            $cond: {
              if: { $ne: ["$entries", null] },
              then: {
                plantType: { $arrayElemAt: ['$plantInfo.name', 0] },
                subType: { $arrayElemAt: ['$subtypeInfo.subtypes.name', 0] },
                quantity: "$entries.quantity",
                bookedQuantity: "$entries.bookedQuantity",
                remainingQuantity: "$entries.remainingQuantity",
                bookingSlot: {
                  $arrayElemAt: ['$slotInfo.subtypeSlots.slots', 0]
                }
              },
              else: null
            }
          }
        },
        totalQuantity: {
          $sum: { $ifNull: ["$entries.quantity", 0] }
        },
        totalBooked: {
          $sum: { $ifNull: ["$entries.bookedQuantity", 0] }
        },
        totalRemaining: {
          $sum: { $ifNull: ["$entries.remainingQuantity", 0] }
        }
      }
    });

    // Clean up null entries
    pipeline.push({
      $project: {
        _id: 1,
        dealerName: 1,
        availableAmount: 1,
        entries: {
          $filter: {
            input: "$entries",
            as: "entry",
            cond: { $ne: ["$$entry", null] }
          }
        },
        totalQuantity: 1,
        totalBooked: 1,
        totalRemaining: 1
      }
    });

    const DealerWallet = mongoose.model('DealerWallet');
    const summary = await DealerWallet.aggregate(pipeline);

    return res.status(200).json({
      success: true,
      data: summary.filter(item => item.dealerName != null),
      count: summary.length
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
export { getDealerWalletDetails, getDealerWalletSummary, postReconcileDealerWallet };