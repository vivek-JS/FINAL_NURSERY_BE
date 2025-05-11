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
import DealerWallet from "../models/dealerWallet.js";
import PlantCms from "../models/plantCms.model.js";
import mongoose from "mongoose";

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
      { role: "SALES" },
      { name: 1, email: 1, phone: 1 }
    ).sort({ name: 1 });

    res.status(200).json(salespeople);
  } catch (error) {
    console.error("Error in getSalespeople:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Get sales analytics with flexible grouping
export const getSalesAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, salesPersonId, groupBy = "daily" } = req.query;

    // Base match conditions
    let matchConditions = {};

    // Only add date conditions if both dates are provided
    if (startDate && endDate) {
      matchConditions.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
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
          as: "salesPersonDetails",
        },
      },
      {
        $group: {
          _id: "$salesPerson",
          salesPersonName: {
            $first: { $arrayElemAt: ["$salesPersonDetails.name", 0] },
          },
          totalOrders: { $sum: 1 },
          totalPlants: { $sum: "$numberOfPlants" },
          totalRevenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } },
          returnedPlants: { $sum: "$returnedPlants" },
          completedOrders: {
            $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] },
          },
          // Add date range for each salesperson
          firstOrder: { $min: "$createdAt" },
          lastOrder: { $max: "$createdAt" },
        },
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
            end: "$lastOrder",
          },
          successRate: {
            $multiply: [{ $divide: ["$completedOrders", "$totalOrders"] }, 100],
          },
          returnRate: {
            $multiply: [{ $divide: ["$returnedPlants", "$totalPlants"] }, 100],
          },
          averageOrderValue: {
            $divide: ["$totalRevenue", "$totalOrders"],
          },
        },
      },
      { $sort: { totalRevenue: -1 } },
    ];

    // Plant-wise Rankings Pipeline
    const plantWiseRankingsPipeline = [
      { $match: matchConditions },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPersonDetails",
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
        $group: {
          _id: {
            salesPerson: "$salesPerson",
            plantName: "$plantName",
            plantSubtype: "$plantSubtype",
          },
          salesPersonName: {
            $first: { $arrayElemAt: ["$salesPersonDetails.name", 0] },
          },
          plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
          totalOrders: { $sum: 1 },
          totalPlants: { $sum: "$numberOfPlants" },
          totalRevenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } },
          returnedPlants: { $sum: "$returnedPlants" },
          completedOrders: {
            $sum: { $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0] },
          },
          firstOrder: { $min: "$createdAt" },
          lastOrder: { $max: "$createdAt" },
        },
      },
      {
        $group: {
          _id: {
            plantName: "$_id.plantName",
            plantSubtype: "$_id.plantSubtype",
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
                end: "$lastOrder",
              },
              successRate: {
                $multiply: [
                  { $divide: ["$completedOrders", "$totalOrders"] },
                  100,
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          plantName: "$_id.plantName",
          plantSubtype: "$_id.plantSubtype",
          salespeople: {
            $sortArray: {
              input: "$salespeople",
              sortBy: { totalRevenue: -1 },
            },
          },
        },
      },
    ];

    // Execute pipelines
    const [salesRankings, plantWiseRankings] = await Promise.all([
      Order.aggregate(rankingsPipeline),
      Order.aggregate(plantWiseRankingsPipeline),
    ]);

    // Add rankings and calculate metrics
    salesRankings.forEach((salesperson, index) => {
      salesperson.overallRank = index + 1;
      salesperson.percentile =
        ((salesRankings.length - index) / salesRankings.length) * 100;
      salesperson.performance = {
        level:
          salesperson.percentile > 75
            ? "Excellent"
            : salesperson.percentile > 50
            ? "Good"
            : salesperson.percentile > 25
            ? "Average"
            : "Needs Improvement",
        trend: salesperson.percentile > 50 ? "up" : "down",
      };
    });

    // Add rankings to plant-wise data
    plantWiseRankings.forEach((plant) => {
      plant.salespeople.forEach((salesperson, index) => {
        salesperson.rank = index + 1;
      });
    });

    // Calculate overall summary
    const overallSummary = salesRankings.reduce(
      (acc, curr) => ({
        totalOrders: acc.totalOrders + curr.totalOrders,
        totalPlants: acc.totalPlants + curr.totalPlants,
        totalRevenue: acc.totalRevenue + curr.totalRevenue,
        totalReturns: acc.totalReturns + (curr.returnedPlants || 0),
        completedOrders: acc.completedOrders + curr.completedOrders,
      }),
      {
        totalOrders: 0,
        totalPlants: 0,
        totalRevenue: 0,
        totalReturns: 0,
        completedOrders: 0,
      }
    );

    // Add averages to summary
    overallSummary.averageOrderValue =
      overallSummary.totalRevenue / overallSummary.totalOrders;
    overallSummary.successRate =
      (overallSummary.completedOrders / overallSummary.totalOrders) * 100;
    overallSummary.returnRate =
      (overallSummary.totalReturns / overallSummary.totalPlants) * 100;

    res.status(200).json({
      dateRange:
        startDate && endDate ? { start: startDate, end: endDate } : "All Time",
      summary: overallSummary,
      rankings: {
        overall: salesRankings,
        byPlantType: plantWiseRankings,
      },
      topPerformers: {
        byRevenue: salesRankings.slice(0, 3),
        bySuccessRate: [...salesRankings]
          .sort((a, b) => b.successRate - a.successRate)
          .slice(0, 3),
        byVolume: [...salesRankings]
          .sort((a, b) => b.totalPlants - a.totalPlants)
          .slice(0, 3),
      },
    });
  } catch (error) {
    console.error("Error in getSalesAnalytics:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Helper function to process trends
const processTrends = (analytics) => {
  const dailyTrends = {};

  analytics.forEach((record) => {
    const date = record._id.date;
    if (!dailyTrends[date]) {
      dailyTrends[date] = {
        totalOrders: 0,
        totalPlants: 0,
        totalValue: 0,
      };
    }

    dailyTrends[date].totalOrders += record.totalOrders;
    dailyTrends[date].totalPlants += record.totalPlants;
    dailyTrends[date].totalValue += record.totalValue;
  });

  return Object.entries(dailyTrends).map(([date, data]) => ({
    date,
    ...data,
  }));
};

// Helper function to calculate rankings
const calculateRankings = (analytics) => {
  // Group by salesperson
  const salesPersonMetrics = {};

  analytics.forEach((record) => {
    const spId = record._id.salesPerson.toString();
    if (!salesPersonMetrics[spId]) {
      salesPersonMetrics[spId] = {
        name: record.salesPersonName,
        totalOrders: 0,
        totalPlants: 0,
        totalValue: 0,
        completedOrders: 0,
      };
    }

    salesPersonMetrics[spId].totalOrders += record.totalOrders;
    salesPersonMetrics[spId].totalPlants += record.totalPlants;
    salesPersonMetrics[spId].totalValue += record.totalValue;
    salesPersonMetrics[spId].completedOrders += record.completedOrders;
  });

  // Convert to array and sort by different metrics
  const rankingsArray = Object.entries(salesPersonMetrics).map(
    ([id, metrics]) => ({
      id,
      ...metrics,
    })
  );

  return {
    byValue: [...rankingsArray].sort((a, b) => b.totalValue - a.totalValue),
    byOrders: [...rankingsArray].sort((a, b) => b.totalOrders - a.totalOrders),
    byPlants: [...rankingsArray].sort((a, b) => b.totalPlants - a.totalPlants),
    bySuccessRate: [...rankingsArray].sort(
      (a, b) =>
        b.completedOrders / b.totalOrders - a.completedOrders / a.totalOrders
    ),
  };
};

// Helper function to calculate performance metrics
const calculatePerformanceMetrics = (analytics, salesPersonId) => {
  // Group by plant type
  const plantTypeMetrics = {};

  analytics.forEach((record) => {
    const plantId = record._id.plantName.toString();
    if (!plantTypeMetrics[plantId]) {
      plantTypeMetrics[plantId] = {
        name: record.plantName,
        totalOrders: 0,
        totalPlants: 0,
        totalValue: 0,
        subtypes: {},
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
        totalValue: 0,
      };
    }

    plantTypeMetrics[plantId].subtypes[subtypeId].totalOrders +=
      record.totalOrders;
    plantTypeMetrics[plantId].subtypes[subtypeId].totalPlants +=
      record.totalPlants;
    plantTypeMetrics[plantId].subtypes[subtypeId].totalValue +=
      record.totalValue;
  });

  return {
    byPlantType: Object.entries(plantTypeMetrics).map(([id, metrics]) => ({
      id,
      ...metrics,
      subtypes: Object.entries(metrics.subtypes).map(
        ([subtypeId, subtypeMetrics]) => ({
          id: subtypeId,
          ...subtypeMetrics,
        })
      ),
    })),
  };
};

// API Routes

// Example API usage:
// GET /api/salespeople
// GET /api/analytics/sales?startDate=2024-01-01&endDate=2024-02-01&salesPersonId=123
export const getAllDealersWithWalletInfo = async (req, res) => {
  try {
    // Find all users with jobTitle "DEALER" who are not disabled
    const dealers = await User.find({
      jobTitle: "DEALER",
      isDisabled: false,
    }).select(
      "_id name phoneNumber defaultState defaultDistrict defaultTaluka defaultVillage isOnboarded birthDate"
    );

    // If no dealers found, return empty array
    if (!dealers.length) {
      return res.status(200).json({
        success: true,
        message: "No dealers found",
        data: [],
      });
    }

    // Get dealer IDs
    const dealerIds = dealers.map((dealer) => dealer._id);

    // Fetch wallet information WITHOUT attempting to populate problematic fields
    const wallets = await DealerWallet.find({
      dealer: { $in: dealerIds },
    });

    // Create a map of dealer ID to wallet for quick lookup
    const walletMap = wallets.reduce((map, wallet) => {
      map[wallet.dealer.toString()] = wallet;
      return map;
    }, {});

    // Combine dealer and wallet information
    const dealersWithWalletInfo = dealers.map((dealer) => {
      const dealerId = dealer._id.toString();
      const wallet = walletMap[dealerId] || {};

      // Calculate totals
      const totalQuantity = wallet.entries
        ? wallet.entries.reduce((sum, entry) => sum + (entry.quantity || 0), 0)
        : 0;

      const totalBookedQuantity = wallet.entries
        ? wallet.entries.reduce(
            (sum, entry) => sum + (entry.bookedQuantity || 0),
            0
          )
        : 0;

      const totalRemainingQuantity = wallet.entries
        ? wallet.entries.reduce(
            (sum, entry) => sum + (entry.remainingQuantity || 0),
            0
          )
        : 0;

      return {
        _id: dealer._id,
        name: dealer.name,
        phoneNumber: dealer.phoneNumber,
        isOnboarded: dealer.isOnboarded,
        birthDate: dealer.birthDate,
        location: {
          state: dealer.defaultState || "",
          district: dealer.defaultDistrict || "",
          taluka: dealer.defaultTaluka || "",
          village: dealer.defaultVillage || "",
        },
        wallet: {
          _id: wallet._id || null,
          availableAmount: wallet.availableAmount || 0,
          totalQuantity: totalQuantity,
          totalBookedQuantity: totalBookedQuantity,
          totalRemainingQuantity: totalRemainingQuantity,
          // Include the basic entry information without attempting to populate
          entriesCount: wallet.entries ? wallet.entries.length : 0,
        },
      };
    });

    return res.status(200).json({
      success: true,
      message: "Dealers fetched successfully",
      count: dealersWithWalletInfo.length,
      data: dealersWithWalletInfo,
    });
  } catch (error) {
    console.error("Error fetching dealers with wallet info:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching dealers with wallet information",
      error: error.message,
    });
  }
};

const getDealerWalletDetails = async (req, res) => {
  try {
    console.log('\n========== GET DEALER WALLET DETAILS ==========');
    const { dealerId } = req.params;
    console.log('Requested dealer ID:', dealerId);

    // Validate dealerId
    if (!dealerId) {
      console.log('No dealer ID provided');
      return res.status(400).json({
        success: false,
        message: "Dealer ID is required"
      });
    }

    // Find dealer with all fields
    console.log('Finding dealer in database...');
    const dealer = await User.findOne({
      _id: dealerId,
      jobTitle: "DEALER",
      isDisabled: false
    }).select('name phoneNumber defaultState defaultDistrict defaultTaluka defaultVillage isOnboarded birthDate');

    if (!dealer) {
      console.log('Dealer not found or is disabled');
      return res.status(404).json({
        success: false,
        message: "Dealer not found"
      });
    }
    console.log('Dealer found:', dealer._id, dealer.name);

    // Find wallet WITHOUT population
    console.log('Finding wallet for dealer...');
    const wallet = await DealerWallet.findOne({ dealer: dealerId });
    if (wallet) {
      console.log('Wallet found with ID:', wallet._id);
      console.log('Available amount:', wallet.availableAmount);
      console.log('Entries count:', wallet.entries?.length || 0);
      console.log('Transactions count:', wallet.transactions?.length || 0);
    } else {
      console.log('No wallet found for dealer');
    }

    // Calculate totals
    let totalQuantity = 0;
    let totalBookedQuantity = 0;
    let totalRemainingQuantity = 0;
    
    // Process wallet entries without population
    let processedEntries = [];
    if (wallet && wallet.entries) {
      console.log('Processing wallet entries...');
      processedEntries = wallet.entries.map(entry => {
        // Add to totals
        totalQuantity += entry.quantity || 0;
        totalBookedQuantity += entry.bookedQuantity || 0;
        totalRemainingQuantity += entry.remainingQuantity || 0;
        
        return {
          _id: entry._id,
          plantTypeId: entry.plantType,
          subTypeId: entry.subType,
          bookingSlotId: entry.bookingSlot,
          quantity: entry.quantity || 0,
          bookedQuantity: entry.bookedQuantity || 0,
          remainingQuantity: entry.remainingQuantity || 0
        };
      });
    }

    // Get recent transactions
    let recentTransactions = [];
    if (wallet && wallet.transactions && wallet.transactions.length > 0) {
      console.log('Processing transactions...');
      // Sort transactions by createdAt in descending order
      const sortedTransactions = wallet.transactions.sort((a, b) => {
        if (!a.createdAt || !b.createdAt) return 0;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      
      // Get the most recent 10 transactions
      const transactionsToProcess = sortedTransactions.slice(0, 10);
      
      recentTransactions = transactionsToProcess.map(transaction => ({
        _id: transaction._id,
        type: transaction.type,
        amount: transaction.amount,
        balanceBefore: transaction.balanceBefore,
        balanceAfter: transaction.balanceAfter,
        description: transaction.description,
        status: transaction.status,
        reference: transaction.reference,
        referenceId: transaction.referenceId,
        performedBy: transaction.performedBy,
        createdAt: transaction.createdAt
      }));
      console.log(`Processed ${recentTransactions.length} recent transactions`);
    } else {
      console.log('No transactions found in wallet');
    }

    const response = {
      success: true,
      message: wallet ? "Dealer wallet details fetched successfully" : "No wallet found for this dealer",
      data: {
        dealer: {
          _id: dealer._id,
          name: dealer.name,
          phoneNumber: dealer.phoneNumber,
          isOnboarded: dealer.isOnboarded,
          birthDate: dealer.birthDate,
          location: {
            state: dealer.defaultState || "",
            district: dealer.defaultDistrict || "",
            taluka: dealer.defaultTaluka || "",
            village: dealer.defaultVillage || ""
          }
        },
        wallet: wallet ? {
          _id: wallet._id,
          availableAmount: wallet.availableAmount,
          totalQuantity: totalQuantity,
          totalBookedQuantity: totalBookedQuantity,
          totalRemainingQuantity: totalRemainingQuantity,
          entries: processedEntries,
          transactions: recentTransactions, // Added transactions to the response
          transactionsCount: wallet.transactions?.length || 0, // Added count for pagination
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt
        } : {
          availableAmount: 0,
          totalQuantity: 0,
          totalBookedQuantity: 0,
          totalRemainingQuantity: 0,
          entries: [],
          transactions: [],
          transactionsCount: 0
        }
      }
    };

    console.log('Successfully prepared response');
    console.log('========== GET DEALER WALLET DETAILS COMPLETE ==========\n');
    return res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching dealer wallet details:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching dealer wallet details",
      error: error.message
    });
  }
};

/**
 * Get all transactions for a dealer wallet with pagination
 */
const getDealerWalletTransactions = async (req, res) => {
  try {
    console.log('\n========== GET DEALER WALLET TRANSACTIONS ==========');
    const { dealerId } = req.params;
    const { page = 1, limit = 20, type } = req.query;
    
    console.log('Request parameters:');
    console.log('- dealerId:', dealerId);
    console.log('- page:', page);
    console.log('- limit:', limit);
    console.log('- type:', type || 'All');

    // Validate dealerId
    if (!dealerId) {
      console.log('No dealer ID provided');
      return res.status(400).json({
        success: false,
        message: "Dealer ID is required"
      });
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    
    if (isNaN(pageNum) || isNaN(limitNum) || pageNum < 1 || limitNum < 1) {
      console.log('Invalid pagination parameters');
      return res.status(400).json({
        success: false,
        message: "Invalid pagination parameters"
      });
    }

    // Find the wallet
    console.log('Finding wallet for dealer...');
    const wallet = await DealerWallet.findOne({ dealer: dealerId });

    if (!wallet) {
      console.log('No wallet found for dealer');
      return res.status(404).json({
        success: false,
        message: "Wallet not found for this dealer"
      });
    }

    console.log('Wallet found with ID:', wallet._id);
    console.log('Total transactions:', wallet.transactions?.length || 0);

    // Filter and sort transactions
    let filteredTransactions = wallet.transactions || [];
    
    // Filter by type if specified
    if (type && ['CREDIT', 'DEBIT', 'INVENTORY_ADD', 'INVENTORY_BOOK', 'INVENTORY_RELEASE'].includes(type.toUpperCase())) {
      const typeFilter = type.toUpperCase();
      console.log('Filtering by type:', typeFilter);
      filteredTransactions = filteredTransactions.filter(t => t.type === typeFilter);
      console.log('Transactions after filtering:', filteredTransactions.length);
    }

    // Sort by createdAt in descending order
    filteredTransactions.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    // Calculate pagination
    const totalCount = filteredTransactions.length;
    const totalPages = Math.ceil(totalCount / limitNum);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = Math.min(startIndex + limitNum, totalCount);
    
    console.log('Pagination details:');
    console.log('- Total transactions:', totalCount);
    console.log('- Total pages:', totalPages);
    console.log('- Current page:', pageNum);
    console.log('- Transactions per page:', limitNum);
    console.log('- Showing transactions:', startIndex, 'to', endIndex - 1);

    // Get transactions for current page
    const paginatedTransactions = filteredTransactions.slice(startIndex, endIndex);
    
    // Format transactions for response
    const formattedTransactions = paginatedTransactions.map(transaction => ({
      _id: transaction._id,
      type: transaction.type,
      amount: transaction.amount,
      balanceBefore: transaction.balanceBefore,
      balanceAfter: transaction.balanceAfter,
      description: transaction.description,
      status: transaction.status,
      reference: transaction.reference,
      referenceId: transaction.referenceId,
      performedBy: transaction.performedBy,
      createdAt: transaction.createdAt
    }));

    const response = {
      success: true,
      message: "Dealer wallet transactions fetched successfully",
      data: {
        transactions: formattedTransactions,
        pagination: {
          total: totalCount,
          page: pageNum,
          limit: limitNum,
          totalPages: totalPages,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1
        }
      }
    };

    console.log('Successfully prepared response');
    console.log('========== GET DEALER WALLET TRANSACTIONS COMPLETE ==========\n');
    return res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching dealer wallet transactions:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching dealer wallet transactions",
      error: error.message
    });
  }
};

