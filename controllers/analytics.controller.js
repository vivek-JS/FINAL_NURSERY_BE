import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Pricing from "../models/pricing.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import mongoose from "mongoose";

// Dashboard Overview Analytics - Enhanced with order date
export const getDashboardAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate, timeRange = 'monthly' } = req.query;
  
  // Calculate date range using orderBookingDate instead of createdAt
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }
  // If no dates provided, show all-time data (no date filter)

  // Aggregate orders data with proper status mapping
  const orderStats = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } },
        // Updated status mapping: COMPLETED = sold, ACCEPTED = accepted, PENDING = booked
        soldOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        },
        acceptedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "ACCEPTED"] }, 1, 0] }
        },
        bookedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "PENDING"] }, 1, 0] }
        },
        cancelledOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "CANCELLED"] }, 1, 0] }
        }
      }
    }
  ]);

  // Get top performing plants with subtype data
  const topPlants = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          plantId: "$plantName",
          subtypeId: "$plantSubtype"
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgRate: { $avg: "$rate" }
      }
    },
    { $sort: { totalRevenue: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: "plantcms",
        localField: "_id.plantId",
        foreignField: "_id",
        as: "plantInfo"
      }
    },
    {
      $addFields: {
        subtypeInfo: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $arrayElemAt: ["$plantInfo.subtypes", 0] },
                cond: { $eq: ["$$this._id", "$_id.subtypeId"] }
              }
            },
            0
          ]
        }
      }
    }
  ]);

  // Get salesmen performance
  const salesmenPerformance = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: "$salesPerson",
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" }
      }
    },
    { $sort: { totalRevenue: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "salesmanInfo"
      }
    }
  ]);

  // Get monthly trends based on order booking date
  const monthlyTrends = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          year: { $year: "$orderBookingDate" },
          month: { $month: "$orderBookingDate" }
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" }
      }
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } }
  ]);

  // Calculate profit if pricing data exists
  let profitAnalysis = null;
  const pricingExists = await Pricing.countDocuments({});
  if (pricingExists > 0) {
    profitAnalysis = await calculateProfitAnalysis(dateFilter);
  }

  const stats = orderStats[0] || {};
  
  res.status(200).json({
    success: true,
    data: {
      overview: {
        totalOrders: stats.totalOrders || 0,
        totalRevenue: stats.totalRevenue || 0,
        totalPlants: stats.totalPlants || 0,
        avgOrderValue: stats.avgOrderValue || 0,
        soldOrders: stats.soldOrders || 0,
        acceptedOrders: stats.acceptedOrders || 0,
        bookedOrders: stats.bookedOrders || 0,
        cancelledOrders: stats.cancelledOrders || 0,
        completionRate: stats.totalOrders ? ((stats.soldOrders / stats.totalOrders) * 100).toFixed(1) : 0
      },
      topPlants: topPlants.map(plant => ({
        ...plant,
        name: plant.plantInfo?.[0]?.name || 'Unknown Plant',
        subtypeName: plant.subtypeInfo?.name || 'Unknown Subtype',
        displayName: `${plant.plantInfo?.[0]?.name || 'Unknown Plant'} - ${plant.subtypeInfo?.name || 'Unknown Subtype'}`
      })),
      salesmenPerformance: salesmenPerformance.map(salesman => ({
        ...salesman,
        name: salesman.salesmanInfo?.[0]?.name || 'Unknown Salesman',
        phone: salesman.salesmanInfo?.[0]?.phoneNumber
      })),
      monthlyTrends,
      profitAnalysis,
      hasPricingData: pricingExists > 0
    }
  });
});

// Profit & Loss Analysis
export const getProfitLossAnalysis = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  const profitAnalysis = await calculateProfitAnalysis(dateFilter);
  
  if (!profitAnalysis) {
    return next(new AppError("Pricing data not configured. Please set up pricing in settings.", 400));
  }

  res.status(200).json({
    success: true,
    data: profitAnalysis
  });
});

// Sales Performance Analysis
export const getSalesPerformanceAnalysis = catchAsync(async (req, res, next) => {
  const { startDate, endDate, groupBy = 'month' } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  // Salesmen performance with detailed metrics
  const salesmenPerformance = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: "$salesPerson",
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } },
        soldOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        },
        acceptedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "ACCEPTED"] }, 1, 0] }
        },
        bookedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "PENDING"] }, 1, 0] }
        },
        cancelledOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "CANCELLED"] }, 1, 0] }
        }
      }
    },
    {
      $addFields: {
        completionRate: {
          $multiply: [
            { $divide: ["$completedOrders", "$totalOrders"] },
            100
          ]
        },
        cancellationRate: {
          $multiply: [
            { $divide: ["$cancelledOrders", "$totalOrders"] },
            100
          ]
        }
      }
    },
    { $sort: { totalRevenue: -1 } },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "salesmanInfo"
      }
    }
  ]);

  // Sales trends over time
  const salesTrends = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          year: { $year: "$orderBookingDate" },
          month: { $month: "$orderBookingDate" },
          ...(groupBy === 'week' && { week: { $week: "$orderBookingDate" } }),
          ...(groupBy === 'day' && { day: { $dayOfMonth: "$orderBookingDate" } })
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" }
      }
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } }
  ]);

  res.status(200).json({
    success: true,
    data: {
      salesmenPerformance: salesmenPerformance.map(salesman => ({
        ...salesman,
        name: salesman.salesmanInfo?.[0]?.name || 'Unknown Salesman',
        phone: salesman.salesmanInfo?.[0]?.phoneNumber
      })),
      salesTrends,
      summary: {
        totalSalesmen: salesmenPerformance.length,
        avgOrdersPerSalesman: salesmenPerformance.reduce((sum, s) => sum + s.totalOrders, 0) / salesmenPerformance.length,
        avgRevenuePerSalesman: salesmenPerformance.reduce((sum, s) => sum + s.totalRevenue, 0) / salesmenPerformance.length
      }
    }
  });
});

