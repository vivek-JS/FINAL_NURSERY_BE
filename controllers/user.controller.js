import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import User from "../models/user.model.js";
import {
  createOne,
  updateOne,
  deleteOne,
  isPhoneNumberExists,
  isDisabled,
} from "./factory.controller.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Order from "../models/order.model.js";

const createUser = [isPhoneNumberExists(User, "User"), createOne(User, "User")];
const updateUser = updateOne(User, "User");
const deleteUser = deleteOne(User, "User");
const getUsers = async (req, res) => {
  try {
    const { jobTitle } = req.query;
    let query = { isDisabled: false };

    // Add jobTitle to query if provided
    if (jobTitle) {
      query.jobTitle = jobTitle;
    }

    const users = await User.find(query).select("-password");

    return res.status(200).json({
      success: true,
      message: "Users fetched successfully",
      data: users,
    });
  } catch (error) {
    console.error("Error in getUsers:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error.message,
    });
  }
};
const encryptPassword = async (req, res, next) => {
  const password = req.body.password || "12345";
  req.body.password = await bcrypt.hash(password, 10);
  next();
};

const findUser = catchAsync(async (req, res, next) => {
  const { phoneNumber } = req.body;

  const user = await User.findOne({ phoneNumber });

  if (user) {
    return next(
      new AppError("User with same mobile number already exists", 409)
    );
  }

  next();
});

const generateToken = (data) => {
  const token = jwt.sign(
    {
      data,
    },
    process.env.PRIVATE_KEY,
    {
      expiresIn: process.env.TOKEN_EXPIRY,
    }
  );

  return token;
};

const login = [
  isDisabled(User, "User"),
  catchAsync(async (req, res, next) => {
    const { password } = req.body;
    let phoneNumber = Number(req.body?.phoneNumber);

    const user = await User.findOne({ phoneNumber: phoneNumber });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return next(new AppError("Wrong credentails", 400));
    }

    user.password = undefined;

    const token = generateToken(user);
    const response = generateResponse(
      "Success",
      "Login success",
      user,
      undefined
    );
    return res
      .status(200)
      .cookie("Authorization", token, { httpOnly: true })
      .json({ token: token, response });
  }),
];

// Controller used to reset password
const resetPassword = catchAsync(async (req, res, next) => {
  const { _id } = req.user;

  let password = req.body.password || "12345";
  password = await bcrypt.hash(password, 10);

  const user = await User.findByIdAndUpdate(_id, { password });

  if (!user) {
    return next(new AppError("User not found", 404));
  }

  return res.status(200).json({
    success: true,
    message: "User password updated successfully",
  });
});

// Controller which gives info about themselves
const aboutMe = catchAsync(async (req, res, next) => {
  const { _id } = req.user;

  const user = await User.findById(_id);

  if (!user) {
    return next(new AppError("User not found", 404));
  }

  return res.status(200).json({
    success: true,
    message: "User found successfully",
    data: user,
  });
});