// Updated getDealerInventoryStats function with fixes
export const getDealerWalletStats = async (req, res) => {
  try {
    console.log("Fetching dealer wallet stats...");
    
    // Pipeline to aggregate stats by plant type and subtype
    const statsByPlantAndSubtype = await DealerWallet.aggregate([
      // Unwind the entries array to work with individual entries
      { $unwind: "$entries" },
      
      // Group by plant type and subtype
      {
        $group: {
          _id: {
            plantType: "$entries.plantType",
            subType: "$entries.subType"
          },
          totalDealers: { $addToSet: "$dealer" }, // Count unique dealers
          totalQuantity: { $sum: "$entries.quantity" },
          totalBookedQuantity: { $sum: "$entries.bookedQuantity" },
          totalRemainingQuantity: { $sum: "$entries.remainingQuantity" },
          entries: { $push: "$entries" }
        }
      },
      
      // Lookup plant type details
      {
        $lookup: {
          from: "plantcms", // Adjust collection name if different
          localField: "_id.plantType",
          foreignField: "_id",
          as: "plantTypeDetails"
        }
      },
      
      // Filter to only get the subtype that matches
      {
        $addFields: {
          "plantTypeDetails": { $arrayElemAt: ["$plantTypeDetails", 0] },
          "subTypeDetails": {
            $filter: {
              input: { $arrayElemAt: ["$plantTypeDetails.subtypes", 0] },
              as: "subtype",
              cond: { $eq: ["$$subtype._id", "$_id.subType"] }
            }
          }
        }
      },
      
      // Project fields for the final output
      {
        $project: {
          _id: 0,
          plantTypeId: "$_id.plantType",
          subTypeId: "$_id.subType",
          plantTypeName: "$plantTypeDetails.name",
          subTypeName: { $arrayElemAt: ["$subTypeDetails.name", 0] },
          dealerCount: { $size: "$totalDealers" },
          totalQuantity: 1,
          totalBookedQuantity: 1,
          totalRemainingQuantity: 1,
          bookingPercentage: {
            $multiply: [
              { $divide: ["$totalBookedQuantity", { $max: ["$totalQuantity", 1] }] },
              100
            ]
          }
        }
      },
      
      // Sort by plant type name and then subtype name
      { $sort: { plantTypeName: 1, subTypeName: 1 } }
    ]);

    // Calculate overall totals
    const overallStats = await DealerWallet.aggregate([
      { $unwind: "$entries" },
      {
        $group: {
          _id: null,
          uniqueDealers: { $addToSet: "$dealer" },
          totalEntries: { $sum: 1 },
          totalQuantity: { $sum: "$entries.quantity" },
          totalBookedQuantity: { $sum: "$entries.bookedQuantity" },
          totalRemainingQuantity: { $sum: "$entries.remainingQuantity" }
        }
      },
      {
        $project: {
          _id: 0,
          dealerCount: { $size: "$uniqueDealers" },
          entryCount: "$totalEntries",
          totalQuantity: 1,
          totalBookedQuantity: 1,
          totalRemainingQuantity: 1,
          bookingPercentage: {
            $multiply: [
              { $divide: ["$totalBookedQuantity", { $max: ["$totalQuantity", 1] }] },
              100
            ]
          }
        }
      }
    ]);
    
    // Get plant type stats (aggregated at plant type level only)
    const plantTypeStats = await DealerWallet.aggregate([
      { $unwind: "$entries" },
      {
        $group: {
          _id: "$entries.plantType",
          totalDealers: { $addToSet: "$dealer" },
          totalQuantity: { $sum: "$entries.quantity" },
          totalBookedQuantity: { $sum: "$entries.bookedQuantity" },
          totalRemainingQuantity: { $sum: "$entries.remainingQuantity" }
        }
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "_id",
          foreignField: "_id",
          as: "plantTypeDetails"
        }
      },
      {
        $project: {
          _id: 0,
          plantTypeId: "$_id",
          plantTypeName: { $arrayElemAt: ["$plantTypeDetails.name", 0] },
          dealerCount: { $size: "$totalDealers" },
          totalQuantity: 1,
          totalBookedQuantity: 1,
          totalRemainingQuantity: 1,
          bookingPercentage: {
            $multiply: [
              { $divide: ["$totalBookedQuantity", { $max: ["$totalQuantity", 1] }] },
              100
            ]
          }
        }
      },
      { $sort: { plantTypeName: 1 } }
    ]);

    // Return all stats
    res.json({
      success: true,
      overall: overallStats[0] || {
        dealerCount: 0,
        entryCount: 0,
        totalQuantity: 0,
        totalBookedQuantity: 0,
        totalRemainingQuantity: 0,
        bookingPercentage: 0
      },
      byPlantType: plantTypeStats,
      byPlantAndSubtype: statsByPlantAndSubtype
    });
  } catch (error) {
    console.error("Error fetching dealer wallet stats:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch dealer wallet statistics",
      error: error.message
    });
  }
};
export const getDealerStats = async (req, res) => {
  try {
    const { dealerId } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(dealerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid dealer ID format"
      });
    }
    
    // Find the dealer's wallet
    const dealerWallet = await DealerWallet.findOne({ dealer: dealerId })
      .populate('entries.plantType', 'name')
      .populate('entries.subType', 'name')
      .populate('entries.bookingSlot', 'slotName startDate endDate');
    
    if (!dealerWallet) {
      return res.status(404).json({
        success: false,
        message: "Dealer wallet not found"
      });
    }
    
    // Calculate summary stats
    const summary = dealerWallet.getSummary();
    
    // Get recent transactions
    const recentTransactions = dealerWallet.getRecentTransactions(5);
    
    // Format entries with populated data
    const formattedEntries = dealerWallet.entries.map(entry => {
      return {
        entryId: entry._id,
        plantTypeId: entry.plantType._id,
        plantTypeName: entry.plantType.name,
        subTypeId: entry.subType._id,
        subTypeName: entry.subType.name,
        bookingSlot: entry.bookingSlot ? {
          slotId: entry.bookingSlot._id,
          slotName: entry.bookingSlot.slotName,
          startDate: entry.bookingSlot.startDate,
          endDate: entry.bookingSlot.endDate
        } : null,
        quantity: entry.quantity,
        bookedQuantity: entry.bookedQuantity,
        remainingQuantity: entry.remainingQuantity,
        bookingPercentage: (entry.quantity > 0) 
          ? (entry.bookedQuantity / entry.quantity) * 100 
          : 0
      };
    });
    
    res.json({
      success: true,
      dealerId: dealerWallet.dealer,
      availableAmount: dealerWallet.availableAmount,
      summary,
      entries: formattedEntries,
      recentTransactions: recentTransactions.map(t => ({
        transactionId: t._id,
        type: t.type,
        amount: t.amount,
        description: t.description,
        createdAt: t.createdAt,
        status: t.status
      }))
    });
  } catch (error) {
    console.error("Error fetching dealer stats:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch dealer statistics",
      error: error.message
    });
  }
};

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
  calculatePerformanceMetrics,
  getDealerWalletDetails,
  getDealerWalletTransactions
};