// Plant Performance Analysis
export const getPlantPerformanceAnalysis = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  // Plant performance with profitability
  const plantPerformance = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          plantId: "$plantName",
          subtypeId: "$plantSubtype"
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgRate: { $avg: "$rate" },
        completedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        }
      }
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "_id.plantId",
        foreignField: "_id",
        as: "plantInfo"
      }
    },
    {
      $lookup: {
        from: "pricings",
        let: { plantId: "$_id.plantId", subtypeId: "$_id.subtypeId" },
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
        as: "pricingInfo"
      }
    },
    {
      $addFields: {
        plantName: { $arrayElemAt: ["$plantInfo.name", 0] },
        costPrice: { $arrayElemAt: ["$pricingInfo.costPrice", 0] },
        profitPerUnit: { $arrayElemAt: ["$pricingInfo.profitPerUnit", 0] },
        margin: { $arrayElemAt: ["$pricingInfo.margin", 0] },
        totalProfit: {
          $multiply: [
            "$totalPlants",
            { $ifNull: [{ $arrayElemAt: ["$pricingInfo.profitPerUnit", 0] }, 0] }
          ]
        }
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  // Plant category analysis
  const categoryAnalysis = await PlantCms.aggregate([
    {
      $lookup: {
        from: "orders",
        localField: "_id",
        foreignField: "plantName",
        as: "orders"
      }
    },
    {
      $addFields: {
        totalOrders: { $size: "$orders" },
        totalRevenue: {
          $sum: {
            $map: {
              input: "$orders",
              as: "order",
              in: { $multiply: ["$$order.numberOfPlants", "$$order.rate"] }
            }
          }
        }
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  res.status(200).json({
    success: true,
    data: {
      plantPerformance,
      categoryAnalysis,
      summary: {
        totalPlantVarieties: plantPerformance.length,
        avgOrdersPerPlant: plantPerformance.reduce((sum, p) => sum + p.totalOrders, 0) / plantPerformance.length,
        avgRevenuePerPlant: plantPerformance.reduce((sum, p) => sum + p.totalRevenue, 0) / plantPerformance.length,
        totalProfit: plantPerformance.reduce((sum, p) => sum + (p.totalProfit || 0), 0)
      }
    }
  });
});

// Customer Analytics
export const getCustomerAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  // Customer segmentation (farmers vs dealers)
  const customerSegmentation = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: "$dealerOrder",
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } }
      }
    },
    {
      $addFields: {
        customerType: {
          $cond: { if: "$_id", then: "Dealer", else: "Farmer" }
        }
      }
    }
  ]);

  // Top customers by revenue
  const topCustomers = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          customerId: { $cond: { if: "$dealerOrder", then: "$dealer", else: "$farmer" } },
          customerType: { $cond: { if: "$dealerOrder", then: "Dealer", else: "Farmer" } }
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } }
      }
    },
    { $sort: { totalRevenue: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: "users",
        localField: "_id.customerId",
        foreignField: "_id",
        as: "customerInfo"
      }
    },
    {
      $lookup: {
        from: "farmers",
        localField: "_id.customerId",
        foreignField: "_id",
        as: "farmerInfo"
      }
    }
  ]);

  // Customer retention analysis
  const customerRetention = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          customerId: { $cond: { if: "$dealerOrder", then: "$dealer", else: "$farmer" } },
          customerType: { $cond: { if: "$dealerOrder", then: "Dealer", else: "Farmer" } }
        },
        totalOrders: { $sum: 1 },
        firstOrder: { $min: "$orderBookingDate" },
        lastOrder: { $max: "$orderBookingDate" }
      }
    },
    {
      $addFields: {
        isReturningCustomer: { $gt: ["$totalOrders", 1] },
        daysBetweenOrders: {
          $cond: {
            if: { $gt: ["$totalOrders", 1] },
            then: {
              $divide: [
                { $subtract: ["$lastOrder", "$firstOrder"] },
                1000 * 60 * 60 * 24
              ]
            },
            else: 0
          }
        }
      }
    },
    {
      $group: {
        _id: null,
        totalCustomers: { $sum: 1 },
        returningCustomers: {
          $sum: { $cond: ["$isReturningCustomer", 1, 0] }
        },
        avgOrdersPerCustomer: { $avg: "$totalOrders" },
        avgDaysBetweenOrders: { $avg: "$daysBetweenOrders" }
      }
    }
  ]);

  res.status(200).json({
    success: true,
    data: {
      customerSegmentation,
      topCustomers: topCustomers.map(customer => ({
        ...customer,
        name: customer.customerInfo?.[0]?.name || customer.farmerInfo?.[0]?.name || 'Unknown Customer',
        phone: customer.customerInfo?.[0]?.phoneNumber || customer.farmerInfo?.[0]?.phoneNumber
      })),
      customerRetention: customerRetention[0] || {},
      summary: {
        totalCustomers: topCustomers.length,
        avgOrdersPerCustomer: topCustomers.reduce((sum, c) => sum + c.totalOrders, 0) / topCustomers.length,
        avgRevenuePerCustomer: topCustomers.reduce((sum, c) => sum + c.totalRevenue, 0) / topCustomers.length
      }
    }
  });
});

