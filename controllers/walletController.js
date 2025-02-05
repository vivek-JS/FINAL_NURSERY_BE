import DealerWallet from "../models/dealerWallet.js";
import Order from "../models/order.model.js";
import catchAsync from "../utility/catchAsync.js";
import mongoose from "mongoose";

const getDealerWalletDetails = catchAsync(async (req, res) => {
  const { dealerId } = req.params;

  // First get dealer's orders and calculate total order amount
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
          $sum: { $multiply: ["$numberOfPlants", "$rate"] }
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
              in: { $add: ["$$value", "$$this.paidAmount"] }
            }
          }
        }
      }
    }
  ]);

  // Get wallet plant details
  const walletDetails = await DealerWallet.aggregate([
    // Match the dealer
    { 
      $match: { 
        dealer: new mongoose.Types.ObjectId(dealerId) 
      } 
    },

    // Facet to separate wallet info and plant details
    {
      $facet: {
        walletInfo: [
          {
            $project: {
              availableAmount: 1,
              _id: 0
            }
          }
        ],
        plantDetails: [
          // Unwind entries array
          { $unwind: "$entries" },

          // Add lookups for plant names
          {
            $lookup: {
              from: "plantcms",
              localField: "entries.plantType",
              foreignField: "_id",
              as: "plantDetails"
            }
          },
          {
            $lookup: {
              from: "plantcms",
              let: { subTypeId: "$entries.subType" },
              pipeline: [
                { $unwind: "$subtypes" },
                {
                  $match: {
                    $expr: { $eq: ["$subtypes._id", "$$subTypeId"] }
                  }
                }
              ],
              as: "subtypeDetails"
            }
          },

          // Group by plantType and subType
          {
            $group: {
              _id: {
                plantType: "$entries.plantType",
                subType: "$entries.subType"
              },
              plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
              subtypeName: { $first: { $arrayElemAt: ["$subtypeDetails.subtypes.name", 0] } },
              totalQuantity: { $sum: "$entries.quantity" },
              totalBookedQuantity: { $sum: "$entries.bookedQuantity" },
              totalRemainingQuantity: { $sum: "$entries.remainingQuantity" },
              slotDetails: {
                $push: {
                  slotId: "$entries.bookingSlot",
                  quantity: "$entries.quantity",
                  bookedQuantity: "$entries.bookedQuantity",
                  remainingQuantity: "$entries.remainingQuantity"
                }
              }
            }
          },

          // Lookup slot details
          {
            $lookup: {
              from: "plantslots",
              let: { slots: "$slotDetails" },
              pipeline: [
                { $unwind: "$subtypeSlots" },
                { $unwind: "$subtypeSlots.slots" },
                {
                  $match: {
                    $expr: {
                      $in: ["$subtypeSlots.slots._id", "$$slots.slotId"]
                    }
                  }
                },
                {
                  $project: {
                    _id: "$subtypeSlots.slots._id",
                    startDay: "$subtypeSlots.slots.startDay",
                    endDay: "$subtypeSlots.slots.endDay",
                    month: "$subtypeSlots.slots.month"
                  }
                }
              ],
              as: "slotDates"
            }
          },

          // Final project for plant details
          {
            $project: {
              _id: 0,
              plantType: "$_id.plantType",
              plantName: 1,
              subType: "$_id.subType",
              subtypeName: 1,
              totalQuantity: 1,
              totalBookedQuantity: 1,
              totalRemainingQuantity: 1,
              slotDetails: {
                $map: {
                  input: "$slotDetails",
                  as: "slot",
                  in: {
                    slotId: "$$slot.slotId",
                    quantity: "$$slot.quantity",
                    bookedQuantity: "$$slot.bookedQuantity",
                    remainingQuantity: "$$slot.remainingQuantity",
                    dates: {
                      $arrayElemAt: [{
                        $filter: {
                          input: "$slotDates",
                          as: "date",
                          cond: { $eq: ["$$date._id", "$$slot.slotId"] }
                        }
                      }, 0]
                    }
                  }
                }
              }
            }
          }
        ]
      }
    }
  ]);

  // Combine all details
  const financialDetails = orderDetails[0] || { 
    totalOrderAmount: 0, 
    totalPaidAmount: 0 
  };

  const walletInfo = walletDetails[0].walletInfo[0] || { 
    availableAmount: 0 
  };

  // Format response
  return res.status(200).json({
    status: "success",
    data: {
      financial: {
        availableAmount: walletInfo.availableAmount,
        totalOrderAmount: financialDetails.totalOrderAmount,
        totalPaidAmount: financialDetails.totalPaidAmount,
        remainingAmount: financialDetails.totalOrderAmount - financialDetails.totalPaidAmount
      },
      plantDetails: walletDetails[0].plantDetails
    }
  });
});


import moment from 'moment';

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
export { getDealerWalletDetails,getDealerWalletSummary };