import Order from "../models/order.model.js";
import Dispatch from "../models/dispatch.model.js";
import User from "../models/user.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Pricing from "../models/pricing.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import mongoose from "mongoose";
import moment from "moment";

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
      orderStatusDistribution: statusDistribution,
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



// Daily stats (acceptance, sell, payment) for a date range.
export const getDailyStats = catchAsync(async (req, res, next) => {
  const { startDate, endDate, timeRange } = req.query;

  const now = new Date();

  // Resolve range as inclusive [start..end], using end-of-day for endDate.
  const resolvedEnd = endDate ? new Date(endDate) : now;
  resolvedEnd.setHours(23, 59, 59, 999);

  const resolvedStart = (() => {
    if (startDate) {
      const d = new Date(startDate);
      d.setHours(0, 0, 0, 0);
      return d;
    }

    const tr = timeRange || "7_days";
    const daysBack = (() => {
      switch (tr) {
        case "weekly":
        case "7_days":
          return 6;
        case "14_days":
          return 13;
        case "30_days":
        case "monthly":
          return 29;
        case "quarterly":
          return 89;
        case "yearly":
        case "365_days":
          return 364;
        default:
          return 6;
      }
    })();

    const d = new Date(now);
    d.setDate(d.getDate() - daysBack);
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  const startIso = resolvedStart.toISOString();
  const endIso = resolvedEnd.toISOString();

  // Generate inclusive daily keys to keep charts continuous.
  const dateKeys = (() => {
    const keys = [];
    const cur = new Date(resolvedStart);
    cur.setHours(0, 0, 0, 0);
    while (cur <= resolvedEnd) {
      const yyyy = cur.getFullYear();
      const mm = String(cur.getMonth() + 1).padStart(2, "0");
      const dd = String(cur.getDate()).padStart(2, "0");
      keys.push(`${yyyy}-${mm}-${dd}`);
      cur.setDate(cur.getDate() + 1);
    }
    return keys;
  })();

  const acceptanceSeries = await Order.aggregate([
    {
      $match: {
        orderStatus: "ACCEPTED",
        orderBookingDate: { $gte: resolvedStart, $lte: resolvedEnd },
      },
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$orderBookingDate" } },
        },
        orders: { $sum: 1 },
        plants: { $sum: "$numberOfPlants" },
        revenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id.date",
        orders: 1,
        plants: 1,
        revenue: 1,
      },
    },
    { $sort: { date: 1 } },
  ]);

  const sellSeries = await Order.aggregate([
    {
      $match: {
        orderStatus: "COMPLETED",
        orderBookingDate: { $gte: resolvedStart, $lte: resolvedEnd },
      },
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$orderBookingDate" } },
        },
        orders: { $sum: 1 },
        plants: { $sum: "$numberOfPlants" },
        revenue: { $sum: { $multiply: ["$numberOfPlants", "$rate"] } },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id.date",
        orders: 1,
        plants: 1,
        revenue: 1,
      },
    },
    { $sort: { date: 1 } },
  ]);

  const paymentSeriesRaw = await Order.aggregate([
    { $unwind: { path: "$payment", preserveNullAndEmptyArrays: false } },
    { $match: { "payment.paymentDate": { $gte: resolvedStart, $lte: resolvedEnd } } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$payment.paymentDate" } },
          paymentStatus: "$payment.paymentStatus",
        },
        count: { $sum: 1 },
        amount: { $sum: "$payment.paidAmount" },
      },
    },
    {
      $group: {
        _id: "$_id.date",
        collectedAmount: {
          $sum: { $cond: [{ $eq: ["$_id.paymentStatus", "COLLECTED"] }, "$amount", 0] },
        },
        collectedCount: {
          $sum: { $cond: [{ $eq: ["$_id.paymentStatus", "COLLECTED"] }, "$count", 0] },
        },
        pendingAmount: {
          $sum: {
            $cond: [
              { $in: ["$_id.paymentStatus", ["PENDING", "BANK_VERIFIED"]] },
              "$amount",
              0,
            ],
          },
        },
        pendingCount: {
          $sum: {
            $cond: [
              { $in: ["$_id.paymentStatus", ["PENDING", "BANK_VERIFIED"]] },
              "$count",
              0,
            ],
          },
        },
        rejectedAmount: {
          $sum: { $cond: [{ $eq: ["$_id.paymentStatus", "REJECTED"] }, "$amount", 0] },
        },
        rejectedCount: {
          $sum: { $cond: [{ $eq: ["$_id.paymentStatus", "REJECTED"] }, "$count", 0] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id",
        collectedAmount: 1,
        collectedCount: 1,
        pendingAmount: 1,
        pendingCount: 1,
        rejectedAmount: 1,
        rejectedCount: 1,
      },
    },
    { $sort: { date: 1 } },
  ]);

  const acceptanceMap = acceptanceSeries.reduce((m, v) => {
    m[v.date] = v;
    return m;
  }, {});
  const sellMap = sellSeries.reduce((m, v) => {
    m[v.date] = v;
    return m;
  }, {});
  const paymentMap = paymentSeriesRaw.reduce((m, v) => {
    m[v.date] = v;
    return m;
  }, {});

  const acceptanceDaily = dateKeys.map((date) => ({
    date,
    orders: acceptanceMap[date]?.orders || 0,
    plants: acceptanceMap[date]?.plants || 0,
    revenue: acceptanceMap[date]?.revenue || 0,
  }));

  const sellDaily = dateKeys.map((date) => ({
    date,
    orders: sellMap[date]?.orders || 0,
    plants: sellMap[date]?.plants || 0,
    revenue: sellMap[date]?.revenue || 0,
  }));

  const paymentDaily = dateKeys.map((date) => ({
    date,
    collectedAmount: paymentMap[date]?.collectedAmount || 0,
    collectedCount: paymentMap[date]?.collectedCount || 0,
    pendingAmount: paymentMap[date]?.pendingAmount || 0,
    pendingCount: paymentMap[date]?.pendingCount || 0,
    rejectedAmount: paymentMap[date]?.rejectedAmount || 0,
    rejectedCount: paymentMap[date]?.rejectedCount || 0,
  }));

  const summary = {
    totalAcceptedOrders: acceptanceDaily.reduce((s, d) => s + d.orders, 0),
    totalSoldOrders: sellDaily.reduce((s, d) => s + d.orders, 0),
    totalAcceptedRevenue: acceptanceDaily.reduce((s, d) => s + d.revenue, 0),
    totalSellRevenue: sellDaily.reduce((s, d) => s + d.revenue, 0),
    totalCollectedAmount: paymentDaily.reduce((s, d) => s + d.collectedAmount, 0),
    totalPendingAmount: paymentDaily.reduce((s, d) => s + d.pendingAmount, 0),
    totalRejectedAmount: paymentDaily.reduce((s, d) => s + d.rejectedAmount, 0),
  };

  res.status(200).json({
    success: true,
    data: {
      dateRange: {
        startDate: startIso,
        endDate: endIso,
      },
      acceptanceDaily,
      sellDaily,
      paymentDaily,
      summary,
    },
  });
});