// Monthly Trends Analysis
export const getMonthlyTrends = catchAsync(async (req, res, next) => {
  const { year = new Date().getFullYear() } = req.query;
  
  const startOfYear = new Date(year, 0, 1);
  const endOfYear = new Date(year, 11, 31);
  
  const monthlyData = await Order.aggregate([
    {
      $match: {
        orderBookingDate: { $gte: startOfYear, $lte: endOfYear }
      }
    },
    {
      $group: {
        _id: { month: { $month: "$orderBookingDate" } },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        completedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        }
      }
    },
    { $sort: { "_id.month": 1 } }
  ]);

  // Fill missing months with zero values
  const fullYearData = Array.from({ length: 12 }, (_, i) => {
    const monthData = monthlyData.find(item => item._id.month === i + 1);
    return {
      month: i + 1,
      monthName: new Date(year, i, 1).toLocaleString('default', { month: 'long' }),
      totalOrders: monthData?.totalOrders || 0,
      totalRevenue: monthData?.totalRevenue || 0,
      totalPlants: monthData?.totalPlants || 0,
      completedOrders: monthData?.completedOrders || 0
    };
  });

  res.status(200).json({
    success: true,
    data: {
      year: parseInt(year),
      monthlyData: fullYearData,
      summary: {
        totalOrders: fullYearData.reduce((sum, month) => sum + month.totalOrders, 0),
        totalRevenue: fullYearData.reduce((sum, month) => sum + month.totalRevenue, 0),
        totalPlants: fullYearData.reduce((sum, month) => sum + month.totalPlants, 0),
        avgOrdersPerMonth: fullYearData.reduce((sum, month) => sum + month.totalOrders, 0) / 12,
        avgRevenuePerMonth: fullYearData.reduce((sum, month) => sum + month.totalRevenue, 0) / 12
      }
    }
  });
});

// District-wise Analytics
export const getDistrictAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate, stateName } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  // District-wise order analysis
  const districtOrders = await Order.aggregate([
    { $match: dateFilter },
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerInfo"
      }
    },
    {
      $addFields: {
        district: { $arrayElemAt: ["$farmerInfo.districtName", 0] },
        state: { $arrayElemAt: ["$farmerInfo.stateName", 0] }
      }
    },
    {
      $match: {
        district: { $exists: true, $ne: null },
        ...(stateName && { state: stateName })
      }
    },
    {
      $group: {
        _id: {
          district: "$district",
          state: "$state"
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } },
        completedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        },
        pendingOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "PENDING"] }, 1, 0] }
        },
        cancelledOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "CANCELLED"] }, 1, 0] }
        }
      }
    },
    {
      $addFields: {
        completionRate: {
          $multiply: [
            { $divide: ["$completedOrders", "$totalOrders"] },
            100
          ]
        }
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  // Village-wise breakdown for selected district
  const { district } = req.query;
  let villageData = [];
  
  if (district) {
    villageData = await Order.aggregate([
      { $match: dateFilter },
      {
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmerInfo"
        }
      },
      {
        $addFields: {
          village: { $arrayElemAt: ["$farmerInfo.village", 0] },
          taluka: { $arrayElemAt: ["$farmerInfo.talukaName", 0] },
          district: { $arrayElemAt: ["$farmerInfo.districtName", 0] }
        }
      },
      {
        $match: {
          district: district,
          village: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: {
            village: "$village",
            taluka: "$taluka"
          },
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
          totalPlants: { $sum: "$numberOfPlants" },
          uniqueCustomers: { $addToSet: "$farmer" }
        }
      },
      {
        $addFields: {
          uniqueCustomerCount: { $size: "$uniqueCustomers" }
        }
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 20 }
    ]);
  }

  res.status(200).json({
    success: true,
    data: {
      districtOrders,
      villageData,
      summary: {
        totalDistricts: districtOrders.length,
        totalRevenue: districtOrders.reduce((sum, d) => sum + d.totalRevenue, 0),
        totalOrders: districtOrders.reduce((sum, d) => sum + d.totalOrders, 0),
        avgRevenuePerDistrict: districtOrders.length > 0 ? 
          districtOrders.reduce((sum, d) => sum + d.totalRevenue, 0) / districtOrders.length : 0
      }
    }
  });
});