// Get all salespeople list
export const getSalespeople = async (req, res) => {
  try {
    const salespeople = await User.find(
      { role: 'SALES' }, 
      { name: 1, email: 1, phone: 1 }
    ).sort({ name: 1 });

    res.status(200).json(salespeople);
  } catch (error) {
    console.error('Error in getSalespeople:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get sales analytics with flexible grouping
export const getSalesAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, salesPersonId, groupBy = 'daily' } = req.query;

    // Base match conditions
    let matchConditions = {};

    // Only add date conditions if both dates are provided
    if (startDate && endDate) {
      matchConditions.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    if (salesPersonId) {
      matchConditions.salesPerson = new mongoose.Types.ObjectId(salesPersonId);
    }

    // Rankings Pipeline
    const rankingsPipeline = [
      { $match: matchConditions },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPersonDetails"
        }
      },
      {
        $group: {
          _id: "$salesPerson",
          salesPersonName: { $first: { $arrayElemAt: ["$salesPersonDetails.name", 0] } },
          totalOrders: { $sum: 1 },
          totalPlants: { $sum: "$numberOfPlants" },
          totalRevenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } },
          returnedPlants: { $sum: "$returnedPlants" },
          completedOrders: {
            $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
          },
          // Add date range for each salesperson
          firstOrder: { $min: "$createdAt" },
          lastOrder: { $max: "$createdAt" }
        }
      },
      {
        $project: {
          _id: 1,
          salesPersonName: 1,
          totalOrders: 1,
          totalPlants: 1,
          totalRevenue: 1,
          returnedPlants: 1,
          completedOrders: 1,
          dateRange: {
            start: "$firstOrder",
            end: "$lastOrder"
          },
          successRate: {
            $multiply: [
              { $divide: ["$completedOrders", "$totalOrders"] },
              100
            ]
          },
          returnRate: {
            $multiply: [
              { $divide: ["$returnedPlants", "$totalPlants"] },
              100
            ]
          },
          averageOrderValue: {
            $divide: ["$totalRevenue", "$totalOrders"]
          }
        }
      },
      { $sort: { totalRevenue: -1 } }
    ];

    // Plant-wise Rankings Pipeline
    const plantWiseRankingsPipeline = [
      { $match: matchConditions },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPersonDetails"
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantDetails"
        }
      },
      {
        $group: {
          _id: {
            salesPerson: "$salesPerson",
            plantName: "$plantName",
            plantSubtype: "$plantSubtype"
          },
          salesPersonName: { $first: { $arrayElemAt: ["$salesPersonDetails.name", 0] } },
          plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
          totalOrders: { $sum: 1 },
          totalPlants: { $sum: "$numberOfPlants" },
          totalRevenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } },
          returnedPlants: { $sum: "$returnedPlants" },
          completedOrders: {
            $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] }
          },
          firstOrder: { $min: "$createdAt" },
          lastOrder: { $max: "$createdAt" }
        }
      },
      {
        $group: {
          _id: {
            plantName: "$_id.plantName",
            plantSubtype: "$_id.plantSubtype"
          },
          salespeople: {
            $push: {
              salesPersonId: "$_id.salesPerson",
              salesPersonName: "$salesPersonName",
              totalOrders: "$totalOrders",
              totalPlants: "$totalPlants",
              totalRevenue: "$totalRevenue",
              returnedPlants: "$returnedPlants",
              completedOrders: "$completedOrders",
              dateRange: {
                start: "$firstOrder",
                end: "$lastOrder"
              },
              successRate: {
                $multiply: [
                  { $divide: ["$completedOrders", "$totalOrders"] },
                  100
                ]
              }
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          plantName: "$_id.plantName",
          plantSubtype: "$_id.plantSubtype",
          salespeople: {
            $sortArray: {
              input: "$salespeople",
              sortBy: { totalRevenue: -1 }
            }
          }
        }
      }
    ];

    // Execute pipelines
    const [salesRankings, plantWiseRankings] = await Promise.all([
      Order.aggregate(rankingsPipeline),
      Order.aggregate(plantWiseRankingsPipeline)
    ]);

    // Add rankings and calculate metrics
    salesRankings.forEach((salesperson, index) => {
      salesperson.overallRank = index + 1;
      salesperson.percentile = ((salesRankings.length - index) / salesRankings.length) * 100;
      salesperson.performance = {
        level: salesperson.percentile > 75 ? 'Excellent' : 
               salesperson.percentile > 50 ? 'Good' :
               salesperson.percentile > 25 ? 'Average' : 'Needs Improvement',
        trend: salesperson.percentile > 50 ? 'up' : 'down'
      };
    });

    // Add rankings to plant-wise data
    plantWiseRankings.forEach(plant => {
      plant.salespeople.forEach((salesperson, index) => {
        salesperson.rank = index + 1;
      });
    });

    // Calculate overall summary
    const overallSummary = salesRankings.reduce((acc, curr) => ({
      totalOrders: acc.totalOrders + curr.totalOrders,
      totalPlants: acc.totalPlants + curr.totalPlants,
      totalRevenue: acc.totalRevenue + curr.totalRevenue,
      totalReturns: acc.totalReturns + (curr.returnedPlants || 0),
      completedOrders: acc.completedOrders + curr.completedOrders
    }), {
      totalOrders: 0,
      totalPlants: 0,
      totalRevenue: 0,
      totalReturns: 0,
      completedOrders: 0
    });

    // Add averages to summary
    overallSummary.averageOrderValue = overallSummary.totalRevenue / overallSummary.totalOrders;
    overallSummary.successRate = (overallSummary.completedOrders / overallSummary.totalOrders) * 100;
    overallSummary.returnRate = (overallSummary.totalReturns / overallSummary.totalPlants) * 100;

    res.status(200).json({
      dateRange: startDate && endDate ? { start: startDate, end: endDate } : "All Time",
      summary: overallSummary,
      rankings: {
        overall: salesRankings,
        byPlantType: plantWiseRankings
      },
      topPerformers: {
        byRevenue: salesRankings.slice(0, 3),
        bySuccessRate: [...salesRankings].sort((a, b) => b.successRate - a.successRate).slice(0, 3),
        byVolume: [...salesRankings].sort((a, b) => b.totalPlants - a.totalPlants).slice(0, 3)
      }
    });

  } catch (error) {
    console.error('Error in getSalesAnalytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Helper function to process trends
const processTrends = (analytics) => {
  const dailyTrends = {};
  
  analytics.forEach(record => {
    const date = record._id.date;
    if (!dailyTrends[date]) {
      dailyTrends[date] = {
        totalOrders: 0,
        totalPlants: 0,
        totalValue: 0
      };
    }
    
    dailyTrends[date].totalOrders += record.totalOrders;
    dailyTrends[date].totalPlants += record.totalPlants;
    dailyTrends[date].totalValue += record.totalValue;
  });

  return Object.entries(dailyTrends).map(([date, data]) => ({
    date,
    ...data
  }));
};

// Helper function to calculate rankings
const calculateRankings = (analytics) => {
  // Group by salesperson
  const salesPersonMetrics = {};
  
  analytics.forEach(record => {
    const spId = record._id.salesPerson.toString();
    if (!salesPersonMetrics[spId]) {
      salesPersonMetrics[spId] = {
        name: record.salesPersonName,
        totalOrders: 0,
        totalPlants: 0,
        totalValue: 0,
        completedOrders: 0
      };
    }
    
    salesPersonMetrics[spId].totalOrders += record.totalOrders;
    salesPersonMetrics[spId].totalPlants += record.totalPlants;
    salesPersonMetrics[spId].totalValue += record.totalValue;
    salesPersonMetrics[spId].completedOrders += record.completedOrders;
  });

  // Convert to array and sort by different metrics
  const rankingsArray = Object.entries(salesPersonMetrics).map(([id, metrics]) => ({
    id,
    ...metrics
  }));

  return {
    byValue: [...rankingsArray].sort((a, b) => b.totalValue - a.totalValue),
    byOrders: [...rankingsArray].sort((a, b) => b.totalOrders - a.totalOrders),
    byPlants: [...rankingsArray].sort((a, b) => b.totalPlants - a.totalPlants),
    bySuccessRate: [...rankingsArray].sort((a, b) => 
      (b.completedOrders / b.totalOrders) - (a.completedOrders / a.totalOrders)
    )
  };
};

// Helper function to calculate performance metrics
const calculatePerformanceMetrics = (analytics, salesPersonId) => {
  // Group by plant type
  const plantTypeMetrics = {};
  
  analytics.forEach(record => {
    const plantId = record._id.plantName.toString();
    if (!plantTypeMetrics[plantId]) {
      plantTypeMetrics[plantId] = {
        name: record.plantName,
        totalOrders: 0,
        totalPlants: 0,
        totalValue: 0,
        subtypes: {}
      };
    }
    
    // Add main metrics
    plantTypeMetrics[plantId].totalOrders += record.totalOrders;
    plantTypeMetrics[plantId].totalPlants += record.totalPlants;
    plantTypeMetrics[plantId].totalValue += record.totalValue;

    // Track subtype metrics
    const subtypeId = record._id.plantSubtype.toString();
    if (!plantTypeMetrics[plantId].subtypes[subtypeId]) {
      plantTypeMetrics[plantId].subtypes[subtypeId] = {
        name: record.subtypeName,
        totalOrders: 0,
        totalPlants: 0,
        totalValue: 0
      };
    }
    
    plantTypeMetrics[plantId].subtypes[subtypeId].totalOrders += record.totalOrders;
    plantTypeMetrics[plantId].subtypes[subtypeId].totalPlants += record.totalPlants;
    plantTypeMetrics[plantId].subtypes[subtypeId].totalValue += record.totalValue;
  });

  return {
    byPlantType: Object.entries(plantTypeMetrics).map(([id, metrics]) => ({
      id,
      ...metrics,
      subtypes: Object.entries(metrics.subtypes).map(([subtypeId, subtypeMetrics]) => ({
        id: subtypeId,
        ...subtypeMetrics
      }))
    }))
  };
};

// API Routes


// Example API usage:
// GET /api/salespeople
// GET /api/analytics/sales?startDate=2024-01-01&endDate=2024-02-01&salesPersonId=123

export {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  findUser,
  login,
  encryptPassword,
  resetPassword,
  aboutMe,
  calculatePerformanceMetrics
};