/** orderBookingDate filter for short report (inclusive end). */
const shortReportOrderDateMatch = (startDate, endDate) => {
  if (!startDate || !endDate) return null;
  return {
    orderBookingDate: {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    },
  };
};

/**
 * Billable plant count per order — same as order model pre-save (totalOrderedPlants).
 * Uses numberOfPlants + additionalPlants (not remainingPlants / dispatch leftovers).
 */
const billablePlantQtyExpr = {
  $add: [
    { $ifNull: ["$numberOfPlants", 0] },
    { $ifNull: ["$additionalPlants", 0] },
  ],
};

const orderValueExpr = {
  $multiply: [billablePlantQtyExpr, { $ifNull: ["$rate", 0] }],
};

/** Sum paid amounts on lines counted as received: COLLECTED + BANK_VERIFIED. */
const totalCollectedOnOrderExpr = {
  $reduce: {
    input: { $ifNull: ["$payment", []] },
    initialValue: 0,
    in: {
      $add: [
        "$$value",
        {
          $cond: [
            {
              $in: [
                "$$this.paymentStatus",
                ["COLLECTED", "BANK_VERIFIED"],
              ],
            },
            { $ifNull: ["$$this.paidAmount", 0] },
            0,
          ],
        },
      ],
    },
  },
};