// Slot-wise Analytics
export const getSlotAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate, plantId, year } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  // Simplified slot performance analysis
  const slotPerformance = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: "$bookingSlot",
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } },
        completedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        },
        pendingOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "PENDING"] }, 1, 0] }
        },
        cancelledOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "CANCELLED"] }, 1, 0] }
        }
      }
    },
    {
      $addFields: {
        completionRate: {
          $multiply: [
            { $divide: ["$completedOrders", "$totalOrders"] },
            100
          ]
        }
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  // Get slot details for the performance data
  const slotDetails = await PlantSlot.aggregate([
    {
      $unwind: "$subtypeSlots"
    },
    {
      $unwind: "$subtypeSlots.slots"
    },
    {
      $project: {
        slotId: "$subtypeSlots.slots._id",
        startDay: "$subtypeSlots.slots.startDay",
        endDay: "$subtypeSlots.slots.endDay",
        month: "$subtypeSlots.slots.month",
        totalPlants: "$subtypeSlots.slots.totalPlants",
        totalBookedPlants: "$subtypeSlots.slots.totalBookedPlants",
        availablePlants: "$subtypeSlots.slots.availablePlants",
        bufferAmount: "$subtypeSlots.slots.bufferAmount"
      }
    }
  ]);

  // Merge slot performance with slot details
  const enhancedSlotPerformance = slotPerformance.map(performance => {
    const slotDetail = slotDetails.find(detail => 
      detail.slotId.toString() === performance._id.toString()
    );
    
    return {
      ...performance,
      slotId: performance._id,
      startDay: slotDetail?.startDay || 'Unknown',
      endDay: slotDetail?.endDay || 'Unknown',
      month: slotDetail?.month || 'Unknown',
      totalCapacity: slotDetail?.totalPlants || 0,
      bookedCapacity: slotDetail?.totalBookedPlants || 0,
      availableCapacity: slotDetail?.availablePlants || 0,
      bufferAmount: slotDetail?.bufferAmount || 0,
      utilizationRate: slotDetail?.totalPlants ? 
        ((slotDetail.totalBookedPlants / slotDetail.totalPlants) * 100) : 0
    };
  });

  // Monthly slot trends (simplified)
  const monthlySlotTrends = await Order.aggregate([
    { $match: dateFilter },
    {
      $lookup: {
        from: "plantslots",
        localField: "bookingSlot",
        foreignField: "subtypeSlots.slots._id",
        as: "slotInfo"
      }
    },
    {
      $addFields: {
        slotMonth: {
          $let: {
            vars: {
              slotDetails: {
                $arrayElemAt: [
                  {
                    $reduce: {
                      input: "$slotInfo.subtypeSlots",
                      initialValue: null,
                      in: {
                        $cond: {
                          if: { $in: ["$bookingSlot", "$$this.slots._id"] },
                          then: {
                            $arrayElemAt: [
                              {
                                $filter: {
                                  input: "$$this.slots",
                                  cond: { $eq: ["$$this._id", "$bookingSlot"] }
                                }
                              },
                              0
                            ]
                          },
                          else: "$$value"
                        }
                      }
                    }
                  },
                  0
                ]
              }
            },
            in: "$$slotDetails.month"
          }
        }
      }
    },
    {
      $group: {
        _id: "$slotMonth",
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } }
      }
    },
    { $sort: { "_id": 1 } }
  ]);

  // Slot capacity analysis
  const slotCapacity = await PlantSlot.aggregate([
    ...(plantId ? [{ $match: { plantId: new mongoose.Types.ObjectId(plantId) } }] : []),
    ...(year ? [{ $match: { year: parseInt(year) } }] : []),
    {
      $unwind: "$subtypeSlots"
    },
    {
      $unwind: "$subtypeSlots.slots"
    },
    {
      $group: {
        _id: {
          month: "$subtypeSlots.slots.month",
          slotId: "$subtypeSlots.slots._id"
        },
        totalCapacity: { $sum: "$subtypeSlots.slots.totalPlants" },
        bookedCapacity: { $sum: "$subtypeSlots.slots.totalBookedPlants" },
        availableCapacity: { $sum: "$subtypeSlots.slots.availablePlants" },
        bufferAmount: { $sum: "$subtypeSlots.slots.bufferAmount" }
      }
    },
    {
      $addFields: {
        utilizationRate: {
          $multiply: [
            { $divide: ["$bookedCapacity", "$totalCapacity"] },
            100
          ]
        },
        bufferRate: {
          $multiply: [
            { $divide: ["$bufferAmount", "$totalCapacity"] },
            100
          ]
        }
      }
    },
    {
      $group: {
        _id: "$_id.month",
        totalCapacity: { $sum: "$totalCapacity" },
        totalBooked: { $sum: "$bookedCapacity" },
        totalAvailable: { $sum: "$availableCapacity" },
        totalBuffer: { $sum: "$bufferAmount" },
        avgUtilization: { $avg: "$utilizationRate" },
        avgBuffer: { $avg: "$bufferRate" }
      }
    },
    { $sort: { "_id": 1 } }
  ]);

  res.status(200).json({
    success: true,
    data: {
      slotPerformance: enhancedSlotPerformance,
      monthlySlotTrends,
      slotCapacity,
      summary: {
        totalSlots: enhancedSlotPerformance.length,
        totalRevenue: enhancedSlotPerformance.reduce((sum, s) => sum + s.totalRevenue, 0),
        avgUtilization: slotCapacity.length > 0 ? 
          slotCapacity.reduce((sum, s) => sum + s.avgUtilization, 0) / slotCapacity.length : 0,
        avgBuffer: slotCapacity.length > 0 ? 
          slotCapacity.reduce((sum, s) => sum + s.avgBuffer, 0) / slotCapacity.length : 0
      }
    }
  });
});

