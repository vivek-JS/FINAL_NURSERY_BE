import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";
import Pricing from "../models/pricing.model.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import mongoose from "mongoose";

// Dashboard Overview Analytics
export const getDashboardAnalytics = catchAsync(async (req, res, next) => {
  const { startDate, endDate, timeRange = 'monthly' } = req.query;
  
  // Calculate date range
  const dateFilter = {};
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
  } else {
    // Default to last month
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    dateFilter.createdAt = { $gte: lastMonth };
  }

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

  // Get monthly trends
  const monthlyTrends = await Order.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" }
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
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
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
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
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
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
          ...(groupBy === 'week' && { week: { $week: "$createdAt" } }),
          ...(groupBy === 'day' && { day: { $dayOfMonth: "$createdAt" } })
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
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
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
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
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
        firstOrder: { $min: "$createdAt" },
        lastOrder: { $max: "$createdAt" }
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
        createdAt: { $gte: startOfYear, $lte: endOfYear }
      }
    },
    {
      $group: {
        _id: { month: { $month: "$createdAt" } },
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