/** Compact CEO short report: orders + plant totals + payment rollups for a booking-date range. */
export const getShortReport = catchAsync(async (req, res) => {
  const { startDate, endDate, limit: limitQuery, orderLimit: orderLimitQuery } =
    req.query;
  const match = shortReportOrderDateMatch(startDate, endDate);
  if (!match) {
    return res.status(400).json({
      success: false,
      message: "startDate and endDate are required (ISO strings).",
    });
  }

  // `limit` is on the global query whitelist; `orderLimit` is optional alias.
  const limitRaw = parseInt(limitQuery ?? orderLimitQuery, 10);
  const ordersCap = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 500)
    : 300;

  const baseStages = [
    { $match: match },
    {
      $addFields: {
        orderValue: orderValueExpr,
        plantQty: billablePlantQtyExpr,
        totalPaidCollected: totalCollectedOnOrderExpr,
      },
    },
  ];

  const [summaryAgg] = await Order.aggregate([
    ...baseStages,
    {
      $group: {
        _id: null,
        orderCount: { $sum: 1 },
        totalPlantUnits: { $sum: "$plantQty" },
        totalOrderValue: { $sum: "$orderValue" },
        totalCollected: { $sum: "$totalPaidCollected" },
        ordersPaymentCompleted: {
          $sum: { $cond: [{ $eq: ["$orderPaymentStatus", "COMPLETED"] }, 1, 0] },
        },
        ordersPaymentPending: {
          $sum: { $cond: [{ $eq: ["$orderPaymentStatus", "PENDING"] }, 1, 0] },
        },
      },
    },
  ]);

  const summary = summaryAgg || {
    orderCount: 0,
    totalPlantUnits: 0,
    totalOrderValue: 0,
    totalCollected: 0,
    ordersPaymentCompleted: 0,
    ordersPaymentPending: 0,
  };
  summary.totalPendingAmount = Math.max(
    0,
    (summary.totalOrderValue || 0) - (summary.totalCollected || 0)
  );

  const byPlant = await Order.aggregate([
    ...baseStages,
    {
      $group: {
        _id: {
          plantId: "$plantName",
          subtypeId: "$plantSubtype",
        },
        orderCount: { $sum: 1 },
        plantUnits: { $sum: "$plantQty" },
        orderValue: { $sum: "$orderValue" },
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "_id.plantId",
        foreignField: "_id",
        as: "plantDoc",
      },
    },
    {
      $addFields: {
        subtypeDoc: {
          $arrayElemAt: [
            {
              $filter: {
                input: {
                  $ifNull: [{ $arrayElemAt: ["$plantDoc.subtypes", 0] }, []],
                },
                cond: { $eq: ["$$this._id", "$_id.subtypeId"] },
              },
            },
            0,
          ],
        },
      },
    },
    { $sort: { orderValue: -1 } },
    {
      $project: {
        plantId: "$_id.plantId",
        subtypeId: "$_id.subtypeId",
        plantName: { $arrayElemAt: ["$plantDoc.name", 0] },
        subtypeName: "$subtypeDoc.name",
        displayName: {
          $concat: [
            { $ifNull: [{ $arrayElemAt: ["$plantDoc.name", 0] }, "Unknown plant"] },
            " · ",
            { $ifNull: ["$subtypeDoc.name", "—"] },
          ],
        },
        orderCount: 1,
        plantUnits: 1,
        orderValue: 1,
      },
    },
  ]);

  const orders = await Order.aggregate([
    ...baseStages,
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerDoc",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "dealer",
        foreignField: "_id",
        as: "dealerDoc",
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantDoc",
      },
    },
    {
      $addFields: {
        subtypeDoc: {
          $arrayElemAt: [
            {
              $filter: {
                input: {
                  $ifNull: [{ $arrayElemAt: ["$plantDoc.subtypes", 0] }, []],
                },
                cond: { $eq: ["$$this._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    },
    { $sort: { orderBookingDate: -1 } },
    { $limit: ordersCap },
    {
      $project: {
        _id: 1,
        orderId: 1,
        publicOrderCode: 1,
        orderBookingDate: 1,
        orderStatus: 1,
        orderPaymentStatus: 1,
        dealerOrder: 1,
        plantNameId: "$plantName",
        plantSubtype: 1,
        plantNameLabel: { $arrayElemAt: ["$plantDoc.name", 0] },
        subtypeName: "$subtypeDoc.name",
        plantSubtypeLabel: {
          $concat: [
            { $ifNull: [{ $arrayElemAt: ["$plantDoc.name", 0] }, ""] },
            " · ",
            { $ifNull: ["$subtypeDoc.name", "—"] },
          ],
        },
        numberOfPlants: 1,
        additionalPlants: 1,
        totalPlants: "$plantQty",
        rate: 1,
        orderValue: 1,
        totalPaidCollected: 1,
        customerName: {
          $cond: {
            if: "$dealerOrder",
            then: { $arrayElemAt: ["$dealerDoc.name", 0] },
            else: { $arrayElemAt: ["$farmerDoc.name", 0] },
          },
        },
      },
    },
  ]);

  const listTruncated = (summary.orderCount || 0) > orders.length;

  res.status(200).json({
    success: true,
    data: {
      dateRange: { startDate, endDate },
      summary,
      ordersListMeta: {
        totalOrdersInRange: summary.orderCount || 0,
        ordersReturned: orders.length,
        limit: ordersCap,
        truncated: listTruncated,
      },
      calculationNotes: {
        orderValue:
          "Per order: (numberOfPlants + additionalPlants) × rate — same as ERP order total.",
        plantUnits:
          "Sum of (numberOfPlants + additionalPlants) across orders in range (not remaining/dispatch qty).",
        summaryScope:
          "Summary cards sum every order with orderBookingDate in range; the orders table is capped by limit.",
      },
      byPlant: byPlant.map((p) => ({
        ...p,
        plantName: p.plantName || "Unknown plant",
        subtypeName: p.subtypeName || "—",
        displayName:
          p.displayName ||
          `${p.plantName || "Unknown plant"} · ${p.subtypeName || "—"}`,
      })),
      orders,
      ordersTruncatedTo: ordersCap,
    },
  });
});

/** Orders for one plant in the same booking-date window. */
export const getShortReportByPlant = catchAsync(async (req, res) => {
  const { plantId } = req.params;
  const { startDate, endDate, subtypeId } = req.query;
  if (!mongoose.Types.ObjectId.isValid(plantId)) {
    return res.status(400).json({ success: false, message: "Invalid plant id." });
  }
  const match = shortReportOrderDateMatch(startDate, endDate);
  if (!match) {
    return res.status(400).json({
      success: false,
      message: "startDate and endDate are required.",
    });
  }
  match.plantName = new mongoose.Types.ObjectId(plantId);
  if (subtypeId && mongoose.Types.ObjectId.isValid(subtypeId)) {
    match.plantSubtype = new mongoose.Types.ObjectId(subtypeId);
  }

  const plant = await PlantCms.findById(plantId).select("name subtypes").lean();
  let subtypeLabel = null;
  if (subtypeId && plant?.subtypes?.length) {
    const st = plant.subtypes.find((s) => String(s._id) === String(subtypeId));
    subtypeLabel = st?.name || null;
  }

  const orders = await Order.aggregate([
    { $match: match },
    {
      $addFields: {
        orderValue: orderValueExpr,
        plantQty: billablePlantQtyExpr,
        totalPaidCollected: totalCollectedOnOrderExpr,
      },
    },
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerDoc",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "dealer",
        foreignField: "_id",
        as: "dealerDoc",
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantDoc",
      },
    },
    {
      $addFields: {
        subtypeDoc: {
          $arrayElemAt: [
            {
              $filter: {
                input: {
                  $ifNull: [{ $arrayElemAt: ["$plantDoc.subtypes", 0] }, []],
                },
                cond: { $eq: ["$$this._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    },
    { $sort: { orderBookingDate: -1 } },
    {
      $project: {
        _id: 1,
        orderId: 1,
        publicOrderCode: 1,
        orderBookingDate: 1,
        orderStatus: 1,
        orderPaymentStatus: 1,
        dealerOrder: 1,
        numberOfPlants: 1,
        additionalPlants: 1,
        plantSubtype: 1,
        subtypeName: "$subtypeDoc.name",
        totalPlants: "$plantQty",
        rate: 1,
        orderValue: 1,
        totalPaidCollected: 1,
        customerName: {
          $cond: {
            if: "$dealerOrder",
            then: { $arrayElemAt: ["$dealerDoc.name", 0] },
            else: { $arrayElemAt: ["$farmerDoc.name", 0] },
          },
        },
      },
    },
  ]);

  res.status(200).json({
    success: true,
    data: {
      dateRange: { startDate, endDate },
      plant: {
        _id: plantId,
        name: plant?.name || "Unknown plant",
      },
      subtype: subtypeId
        ? { _id: subtypeId, name: subtypeLabel || "—" }
        : null,
      orders,
    },
  });
});

/** Single order with populates for detail drawer. */
export const getShortReportOrderDetail = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return next(new AppError("Invalid order id.", 400));
  }
  const order = await Order.findById(orderId)
    .populate("farmer", "name mobileNumber village taluka district")
    .populate("dealer", "name phoneNumber")
    .populate("salesPerson", "name phoneNumber")
    .populate("plantName", "name subtypes")
    .lean();

  if (!order) {
    return next(new AppError("Order not found.", 404));
  }

  let subtypeName = null;
  const subtypes = order.plantName?.subtypes;
  if (Array.isArray(subtypes) && order.plantSubtype) {
    const sid = String(order.plantSubtype);
    const hit = subtypes.find((s) => String(s._id) === sid);
    subtypeName = hit?.name || null;
  }

  const plantQty =
    (order.numberOfPlants || 0) + (order.additionalPlants || 0);
  const orderValue = plantQty * (Number(order.rate) || 0);
  const totalPaidCollected = (order.payment || []).reduce((sum, p) => {
    if (p.paymentStatus === "COLLECTED" || p.paymentStatus === "BANK_VERIFIED") {
      return sum + (p.paidAmount || 0);
    }
    return sum;
  }, 0);

  res.status(200).json({
    success: true,
    data: {
      order,
      computed: {
        plantQty,
        orderValue,
        totalPaidCollected,
        pendingAmount: Math.max(0, orderValue - totalPaidCollected),
        subtypeName,
      },
    },
  });
});

/** Payment lines for orders booked in range (all statuses; summary splits collected vs rest). */
export const getShortReportPayments = catchAsync(async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = shortReportOrderDateMatch(startDate, endDate);
  if (!match) {
    return res.status(400).json({
      success: false,
      message: "startDate and endDate are required.",
    });
  }

  const rows = await Order.aggregate([
    { $match: match },
    { $unwind: "$payment" },
    {
      $lookup: {
        from: "farmers",
        localField: "farmer",
        foreignField: "_id",
        as: "farmerDoc",
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "dealer",
        foreignField: "_id",
        as: "dealerDoc",
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantDoc",
      },
    },
    {
      $addFields: {
        subtypeDoc: {
          $arrayElemAt: [
            {
              $filter: {
                input: {
                  $ifNull: [{ $arrayElemAt: ["$plantDoc.subtypes", 0] }, []],
                },
                cond: { $eq: ["$$this._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    },
    { $sort: { "payment.paymentDate": -1 } },
    {
      $project: {
        order_id: "$_id",
        orderId: 1,
        publicOrderCode: 1,
        orderBookingDate: 1,
        plantSubtypeLabel: {
          $concat: [
            { $ifNull: [{ $arrayElemAt: ["$plantDoc.name", 0] }, ""] },
            " · ",
            { $ifNull: ["$subtypeDoc.name", "—"] },
          ],
        },
        customerName: {
          $cond: {
            if: "$dealerOrder",
            then: { $arrayElemAt: ["$dealerDoc.name", 0] },
            else: { $arrayElemAt: ["$farmerDoc.name", 0] },
          },
        },
        paidAmount: "$payment.paidAmount",
        paymentDate: "$payment.paymentDate",
        modeOfPayment: "$payment.modeOfPayment",
        paymentStatus: "$payment.paymentStatus",
        transactionId: "$payment.transactionId",
        utrNumber: "$payment.utrNumber",
        isWalletPayment: "$payment.isWalletPayment",
        bankVerificationStatus: "$payment.bankVerificationStatus",
        payment_id: "$payment._id",
      },
    },
  ]);

  const acceptedStatuses = new Set(["COLLECTED", "BANK_VERIFIED"]);
  let totalAccepted = 0;
  let acceptedLineCount = 0;
  const byStatus = {};

  for (const r of rows) {
    const st = r.paymentStatus || "UNKNOWN";
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (acceptedStatuses.has(st)) {
      totalAccepted += r.paidAmount || 0;
      acceptedLineCount += 1;
    }
  }

  res.status(200).json({
    success: true,
    data: {
      dateRange: { startDate, endDate },
      summary: {
        paymentLineCount: rows.length,
        /** Collected / bank-verified (money in). */
        acceptedLineCount,
        totalAcceptedAmount: totalAccepted,
        byStatus,
        note:
          "Accepted = COLLECTED + BANK_VERIFIED. All rows include PENDING and REJECTED too.",
      },
      payments: rows,
    },
  });
});

const VARIETY_REPORT_DATE_FIELDS = new Set([
  "orderBookingDate",
  "deliveryDate",
  "createdAt",
]);

const VARIETY_REPORT_EXCLUDED_STATUSES = [
  "CANCELLED",
  "REJECTED",
  "TEMPORARY_CANCELLED",
];

function istDayBoundsFromYmd(dateKey) {
  const start = new Date(`${dateKey}T00:00:00+05:30`);
  const end = new Date(`${dateKey}T23:59:59.999+05:30`);
  return { start, end };
}

function getIstTodayAndYesterdayYmd() {
  const todayKey = moment().utcOffset(330).format("YYYY-MM-DD");
  const yesterdayKey = moment()
    .utcOffset(330)
    .subtract(1, "day")
    .format("YYYY-MM-DD");
  return { todayKey, yesterdayKey };
}

async function aggregateVarietyForDay({ dateKey, dateField, excludeStatuses }) {
  const { start, end } = istDayBoundsFromYmd(dateKey);

  const match = {
    [dateField]: { $gte: start, $lte: end },
  };
  if (excludeStatuses.length > 0) {
    match.orderStatus = { $nin: excludeStatuses };
  }

  const byVariety = await Order.aggregate([
    { $match: match },
    {
      $addFields: {
        linePlantTotal: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantDetails",
      },
    },
    {
      $lookup: {
        from: "plantcms",
        let: { plantId: "$plantName", subtypeId: "$plantSubtype" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$plantId"] } } },
          { $unwind: "$subtypes" },
          { $match: { $expr: { $eq: ["$subtypes._id", "$$subtypeId"] } } },
          { $project: { subtypeName: "$subtypes.name" } },
        ],
        as: "subtypeDetails",
      },
    },
    {
      $group: {
        _id: {
          plantId: "$plantName",
          subtypeId: "$plantSubtype",
        },
        plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
        subtypeName: { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } },
        orderCount: { $sum: 1 },
        plantCount: { $sum: "$linePlantTotal" },
      },
    },
    {
      $project: {
        _id: 0,
        plantId: "$_id.plantId",
        subtypeId: "$_id.subtypeId",
        plantName: { $ifNull: ["$plantName", "Unknown"] },
        subtypeName: { $ifNull: ["$subtypeName", "Unknown"] },
        varietyLabel: {
          $concat: [
            { $ifNull: ["$plantName", "?"] },
            " — ",
            { $ifNull: ["$subtypeName", "?"] },
          ],
        },
        orderCount: 1,
        plantCount: 1,
      },
    },
    { $sort: { plantCount: -1, varietyLabel: 1 } },
  ]);

  const totalsAgg = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalPlants: {
          $sum: {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        },
      },
    },
  ]);

  return {
    date: dateKey,
    rangeUtc: { start: start.toISOString(), end: end.toISOString() },
    totalOrders: totalsAgg[0]?.totalOrders ?? 0,
    totalPlants: totalsAgg[0]?.totalPlants ?? 0,
    byVariety,
  };
}

/** Today vs yesterday: order counts and plant totals by plant + subtype (IST calendar days). */
export const getTodayYesterdayVarietyReport = catchAsync(
  async (req, res, next) => {
    const { dateField = "orderBookingDate", includeCancelled } = req.query;

    if (!VARIETY_REPORT_DATE_FIELDS.has(dateField)) {
      return next(
        new AppError(
          `Invalid dateField. Use one of: ${[...VARIETY_REPORT_DATE_FIELDS].join(", ")}`,
          400
        )
      );
    }

    const excludeStatuses =
      includeCancelled === "true" || includeCancelled === "1"
        ? []
        : VARIETY_REPORT_EXCLUDED_STATUSES;

    const { todayKey, yesterdayKey } = getIstTodayAndYesterdayYmd();

    const [today, yesterday] = await Promise.all([
      aggregateVarietyForDay({
        dateKey: todayKey,
        dateField,
        excludeStatuses,
      }),
      aggregateVarietyForDay({
        dateKey: yesterdayKey,
        dateField,
        excludeStatuses,
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        timezone: "Asia/Kolkata",
        dateField,
        note:
          "totalPlants = numberOfPlants + additionalPlants per order line. " +
          "Default dateField is orderBookingDate (booking day in IST). " +
          "Use dateField=deliveryDate for delivery-day grouping. " +
          "Cancelled/rejected/temporary-cancelled orders are excluded unless includeCancelled=true.",
        today,
        yesterday,
      },
    });
  }
);

function normalizeDispatchBucket(doc, { includeRemaining = false } = {}) {
  if (!doc) {
    return {
      orders: 0,
      plantsOnOrder: 0,
      ...(includeRemaining ? { plantsRemaining: 0 } : {}),
    };
  }
  const base = {
    orders: doc.orders ?? 0,
    plantsOnOrder: doc.plantsOnOrder ?? doc.plants ?? 0,
  };
  if (includeRemaining) {
    base.plantsRemaining = doc.plantsRemaining ?? 0;
  }
  return base;
}

/** Orders whose scheduled deliveryDate falls on the IST day — dispatch pipeline counts + variety mix. */
async function aggregateDeliveryDayPulse(dateKey, excludeStatuses) {
  const { start, end } = istDayBoundsFromYmd(dateKey);
  const match = {
    deliveryDate: { $gte: start, $lte: end },
  };
  if (excludeStatuses.length > 0) {
    match.orderStatus = { $nin: excludeStatuses };
  }

  const [row] = await Order.aggregate([
    { $match: match },
    {
      $addFields: {
        linePlantTotal: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
      },
    },
    {
      $facet: {
        overall: [
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              plantsOnOrder: { $sum: "$linePlantTotal" },
            },
          },
        ],
        readyForDispatch: [
          { $match: { orderStatus: "READY_FOR_DISPATCH" } },
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              plantsRemaining: { $sum: { $ifNull: ["$remainingPlants", 0] } },
              plantsOnOrder: { $sum: "$linePlantTotal" },
            },
          },
        ],
        inDispatchProcess: [
          { $match: { orderStatus: "DISPATCH_PROCESS" } },
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              plantsRemaining: { $sum: { $ifNull: ["$remainingPlants", 0] } },
              plantsOnOrder: { $sum: "$linePlantTotal" },
            },
          },
        ],
        dispatched: [
          { $match: { orderStatus: "DISPATCHED" } },
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              plantsOnOrder: { $sum: "$linePlantTotal" },
            },
          },
        ],
        farmReady: [
          { $match: { orderStatus: "FARM_READY" } },
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              plantsOnOrder: { $sum: "$linePlantTotal" },
            },
          },
        ],
        partiallyCompleted: [
          { $match: { orderStatus: "PARTIALLY_COMPLETED" } },
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              plantsRemaining: { $sum: { $ifNull: ["$remainingPlants", 0] } },
              plantsOnOrder: { $sum: "$linePlantTotal" },
            },
          },
        ],
      },
    },
    {
      $project: {
        overall: { $arrayElemAt: ["$overall", 0] },
        readyForDispatch: { $arrayElemAt: ["$readyForDispatch", 0] },
        inDispatchProcess: { $arrayElemAt: ["$inDispatchProcess", 0] },
        dispatched: { $arrayElemAt: ["$dispatched", 0] },
        farmReady: { $arrayElemAt: ["$farmReady", 0] },
        partiallyCompleted: { $arrayElemAt: ["$partiallyCompleted", 0] },
      },
    },
  ]);

  const o = row || {};
  return {
    date: dateKey,
    rangeUtc: { start: start.toISOString(), end: end.toISOString() },
    allScheduledDeliveries: normalizeDispatchBucket(o.overall),
    readyForDispatch: normalizeDispatchBucket(o.readyForDispatch, {
      includeRemaining: true,
    }),
    inDispatchProcess: normalizeDispatchBucket(o.inDispatchProcess, {
      includeRemaining: true,
    }),
    dispatched: normalizeDispatchBucket(o.dispatched),
    farmReady: normalizeDispatchBucket(o.farmReady),
    partiallyCompleted: normalizeDispatchBucket(o.partiallyCompleted, {
      includeRemaining: true,
    }),
  };
}