// Enhanced Customer Analytics with repeated customers and most valued customers
export const getEnhancedCustomerAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate, customerType } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  // Customer segmentation with enhanced metrics
  const customerSegmentation = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          customerId: { $cond: { if: "$dealerOrder", then: "$dealer", else: "$farmer" } },
          customerType: { $cond: { if: "$dealerOrder", then: "Dealer", else: "Farmer" } }
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } },
        firstOrder: { $min: "$createdAt" },
        lastOrder: { $max: "$createdAt" },
        completedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        },
        cancelledOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "CANCELLED"] }, 1, 0] }
        }
      }
    },
    {
      $addFields: {
        isReturningCustomer: { $gt: ["$totalOrders", 1] },
        customerLifetime: {
          $divide: [
            { $subtract: ["$lastOrder", "$firstOrder"] },
            1000 * 60 * 60 * 24
          ]
        },
        completionRate: {
          $multiply: [
            { $divide: ["$completedOrders", "$totalOrders"] },
            100
          ]
        },
        cancellationRate: {
          $multiply: [
            { $divide: ["$cancelledOrders", "$totalOrders"] },
            100
          ]
        }
      }
    },
    {
      $match: {
        ...(customerType && { "_id.customerType": customerType })
      }
    },
    {
      $lookup: {
        from: "users",
        localField: "_id.customerId",
        foreignField: "_id",
        as: "customerInfo"
      }
    },
    {
      $lookup: {
        from: "farmers",
        localField: "_id.customerId",
        foreignField: "_id",
        as: "farmerInfo"
      }
    }
  ]);

  // Most valued customers (by revenue)
  const mostValuedCustomers = customerSegmentation
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 10)
    .map(customer => ({
      ...customer,
      name: customer.customerInfo?.[0]?.name || customer.farmerInfo?.[0]?.name || 'Unknown Customer',
      phone: customer.customerInfo?.[0]?.phoneNumber || customer.farmerInfo?.[0]?.mobileNumber,
      valueTier: customer.totalRevenue > 100000 ? 'Premium' : 
                 customer.totalRevenue > 50000 ? 'Gold' : 
                 customer.totalRevenue > 20000 ? 'Silver' : 'Bronze'
    }));

  // Repeated customers analysis
  const repeatedCustomers = customerSegmentation
    .filter(customer => customer.isReturningCustomer)
    .sort((a, b) => b.totalOrders - a.totalOrders)
    .slice(0, 10)
    .map(customer => ({
      ...customer,
      name: customer.customerInfo?.[0]?.name || customer.farmerInfo?.[0]?.name || 'Unknown Customer',
      phone: customer.customerInfo?.[0]?.phoneNumber || customer.farmerInfo?.[0]?.mobileNumber,
      loyaltyTier: customer.totalOrders > 10 ? 'VIP' : 
                   customer.totalOrders > 5 ? 'Regular' : 'Occasional'
    }));

  // Customer retention analysis
  const retentionAnalysis = customerSegmentation.reduce((acc, customer) => {
    if (customer.isReturningCustomer) {
      acc.returningCustomers++;
      acc.totalRevenueFromReturning += customer.totalRevenue;
    } else {
      acc.newCustomers++;
      acc.totalRevenueFromNew += customer.totalRevenue;
    }
    return acc;
  }, {
    returningCustomers: 0,
    newCustomers: 0,
    totalRevenueFromReturning: 0,
    totalRevenueFromNew: 0
  });

  // Customer value distribution
  const valueDistribution = customerSegmentation.reduce((acc, customer) => {
    if (customer.totalRevenue > 100000) acc.premium++;
    else if (customer.totalRevenue > 50000) acc.gold++;
    else if (customer.totalRevenue > 20000) acc.silver++;
    else acc.bronze++;
    return acc;
  }, { premium: 0, gold: 0, silver: 0, bronze: 0 });

  // Customer behavior analysis
  const behaviorAnalysis = customerSegmentation.reduce((acc, customer) => {
    if (customer.completionRate > 80) acc.highCompletion++;
    else if (customer.completionRate > 60) acc.mediumCompletion++;
    else acc.lowCompletion++;
    
    if (customer.cancellationRate > 20) acc.highCancellation++;
    else if (customer.cancellationRate > 10) acc.mediumCancellation++;
    else acc.lowCancellation++;
    
    return acc;
  }, {
    highCompletion: 0, mediumCompletion: 0, lowCompletion: 0,
    highCancellation: 0, mediumCancellation: 0, lowCancellation: 0
  });

  res.status(200).json({
    success: true,
    data: {
      customerSegmentation,
      mostValuedCustomers,
      repeatedCustomers,
      retentionAnalysis,
      valueDistribution,
      behaviorAnalysis,
      summary: {
        totalCustomers: customerSegmentation.length,
        returningCustomers: retentionAnalysis.returningCustomers,
        newCustomers: retentionAnalysis.newCustomers,
        retentionRate: customerSegmentation.length > 0 ? 
          (retentionAnalysis.returningCustomers / customerSegmentation.length * 100).toFixed(1) : 0,
        avgRevenuePerCustomer: customerSegmentation.length > 0 ?
          customerSegmentation.reduce((sum, c) => sum + c.totalRevenue, 0) / customerSegmentation.length : 0,
        avgOrdersPerCustomer: customerSegmentation.length > 0 ?
          customerSegmentation.reduce((sum, c) => sum + c.totalOrders, 0) / customerSegmentation.length : 0
      }
    }
  });
});