async function buildDispatchDailyPulsePayload() {
  const excludeStatuses = VARIETY_REPORT_EXCLUDED_STATUSES;
  const { todayKey, yesterdayKey } = getIstTodayAndYesterdayYmd();

  const [todayPulse, yesterdayPulse, todayVariety, yesterdayVariety] =
    await Promise.all([
      aggregateDeliveryDayPulse(todayKey, excludeStatuses),
      aggregateDeliveryDayPulse(yesterdayKey, excludeStatuses),
      aggregateVarietyForDay({
        dateKey: todayKey,
        dateField: "deliveryDate",
        excludeStatuses,
      }),
      aggregateVarietyForDay({
        dateKey: yesterdayKey,
        dateField: "deliveryDate",
        excludeStatuses,
      }),
    ]);

  return {
    timezone: "Asia/Kolkata",
    note:
      "All figures use scheduled deliveryDate in IST (orders without a delivery date are omitted). " +
      "Ready / In process / Partial show plants remaining to ship when tracked. " +
      "Variety rows sum ordered plant units (base + add-on) per plant · subtype.",
    today: {
      ...todayPulse,
      variety: {
        totalOrders: todayVariety.totalOrders,
        totalPlants: todayVariety.totalPlants,
        byVariety: todayVariety.byVariety,
      },
    },
    yesterday: {
      ...yesterdayPulse,
      variety: {
        totalOrders: yesterdayVariety.totalOrders,
        totalPlants: yesterdayVariety.totalPlants,
        byVariety: yesterdayVariety.byVariety,
      },
    },
  };
}

/** IST today vs yesterday: delivery-day dispatch pipeline + plant variety mix (deliveryDate). */
export const getDispatchDailyPulse = catchAsync(async (req, res) => {
  const data = await buildDispatchDailyPulsePayload();
  res.status(200).json({
    success: true,
    data,
  });
});

/**
 * Live Command Intelligence — consolidated IST snapshot for dashboards:
 * dispatch pulse, bookings today, status mix, dispatch runs, pipeline plants, payment exposure, upcoming deliveries.
 */
export const getLciSnapshot = catchAsync(async (req, res) => {
  const excluded = VARIETY_REPORT_EXCLUDED_STATUSES;
  const todayKey = moment().utcOffset(330).format("YYYY-MM-DD");
  const { start: todayStart, end: todayEnd } = istDayBoundsFromYmd(todayKey);
  const windowEndYmd = moment(todayKey, "YYYY-MM-DD")
    .utcOffset(330)
    .add(3, "days")
    .format("YYYY-MM-DD");
  const { end: windowEnd } = istDayBoundsFromYmd(windowEndYmd);

  const pipelineStatusMatch = {
    orderStatus: {
      $in: [
        "READY_FOR_DISPATCH",
        "DISPATCH_PROCESS",
        "FARM_READY",
        "PARTIALLY_COMPLETED",
      ],
    },
  };

  const openPipelineStatuses = [
    "PENDING",
    "ACCEPTED",
    "PROCESSING",
    "FARM_READY",
    "READY_FOR_DISPATCH",
    "DISPATCH_PROCESS",
    "PARTIALLY_COMPLETED",
  ];

  const [
    dispatchDaily,
    orderStatusMix,
    bookedToday,
    dispatchRunsCreatedToday,
    deliveriesInNext3Days,
    pipelineRemaining,
    paymentExposure,
    dealerPipelineOrders,
    farmerPipelineOrders,
    activeOrdersTotal,
  ] = await Promise.all([
    buildDispatchDailyPulsePayload(),
    Order.aggregate([
      { $match: { orderStatus: { $nin: excluded } } },
      {
        $group: {
          _id: "$orderStatus",
          orders: { $sum: 1 },
        },
      },
      { $sort: { orders: -1 } },
    ]),
    Order.countDocuments({
      orderBookingDate: { $gte: todayStart, $lte: todayEnd },
      orderStatus: { $nin: excluded },
    }),
    Dispatch.countDocuments({
      createdAt: { $gte: todayStart, $lte: todayEnd },
      isDeleted: { $ne: true },
    }),
    Order.countDocuments({
      deliveryDate: { $gte: todayStart, $lte: windowEnd },
      orderStatus: { $nin: excluded },
    }),
    Order.aggregate([
      { $match: pipelineStatusMatch },
      {
        $group: {
          _id: null,
          remainingPlants: { $sum: { $ifNull: ["$remainingPlants", 0] } },
          orders: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          orderPaymentStatus: "PENDING",
          orderStatus: { $nin: excluded },
        },
      },
      {
        $addFields: {
          lineQty: {
            $add: [
              { $ifNull: ["$numberOfPlants", 0] },
              { $ifNull: ["$additionalPlants", 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          /** Upper-bound order value (rate × qty); not net of partial payments. */
          grossOpenValue: {
            $sum: { $multiply: ["$rate", "$lineQty"] },
          },
        },
      },
    ]),
    Order.countDocuments({
      dealerOrder: true,
      orderStatus: { $in: openPipelineStatuses },
    }),
    Order.countDocuments({
      $or: [{ dealerOrder: false }, { dealerOrder: { $exists: false } }],
      orderStatus: { $in: openPipelineStatuses },
    }),
    Order.countDocuments({ orderStatus: { $nin: excluded } }),
  ]);

  const pr = pipelineRemaining[0] || {};
  const pe = paymentExposure[0] || {};

  res.status(200).json({
    success: true,
    data: {
      title: "Live command intelligence",
      timezone: "Asia/Kolkata",
      generatedAt: new Date().toISOString(),
      istCalendarDate: todayKey,
      summary: {
        activeOrdersTotal: activeOrdersTotal ?? 0,
        bookedTodayIST: bookedToday,
        dispatchManifestsLoggedToday: dispatchRunsCreatedToday,
        scheduledDeliveriesNext3Days: deliveriesInNext3Days,
        pipelineOrders: pr.orders ?? 0,
        pipelineRemainingPlants: pr.remainingPlants ?? 0,
        paymentPendingOrders: pe.orders ?? 0,
        paymentPendingGrossValueInr: pe.grossOpenValue ?? 0,
        dealerOrdersInPipeline: dealerPipelineOrders,
        farmerOrdersInPipeline: farmerPipelineOrders,
      },
      orderStatusMix: orderStatusMix.map((r) => ({
        orderStatus: r._id,
        orders: r.orders,
      })),
      dispatchDaily,
      hints: {
        paymentPendingGrossValueInr:
          "Sum of rate × (base + add-on) plants for orders still marked payment PENDING — upper bound, not net of partial collections.",
        scheduledDeliveriesNext3Days:
          "Count of orders with deliveryDate from start of today IST through end of the third day ahead (inclusive).",
        pipelineRemainingPlants:
          "Sum of remainingPlants on orders in READY_FOR_DISPATCH, DISPATCH_PROCESS, FARM_READY, or PARTIALLY_COMPLETED.",
      },
    },
  });
});

/** Statuses that moved from the dispatch queue into DISPATCHED (excludes direct jumps from ACCEPTED etc.). */
const TO_DISPATCH_PREVIOUS_STATUSES = [
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
];

/**
 * Full dispatch report: (1) order status transition counts from statusChanges in the date window,
 * (2) plant-wise physical units from dispatchHistory.quantity by dispatch date.
 *
 * Query (either):
 * - `date=YYYY-MM-DD` — one **Asia/Kolkata calendar day** (best for daily extract).
 * - `startDate` + `endDate` — ISO strings (same idea as short-report).
 * Optional: `format=csv` — download plant-wise + summary as CSV.
 */
export const getDispatchPipelineReport = catchAsync(async (req, res, next) => {
  const { startDate, endDate, date: dateParam } = req.query;

  let start;
  let end;
  /** @type {{ mode: string, istDate?: string, startDate?: string, endDate?: string }} */
  let rangeMeta = { mode: "custom" };

  if (
    dateParam &&
    typeof dateParam === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(dateParam.trim())
  ) {
    const istDate = dateParam.trim();
    const bounds = istDayBoundsFromYmd(istDate);
    start = bounds.start;
    end = bounds.end;
    rangeMeta = { mode: "single_ist_day", istDate };
  } else if (startDate && endDate) {
    start = new Date(startDate);
    end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return next(new AppError("Invalid startDate or endDate.", 400));
    }
    rangeMeta = { mode: "custom_range", startDate, endDate };
  } else {
    return next(
      new AppError(
        "Provide either date=YYYY-MM-DD (one IST day) or both startDate and endDate (ISO).",
        400
      )
    );
  }

  const scTimeMatch = {
    "statusChanges.createdAt": { $gte: start, $lte: end },
  };

  const [facetRow] = await Order.aggregate([
    { $match: { "statusChanges.0": { $exists: true } } },
    { $unwind: "$statusChanges" },
    { $match: scTimeMatch },
    {
      $addFields: {
        linePlantTotal: {
          $add: [
            { $ifNull: ["$numberOfPlants", 0] },
            { $ifNull: ["$additionalPlants", 0] },
          ],
        },
      },
    },
    {
      $facet: {
        acceptedToReady: [
          {
            $match: {
              "statusChanges.previousStatus": "ACCEPTED",
              "statusChanges.newStatus": "READY_FOR_DISPATCH",
            },
          },
          {
            $group: {
              _id: null,
              transitionCount: { $sum: 1 },
              orderIds: { $addToSet: "$_id" },
              plantUnits: { $sum: "$linePlantTotal" },
            },
          },
          {
            $project: {
              _id: 0,
              transitionCount: 1,
              distinctOrders: { $size: "$orderIds" },
              plantUnits: 1,
            },
          },
        ],
        toDispatched: [
          {
            $match: {
              "statusChanges.newStatus": "DISPATCHED",
              "statusChanges.previousStatus": {
                $in: TO_DISPATCH_PREVIOUS_STATUSES,
              },
            },
          },
          {
            $group: {
              _id: null,
              transitionCount: { $sum: 1 },
              orderIds: { $addToSet: "$_id" },
              plantUnits: { $sum: "$linePlantTotal" },
            },
          },
          {
            $project: {
              _id: 0,
              transitionCount: 1,
              distinctOrders: { $size: "$orderIds" },
              plantUnits: 1,
            },
          },
        ],
        byPreviousStatus: [
          {
            $match: {
              "statusChanges.newStatus": "DISPATCHED",
              "statusChanges.previousStatus": {
                $in: TO_DISPATCH_PREVIOUS_STATUSES,
              },
            },
          },
          {
            $group: {
              _id: "$statusChanges.previousStatus",
              transitionCount: { $sum: 1 },
              orderIds: { $addToSet: "$_id" },
              plantUnits: { $sum: "$linePlantTotal" },
            },
          },
          {
            $project: {
              fromStatus: "$_id",
              transitionCount: 1,
              distinctOrders: { $size: "$orderIds" },
              plantUnits: 1,
            },
          },
          { $sort: { fromStatus: 1 } },
        ],
      },
    },
  ]);

  const f = facetRow || {};
  const acceptedToReady = f.acceptedToReady?.[0] || {
    transitionCount: 0,
    distinctOrders: 0,
    plantUnits: 0,
  };
  const toDispatched = f.toDispatched?.[0] || {
    transitionCount: 0,
    distinctOrders: 0,
    plantUnits: 0,
  };
  const byPreviousStatus = f.byPreviousStatus || [];

  const plantWiseFromHistory = await Order.aggregate([
    { $match: { "dispatchHistory.0": { $exists: true } } },
    { $unwind: "$dispatchHistory" },
    {
      $match: {
        "dispatchHistory.date": { $gte: start, $lte: end },
      },
    },
    {
      $lookup: {
        from: "plantcms",
        localField: "plantName",
        foreignField: "_id",
        as: "plantDetails",
      },
    },
    {
      $lookup: {
        from: "plantcms",
        let: { plantId: "$plantName", subtypeId: "$plantSubtype" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$plantId"] } } },
          { $unwind: "$subtypes" },
          { $match: { $expr: { $eq: ["$subtypes._id", "$$subtypeId"] } } },
          { $project: { subtypeName: "$subtypes.name" } },
        ],
        as: "subtypeDetails",
      },
    },
    {
      $group: {
        _id: {
          plantId: "$plantName",
          subtypeId: "$plantSubtype",
        },
        plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
        subtypeName: {
          $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] },
        },
        plantsDispatched: { $sum: "$dispatchHistory.quantity" },
        dispatchLegs: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        plantId: "$_id.plantId",
        subtypeId: "$_id.subtypeId",
        plantName: { $ifNull: ["$plantName", "Unknown"] },
        subtypeName: { $ifNull: ["$subtypeName", "Unknown"] },
        varietyLabel: {
          $concat: [
            { $ifNull: ["$plantName", "?"] },
            " — ",
            { $ifNull: ["$subtypeName", "?"] },
          ],
        },
        plantsDispatched: 1,
        dispatchLegs: 1,
      },
    },
    { $sort: { plantsDispatched: -1, varietyLabel: 1 } },
  ]);

  const historyTotals = await Order.aggregate([
    { $match: { "dispatchHistory.0": { $exists: true } } },
    { $unwind: "$dispatchHistory" },
    {
      $match: {
        "dispatchHistory.date": { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: null,
        totalPlants: { $sum: "$dispatchHistory.quantity" },
        dispatchLegs: { $sum: 1 },
      },
    },
  ]);
  const ht = historyTotals[0] || {};

  const extractSummary = {
    purpose: "Daily / period export — key figures",
    timezone: "Asia/Kolkata",
    physicalPlantsDispatched: ht.totalPlants ?? 0,
    dispatchLegCount: ht.dispatchLegs ?? 0,
    statusChangeTransitions: {
      acceptedToReadyForDispatch: acceptedToReady.transitionCount ?? 0,
      queueToDispatched: toDispatched.transitionCount ?? 0,
    },
    varietyLineCount: plantWiseFromHistory.length,
  };

  const wantsCsv =
    String(req.query.format || "").toLowerCase() === "csv" ||
    String(req.query.export || "").toLowerCase() === "csv";

  if (wantsCsv) {
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const label =
      rangeMeta.mode === "single_ist_day"
        ? rangeMeta.istDate
        : `${rangeMeta.startDate || ""}_${rangeMeta.endDate || ""}`;
    const rows = [
      "section,key,value",
      `summary,physical_plants_dispatched,${ht.totalPlants ?? 0}`,
      `summary,dispatch_legs,${ht.dispatchLegs ?? 0}`,
      `summary,transitions_accepted_to_ready,${acceptedToReady.transitionCount ?? 0}`,
      `summary,transitions_queue_to_dispatched,${toDispatched.transitionCount ?? 0}`,
      "plant_wise,variety_label,plants_dispatched,dispatch_legs",
    ];
    for (const r of plantWiseFromHistory) {
      rows.push(
        [
          "plant_wise",
          esc(r.varietyLabel),
          r.plantsDispatched ?? 0,
          r.dispatchLegs ?? 0,
        ].join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="dispatch-extract-${label}.csv"`
    );
    return res.status(200).send(rows.join("\n"));
  }

  res.status(200).json({
    success: true,
    data: {
      title: "Dispatch pipeline & plant dispatch report",
      timezone: "Asia/Kolkata",
      dateRange: {
        ...rangeMeta,
        rangeUtc: { start: start.toISOString(), end: end.toISOString() },
      },
      extractSummary,
      note:
        "For one calendar day in IST, prefer query ?date=YYYY-MM-DD. " +
        "Status counts use order.statusChanges when each change was logged. " +
        "Dispatch API updates append statusChanges; older data may have gaps. " +
        "Plant units on transition rows use order line (base + add-on) at query time. " +
        "Physical plants dispatched = sum of dispatchHistory.quantity in the window (use extractSummary + CSV).",
      statusTransitions: {
        acceptedToReadyForDispatch: acceptedToReady,
        queueToDispatched: toDispatched,
        breakdownByPreviousStatus: byPreviousStatus,
      },
      dispatchHistorySummary: {
        totalPlantsDispatched: ht.totalPlants ?? 0,
        dispatchLegs: ht.dispatchLegs ?? 0,
      },
      plantsDispatchedByVariety: plantWiseFromHistory,
    },
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