// Payment Analytics
export const getPaymentAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate, customerType } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  // Payment status analysis
  const paymentStatusAnalysis = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: "$orderPaymentStatus",
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } }
      }
    },
    {
      $addFields: {
        status: "$_id",
        pendingAmount: {
          $cond: {
            if: { $eq: ["$_id", "PENDING"] },
            then: "$totalRevenue",
            else: 0
          }
        },
        completedAmount: {
          $cond: {
            if: { $eq: ["$_id", "COMPLETED"] },
            then: "$totalRevenue",
            else: 0
          }
        }
      }
    }
  ]);

  // Total payments made (from payment collection)
  const totalPaymentsMade = await Order.aggregate([
    { $match: dateFilter },
    {
      $unwind: "$payment"
    },
    {
      $match: {
        "payment.paymentStatus": "COLLECTED"
      }
    },
    {
      $group: {
        _id: null,
        totalPaymentsMade: { $sum: "$payment.paidAmount" },
        totalPaymentCount: { $sum: 1 },
        avgPaymentAmount: { $avg: "$payment.paidAmount" }
      }
    }
  ]);

  // Top payment pending customers (farmers and dealers)
  const topPaymentPendingCustomers = await Order.aggregate([
    { $match: dateFilter },
    {
      $match: {
        orderPaymentStatus: "PENDING"
      }
    },
    {
      $group: {
        _id: {
          customerId: { $cond: { if: "$dealerOrder", then: "$dealer", else: "$farmer" } },
          customerType: { $cond: { if: "$dealerOrder", then: "Dealer", else: "Farmer" } }
        },
        totalOrders: { $sum: 1 },
        totalPendingAmount: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } },
        firstOrder: { $min: "$createdAt" },
        lastOrder: { $max: "$createdAt" }
      }
    },
    {
      $addFields: {
        daysSinceLastOrder: {
          $divide: [
            { $subtract: [new Date(), "$lastOrder"] },
            1000 * 60 * 60 * 24
          ]
        }
      }
    },
    { $sort: { totalPendingAmount: -1 } },
    { $limit: 20 },
    {
      $lookup: {
        from: "users",
        localField: "_id.customerId",
        foreignField: "_id",
        as: "customerInfo"
      }
    },
    {
      $lookup: {
        from: "farmers",
        localField: "_id.customerId",
        foreignField: "_id",
        as: "farmerInfo"
      }
    }
  ]);

  // Payment trends over time
  const paymentTrends = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" }
        },
        totalOrders: { $sum: 1 },
        pendingOrders: {
          $sum: { $cond: [{ $eq: ["$orderPaymentStatus", "PENDING"] }, 1, 0] }
        },
        completedOrders: {
          $sum: { $cond: [{ $eq: ["$orderPaymentStatus", "COMPLETED"] }, 1, 0] }
        },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        pendingAmount: {
          $sum: {
            $cond: [
              { $eq: ["$orderPaymentStatus", "PENDING"] },
              { $multiply: ["$numberOfPlants", "$rate"] },
              0
            ]
          }
        },
        completedAmount: {
          $sum: {
            $cond: [
              { $eq: ["$orderPaymentStatus", "COMPLETED"] },
              { $multiply: ["$numberOfPlants", "$rate"] },
              0
            ]
          }
        }
      }
    },
    {
      $addFields: {
        pendingRate: {
          $multiply: [
            { $divide: ["$pendingOrders", "$totalOrders"] },
            100
          ]
        }
      }
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } }
  ]);

  // Payment method analysis
  const paymentMethodAnalysis = await Order.aggregate([
    { $match: dateFilter },
    {
      $unwind: "$payment"
    },
    {
      $match: {
        "payment.paymentStatus": "COLLECTED"
      }
    },
    {
      $group: {
        _id: "$payment.modeOfPayment",
        totalAmount: { $sum: "$payment.paidAmount" },
        totalPayments: { $sum: 1 },
        avgAmount: { $avg: "$payment.paidAmount" }
      }
    },
    { $sort: { totalAmount: -1 } }
  ]);

  // Calculate summary metrics
  const pendingSummary = paymentStatusAnalysis.find(item => item.status === "PENDING") || {};
  const completedSummary = paymentStatusAnalysis.find(item => item.status === "COMPLETED") || {};
  const paymentsMade = totalPaymentsMade[0] || {};

  res.status(200).json({
    success: true,
    data: {
      paymentStatusAnalysis,
      totalPaymentsMade: paymentsMade,
      topPaymentPendingCustomers: topPaymentPendingCustomers.map(customer => ({
        ...customer,
        name: customer.customerInfo?.[0]?.name || customer.farmerInfo?.[0]?.name || 'Unknown Customer',
        phone: customer.customerInfo?.[0]?.phoneNumber || customer.farmerInfo?.[0]?.mobileNumber,
        urgencyLevel: customer.daysSinceLastOrder > 30 ? 'High' : 
                     customer.daysSinceLastOrder > 15 ? 'Medium' : 'Low'
      })),
      paymentTrends,
      paymentMethodAnalysis,
      summary: {
        totalPendingAmount: pendingSummary.totalRevenue || 0,
        totalCompletedAmount: completedSummary.totalRevenue || 0,
        totalPaymentsMade: paymentsMade.totalPaymentsMade || 0,
        pendingOrdersCount: pendingSummary.totalOrders || 0,
        completedOrdersCount: completedSummary.totalOrders || 0,
        pendingRate: pendingSummary.totalOrders && completedSummary.totalOrders ? 
          (pendingSummary.totalOrders / (pendingSummary.totalOrders + completedSummary.totalOrders) * 100).toFixed(1) : 0,
        avgPendingAmount: pendingSummary.totalOrders ? 
          (pendingSummary.totalRevenue / pendingSummary.totalOrders) : 0,
        avgPaymentAmount: paymentsMade.avgPaymentAmount || 0
      }
    }
  });
});

// New: Plant Subtype Booking Trends
export const getPlantSubtypeTrends = catchAsync(async (req, res, next) => {
  const { startDate, endDate, groupBy = 'month', plantId } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }
  
  if (plantId) {
    dateFilter.plantName = new mongoose.Types.ObjectId(plantId);
  }

  // Plant subtype booking trends over time
  const subtypeTrends = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          plantId: "$plantName",
          subtypeId: "$plantSubtype",
          ...(groupBy === 'month' && {
            year: { $year: "$orderBookingDate" },
            month: { $month: "$orderBookingDate" }
          }),
          ...(groupBy === 'week' && {
            year: { $year: "$orderBookingDate" },
            week: { $week: "$orderBookingDate" }
          }),
          ...(groupBy === 'day' && {
            year: { $year: "$orderBookingDate" },
            month: { $month: "$orderBookingDate" },
            day: { $dayOfMonth: "$orderBookingDate" }
          })
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgRate: { $avg: "$rate" }
      }
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "_id.plantId",
        foreignField: "_id",
        as: "plantInfo"
      }
    },
    {
      $addFields: {
        subtypeInfo: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $arrayElemAt: ["$plantInfo.subtypes", 0] },
                cond: { $eq: ["$$this._id", "$_id.subtypeId"] }
              }
            },
            0
          ]
        }
      }
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } }
  ]);

  // Top performing subtypes overall
  const topSubtypes = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          plantId: "$plantName",
          subtypeId: "$plantSubtype"
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgRate: { $avg: "$rate" }
      }
    },
    { $sort: { totalRevenue: -1 } },
    { $limit: 15 },
    {
      $lookup: {
        from: "plantcms",
        localField: "_id.plantId",
        foreignField: "_id",
        as: "plantInfo"
      }
    },
    {
      $addFields: {
        subtypeInfo: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $arrayElemAt: ["$plantInfo.subtypes", 0] },
                cond: { $eq: ["$$this._id", "$_id.subtypeId"] }
              }
            },
            0
          ]
        }
      }
    }
  ]);

  res.status(200).json({
    success: true,
    data: {
      subtypeTrends,
      topSubtypes: topSubtypes.map(subtype => ({
        ...subtype,
        plantName: subtype.plantInfo?.[0]?.name || 'Unknown Plant',
        subtypeName: subtype.subtypeInfo?.name || 'Unknown Subtype',
        displayName: `${subtype.plantInfo?.[0]?.name || 'Unknown Plant'} - ${subtype.subtypeInfo?.name || 'Unknown Subtype'}`
      })),
      summary: {
        totalSubtypes: topSubtypes.length,
        totalRevenue: topSubtypes.reduce((sum, s) => sum + s.totalRevenue, 0),
        totalOrders: topSubtypes.reduce((sum, s) => sum + s.totalOrders, 0),
        avgRevenuePerSubtype: topSubtypes.length > 0 ? 
          topSubtypes.reduce((sum, s) => sum + s.totalRevenue, 0) / topSubtypes.length : 0
      }
    }
  });
});

// New: Order Status Distribution (Pie Chart Data)
export const getOrderStatusDistribution = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  const statusDistribution = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: "$orderStatus",
        count: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" }
      }
    },
    {
      $addFields: {
        status: "$_id",
        percentage: {
          $multiply: [
            { $divide: ["$count", { $sum: "$count" }] },
            100
          ]
        }
      }
    },
    { $sort: { count: -1 } }
  ]);

  // Payment status distribution
  const paymentStatusDistribution = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: "$orderPaymentStatus",
        count: { $sum: 1 },
        totalAmount: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } }
      }
    },
    {
      $addFields: {
        status: "$_id",
        percentage: {
          $multiply: [
            { $divide: ["$count", { $sum: "$count" }] },
            100
          ]
        }
      }
    },
    { $sort: { count: -1 } }
  ]);

  res.status(200).json({
    success: true,
    data: {
      orderStatusDistribution,
      paymentStatusDistribution,
      summary: {
        totalOrders: statusDistribution.reduce((sum, s) => sum + s.count, 0),
        totalRevenue: statusDistribution.reduce((sum, s) => sum + s.totalRevenue, 0),
        completedOrders: statusDistribution.find(s => s.status === 'COMPLETED')?.count || 0,
        pendingOrders: statusDistribution.find(s => s.status === 'PENDING')?.count || 0
      }
    }
  });
});

// New: Customer Type Distribution (Pie Chart Data)
export const getCustomerTypeDistribution = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  const customerTypeDistribution = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: "$dealerOrder",
        count: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } }
      }
    },
    {
      $addFields: {
        customerType: {
          $cond: { if: "$_id", then: "Dealer", else: "Farmer" }
        },
        percentage: {
          $multiply: [
            { $divide: ["$count", { $sum: "$count" }] },
            100
          ]
        }
      }
    },
    { $sort: { count: -1 } }
  ]);

  res.status(200).json({
    success: true,
    data: {
      customerTypeDistribution,
      summary: {
        totalCustomers: customerTypeDistribution.reduce((sum, c) => sum + c.count, 0),
        totalRevenue: customerTypeDistribution.reduce((sum, c) => sum + c.totalRevenue, 0),
        farmers: customerTypeDistribution.find(c => c.customerType === 'Farmer')?.count || 0,
        dealers: customerTypeDistribution.find(c => c.customerType === 'Dealer')?.count || 0
      }
    }
  });
});

// New: Revenue Trends by Time Period
export const getRevenueTrends = catchAsync(async (req, res, next) => {
  const { startDate, endDate, groupBy = 'month' } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  const revenueTrends = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          ...(groupBy === 'month' && {
            year: { $year: "$orderBookingDate" },
            month: { $month: "$orderBookingDate" }
          }),
          ...(groupBy === 'week' && {
            year: { $year: "$orderBookingDate" },
            week: { $week: "$orderBookingDate" }
          }),
          ...(groupBy === 'day' && {
            year: { $year: "$orderBookingDate" },
            month: { $month: "$orderBookingDate" },
            day: { $dayOfMonth: "$orderBookingDate" }
          })
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgOrderValue: { $avg: { $multiply: ["$numberOfPlants", "$rate"] } },
        completedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        },
        pendingOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "PENDING"] }, 1, 0] }
        }
      }
    },
    {
      $addFields: {
        completionRate: {
          $multiply: [
            { $divide: ["$completedOrders", "$totalOrders"] },
            100
          ]
        }
      }
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } }
  ]);

  res.status(200).json({
    success: true,
    data: {
      revenueTrends,
      summary: {
        totalRevenue: revenueTrends.reduce((sum, t) => sum + t.totalRevenue, 0),
        totalOrders: revenueTrends.reduce((sum, t) => sum + t.totalOrders, 0),
        avgRevenuePerPeriod: revenueTrends.length > 0 ? 
          revenueTrends.reduce((sum, t) => sum + t.totalRevenue, 0) / revenueTrends.length : 0,
        avgCompletionRate: revenueTrends.length > 0 ? 
          revenueTrends.reduce((sum, t) => sum + t.completionRate, 0) / revenueTrends.length : 0
      }
    }
  });
});

// New: Plant Performance Comparison (Bar Chart Data)
export const getPlantPerformanceComparison = catchAsync(async (req, res, next) => {
  const { startDate, endDate, limit = 10 } = req.query;
  
  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.orderBookingDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else if (startDate) {
    dateFilter.orderBookingDate = { $gte: new Date(startDate) };
  } else if (endDate) {
    dateFilter.orderBookingDate = { $lte: new Date(endDate) };
  }

  const plantPerformance = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          plantId: "$plantName",
          subtypeId: "$plantSubtype"
        },
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
        totalPlants: { $sum: "$numberOfPlants" },
        avgRate: { $avg: "$rate" },
        completedOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
        },
        cancelledOrders: {
          $sum: { $cond: [{ $eq: ["$orderStatus", "CANCELLED"] }, 1, 0] }
        }
      }
    },
    {
      $addFields: {
        completionRate: {
          $multiply: [
            { $divide: ["$completedOrders", "$totalOrders"] },
            100
          ]
        },
        cancellationRate: {
          $multiply: [
            { $divide: ["$cancelledOrders", "$totalOrders"] },
            100
          ]
        }
      }
    },
    { $sort: { totalRevenue: -1 } },
    { $limit: parseInt(limit) },
    {
      $lookup: {
        from: "plantcms",
        localField: "_id.plantId",
        foreignField: "_id",
        as: "plantInfo"
      }
    },
    {
      $addFields: {
        subtypeInfo: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $arrayElemAt: ["$plantInfo.subtypes", 0] },
                cond: { $eq: ["$$this._id", "$_id.subtypeId"] }
              }
            },
            0
          ]
        }
      }
    }
  ]);

  res.status(200).json({
    success: true,
    data: {
      plantPerformance: plantPerformance.map(plant => ({
        ...plant,
        plantName: plant.plantInfo?.[0]?.name || 'Unknown Plant',
        subtypeName: plant.subtypeInfo?.name || 'Unknown Subtype',
        displayName: `${plant.plantInfo?.[0]?.name || 'Unknown Plant'} - ${plant.subtypeInfo?.name || 'Unknown Subtype'}`
      })),
      summary: {
        totalPlants: plantPerformance.length,
        totalRevenue: plantPerformance.reduce((sum, p) => sum + p.totalRevenue, 0),
        avgCompletionRate: plantPerformance.length > 0 ? 
          plantPerformance.reduce((sum, p) => sum + p.completionRate, 0) / plantPerformance.length : 0,
        avgCancellationRate: plantPerformance.length > 0 ? 
          plantPerformance.reduce((sum, p) => sum + p.cancellationRate, 0) / plantPerformance.length : 0
      }
    }
  });
});

// Helper function to calculate profit analysis
const calculateProfitAnalysis = async (dateFilter) => {
  const profitData = await Order.aggregate([
    { $match: dateFilter },
    {
      $lookup: {
        from: "pricings",
        let: { plantId: "$plantName", subtypeId: "$plantSubtype" },
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
        as: "pricingInfo"
      }
    },
    {
      $addFields: {
        costPrice: { $arrayElemAt: ["$pricingInfo.costPrice", 0] },
        profitPerUnit: { $arrayElemAt: ["$pricingInfo.profitPerUnit", 0] },
        totalCost: {
          $multiply: [
            "$numberOfPlants",
            { $ifNull: [{ $arrayElemAt: ["$pricingInfo.costPrice", 0] }, 0] }
          ]
        },
        totalProfit: {
          $multiply: [
            "$numberOfPlants",
            { $ifNull: [{ $arrayElemAt: ["$pricingInfo.profitPerUnit", 0] }, 0] }
          ]
        },
        totalRevenue: { $multiply: ["$numberOfPlants", "$rate"] }
      }
    },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: "$totalRevenue" },
        totalCost: { $sum: "$totalCost" },
        totalProfit: { $sum: "$totalProfit" },
        totalOrders: { $sum: 1 },
        avgProfitPerOrder: { $avg: "$totalProfit" },
        profitableOrders: {
          $sum: { $cond: [{ $gt: ["$totalProfit", 0] }, 1, 0] }
        }
      }
    }
  ]);

  if (profitData.length === 0) return null;

  const data = profitData[0];
  return {
    totalRevenue: data.totalRevenue || 0,
    totalCost: data.totalCost || 0,
    totalProfit: data.totalProfit || 0,
    profitMargin: data.totalRevenue ? ((data.totalProfit / data.totalRevenue) * 100).toFixed(2) : 0,
    avgProfitPerOrder: data.avgProfitPerOrder || 0,
    profitableOrders: data.profitableOrders || 0,
    profitableOrdersPercentage: data.totalOrders ? ((data.profitableOrders / data.totalOrders) * 100).toFixed(2) : 0
  };
}; 