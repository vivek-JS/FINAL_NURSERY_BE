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
import bcrypt from "bcryptjs";
import { 
  generateTokenPair, 
  blacklistToken,
  extractToken 
} from "../utility/jwtUtils.js";
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

const findUser = async (req, res, next) => {
  const { phoneNumber } = req.body;

  const user = await User.findOne({ phoneNumber });

  if (user) {
    return next(
      new AppError("User with same mobile number already exists", 409)
    );
  }

  next();
};

// Remove the old generateToken function as we're using the new JWT utilities

// Simple test endpoint without cookies
export const testLogin = async (req, res) => {
  try {
    res.status(200).json({
      status: "Success",
      message: "Login test endpoint working",
      timestamp: new Date().toISOString(),
      data: {
        test: true,
        message: "This endpoint works without cookies"
      }
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: error.message
    });
  }
};

const login = async (req, res, next) => {
  try {
    console.log("Login attempt started");
    const { password } = req.body;
    let phoneNumber = Number(req.body?.phoneNumber);

    // Validate phoneNumber
    if (!req.body?.phoneNumber || isNaN(phoneNumber)) {
      console.log("Invalid phone number provided:", req.body?.phoneNumber);
      return next(new AppError("Valid phone number is required", 400));
    }

    console.log("Looking for user with phone number:", phoneNumber);
    const user = await User.findOne({ phoneNumber: phoneNumber });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      console.log("Authentication failed - wrong credentials");
      return next(new AppError("Wrong credentials", 400));
    }

    console.log("User authenticated successfully");

    // Check if user is disabled
    if (user.isDisabled) {
      console.log("User is disabled");
      return next(new AppError("User account is disabled", 403));
    }

    console.log("User is not disabled, proceeding with token generation");

    // FORCE PASSWORD RESET FOR ALL USERS EXCEPT SUPER_ADMIN
    // If user is not Super Admin and password is not set, force password reset
    let shouldForcePasswordReset = false;
    if (user.role !== 'SUPER_ADMIN') {
      if (!user.isPasswordSet) {
        shouldForcePasswordReset = true;
        console.log("User needs to set password (isPasswordSet: false)");
      }
    }

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    console.log("Generating token pair...");
    // Generate token pair
    const tokenPair = generateTokenPair({
      _id: user._id.toString(),
      phoneNumber: user.phoneNumber,
      role: user.role,
      name: user.name
    });

    console.log("Token pair generated successfully");

    // Check if headers have already been sent
    if (res.headersSent) {
      console.log("Headers already sent, returning");
      return;
    }

    console.log("Generating response...");
    const response = generateResponse(
      "Success",
      shouldForcePasswordReset ? "Login successful - Password reset required" : "Login successful - Token generated successfully",
      {
        user: userResponse,
        accessToken: tokenPair.accessToken,
        refreshToken: tokenPair.refreshToken,
        expiresIn: tokenPair.expiresIn,
        isPasswordSet: user.isPasswordSet,
        forcePasswordReset: shouldForcePasswordReset,
        message: shouldForcePasswordReset ? "Password reset required on first login" : "Access token generated and ready for API calls"
      },
      undefined
    );

    console.log("Sending response...");
    return res.status(200).json(response);
  } catch (error) {
    console.error('Login Error Details:', error);
    console.error('Error Stack:', error.stack);
    return next(error);
  }
};

// Controller for first-time password change
const changePassword = async (req, res, next) => {
  try {
    const { _id } = req.user;
    const { newPassword, confirmPassword } = req.body;

    // Validate passwords
    if (!newPassword || !confirmPassword) {
      return next(new AppError("New password and confirm password are required", 400));
    }

    if (newPassword !== confirmPassword) {
      return next(new AppError("Passwords do not match", 400));
    }

    if (newPassword.length < 8) {
      return next(new AppError("Password must be at least 8 characters long", 400));
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user password and set isPasswordSet to true
    const user = await User.findByIdAndUpdate(
      _id,
      { 
        password: hashedPassword,
        isPasswordSet: true
      },
      { new: true }
    ).select('-password');

    if (!user) {
      return next(new AppError("User not found", 404));
    }

    const response = generateResponse(
      "Success",
      "Password changed successfully",
      { user },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error('Change Password Error:', error);
    return next(error);
  }
};

// Controller for super admin to reset user password
const resetPasswordForUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;

    // Check if current user is super admin
    if (req.user.role !== 'SUPER_ADMIN') {
      return next(new AppError("Only super admin can reset user passwords", 403));
    }

    // Validate password
    if (!newPassword) {
      return next(new AppError("New password is required", 400));
    }

    if (newPassword.length < 8) {
      return next(new AppError("Password must be at least 8 characters long", 400));
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user password and set isPasswordSet to false (forcing them to change on next login)
    const user = await User.findByIdAndUpdate(
      userId,
      { 
        password: hashedPassword,
        isPasswordSet: false
      },
      { new: true }
    ).select('-password');

    if (!user) {
      return next(new AppError("User not found", 404));
    }

    const response = generateResponse(
      "Success",
      "User password reset successfully. User will be prompted to change password on next login.",
      { user },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    console.error('Reset Password Error:', error);
    return next(error);
  }
};

// Controller which gives info about themselves
const aboutMe = async (req, res, next) => {
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
};

// Refresh token endpoint
export const refreshToken = async (req, res, next) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return next(new AppError("Refresh token is required", 400));
  }

  try {
    const { refreshAccessToken } = await import("../utility/jwtUtils.js");
    const newTokenPair = refreshAccessToken(refreshToken);

    const response = generateResponse(
      "Success",
      "Token refreshed successfully",
      {
        accessToken: newTokenPair.accessToken,
        refreshToken: newTokenPair.refreshToken,
        expiresIn: newTokenPair.expiresIn
      },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError("Invalid refresh token", 401));
  }
};

// Logout endpoint
export const logout = async (req, res, next) => {
  const token = extractToken(req);
  
  if (token) {
    blacklistToken(token);
  }

  const response = generateResponse(
    "Success",
    "Logged out successfully",
    null,
    undefined
  );

  return res.status(200).json(response);
};

// Verify token endpoint
export const verifyToken = async (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    return next(new AppError("Token is required", 400));
  }

  try {
    const { verifyAccessToken } = await import("../utility/jwtUtils.js");
    const decoded = verifyAccessToken(token);

    const user = await User.findById(decoded._id).select('-password');
    
    if (!user) {
      return next(new AppError("User not found", 404));
    }

    const response = generateResponse(
      "Success",
      "Token is valid",
      { user, token: decoded },
      undefined
    );

    return res.status(200).json(response);
  } catch (error) {
    return next(new AppError("Invalid token", 401));
  }
};

// Get all salespeople list
export const getSalespeople = async (req, res) => {
  try {
    const salespeople = await User.find(
      { jobTitle: "SALES" }, // Changed from role to jobTitle
      { name: 1, email: 1, phoneNumber: 1, jobTitle: 1 } // Added jobTitle and changed phone to phoneNumber
    ).sort({ name: 1 });

    res.status(200).json({
      success: true,
      data: salespeople
    });
  } catch (error) {
    console.error("Error in getSalespeople:", error);
    res.status(500).json({ 
      success: false,
      message: "Internal server error",
      error: error.message 
    });
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

/**
 * Export dealer wallet transactions to CSV
 */
const exportDealerWalletTransactionsCSV = async (req, res) => {
  try {
    console.log('\n========== EXPORT DEALER WALLET TRANSACTIONS CSV ==========');
    const { dealerId } = req.params;
    const { type } = req.query;
    
    console.log('Request parameters:');
    console.log('- dealerId:', dealerId);
    console.log('- type:', type || 'All');

    // Validate dealerId
    if (!dealerId) {
      console.log('No dealer ID provided');
      return res.status(400).json({
        success: false,
        message: "Dealer ID is required"
      });
    }

    // Find the dealer
    const dealer = await User.findOne({
      _id: dealerId,
      jobTitle: "DEALER",
      isDisabled: false
    }).select('name phoneNumber');

    if (!dealer) {
      console.log('Dealer not found or is disabled');
      return res.status(404).json({
        success: false,
        message: "Dealer not found"
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

    // Filter transactions
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

    // Format transactions for CSV
    const csvData = filteredTransactions.map((transaction, index) => {
      // Extract farmer name and village from description for cleaner format
      let description = transaction.description;
      
      // Safety check: ensure description is a string
      if (typeof description !== 'string') {
        console.log(`Warning: Non-string description found in transaction ${index + 1}:`, description);
        if (description && typeof description === 'object') {
          // If it's an object, try to extract meaningful information
          if (description.name && description.village) {
            description = `${description.name} (${description.village})`;
          } else if (description.name) {
            description = description.name;
          } else if (description.village) {
            description = description.village;
          } else {
            description = 'Order';
          }
        } else {
          description = String(description || 'Order');
        }
      }
      
      // For wallet payment transactions, extract just farmer name and village
      if (transaction.description.includes('Wallet payment collected for Order #')) {
        if (transaction.description.includes(' - Dealer Order')) {
          description = 'Dealer Order';
        } else if (transaction.description.includes(' - ')) {
          // Extract just the farmer name and village
          const farmerInfo = transaction.description.split(' - ')[1];
          if (farmerInfo && !farmerInfo.includes('Unknown')) {
            description = farmerInfo; // Just the farmer name and village
          } else {
            description = 'Order';
          }
        } else {
          description = 'Order';
        }
      } else if (transaction.description.includes('Wallet payment for Order #')) {
        if (transaction.description.includes(' - Dealer Order')) {
          description = 'Dealer Order';
        } else if (transaction.description.includes(' - ')) {
          const farmerInfo = transaction.description.split(' - ')[1];
          if (farmerInfo && !farmerInfo.includes('Unknown')) {
            description = farmerInfo; // Just the farmer name and village
          } else {
            description = 'Order';
          }
        } else {
          description = 'Order';
        }
      } else if (transaction.description.includes('Payment collected for Order #')) {
        if (transaction.description.includes(' - Dealer Order')) {
          description = 'Dealer Order';
        } else if (transaction.description.includes(' - ')) {
          const farmerInfo = transaction.description.split(' - ')[1];
          if (farmerInfo && !farmerInfo.includes('Unknown')) {
            description = farmerInfo; // Just the farmer name and village
          } else {
            description = 'Order';
          }
        } else {
          description = 'Order';
        }
      }

      return {
        'Sr No': index + 1,
        'Date': new Date(transaction.createdAt).toLocaleDateString('en-IN'),
        'Type': transaction.type,
        'Amount': transaction.amount,
        'Balance Before': transaction.balanceBefore,
        'Balance After': transaction.balanceAfter,
        'Description': description,
        'Status': transaction.status,
        'Reference': transaction.reference || '',
        'Created At': new Date(transaction.createdAt).toLocaleString('en-IN')
      };
    });

    // Create CSV content
    const csvHeaders = [
      'Sr No',
      'Date', 
      'Type',
      'Amount',
      'Balance Before',
      'Balance After',
      'Description',
      'Status',
      'Reference',
      'Created At'
    ];

    const csvContent = [
      csvHeaders.join(','),
      ...csvData.map(row => 
        csvHeaders.map(header => `"${row[header] || ''}"`).join(',')
      )
    ].join('\n');

    // Set response headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${dealer.name}_wallet_transactions_${new Date().toISOString().split('T')[0]}.csv"`);
    
    console.log('Successfully prepared CSV export');
    console.log('========== EXPORT DEALER WALLET TRANSACTIONS CSV COMPLETE ==========\n');
    
    return res.status(200).send(csvContent);
  } catch (error) {
    console.error("Error exporting dealer wallet transactions CSV:", error);
    return res.status(500).json({
      success: false,
      message: "Error exporting dealer wallet transactions CSV",
      error: error.message
    });
  }
};

// Updated getDealerInventoryStats function with fixes
export const getDealerWalletStats = async (req, res) => {
  try {
    console.log("Fetching dealer wallet stats from orders...");
    
    // Get dealer ID from params if provided
    const { dealerId } = req.params;
    
    // Build match condition for orders
    const matchCondition = dealerId ? { salesPerson: dealerId } : {};
    
    // Get all orders for dealers (bulk orders)
    const orders = await Order.find({
      ...matchCondition,
      dealerOrder: true
    });
    
    // Get plant names manually to avoid schema issues
    const plantIds = [...new Set(orders.map(order => order.plantName?.toString()).filter(Boolean))];
    const subTypeIds = [...new Set(orders.map(order => order.plantSubtype?.toString()).filter(Boolean))];
    
    const plants = await PlantCms.find({ _id: { $in: plantIds } }).select('name subtypes');
    const plantMap = new Map();
    const subTypeMap = new Map();
    
    plants.forEach(plant => {
      plantMap.set(plant._id.toString(), plant.name);
      if (plant.subtypes) {
        plant.subtypes.forEach(subtype => {
          subTypeMap.set(subtype._id.toString(), subtype.name);
        });
      }
    });
    
    console.log(`Found ${orders.length} dealer orders`);
    
    // Calculate overall stats from orders
    let totalQuantity = 0;
    let totalBookedQuantity = 0;
    let totalRemainingQuantity = 0;
    const uniqueDealers = new Set();
    const acceptedOrders = [];
    const rejectedOrders = [];
    
    orders.forEach(order => {
      uniqueDealers.add(order.salesPerson.toString());
      
      if (order.orderStatus === 'ACCEPTED') {
        totalQuantity += order.numberOfPlants || 0;
        acceptedOrders.push(order);
      } else if (order.orderStatus === 'REJECTED') {
        rejectedOrders.push(order);
      }
    });
    
    // Calculate booked quantity (orders that used dealer quota)
    const dealerQuotaOrders = await Order.find({
      ...matchCondition,
      dealerOrder: true,
      quotaSource: 'dealer'
    });
    
    totalBookedQuantity = dealerQuotaOrders.reduce((sum, order) => {
      return sum + (order.quotaUsed || 0);
    }, 0);
    
    totalRemainingQuantity = totalQuantity - totalBookedQuantity;
    
    const overallStats = {
      dealerCount: uniqueDealers.size,
      totalQuantity,
      totalBookedQuantity,
      totalRemainingQuantity,
      bookingPercentage: totalQuantity > 0 ? (totalBookedQuantity / totalQuantity) * 100 : 0,
      acceptedOrdersCount: acceptedOrders.length,
      rejectedOrdersCount: rejectedOrders.length
    };
    
    // Get plant type stats from orders
    const plantTypeMap = new Map();
    
    orders.forEach(order => {
      if (order.orderStatus === 'ACCEPTED') {
        const plantTypeId = order.plantName?.toString() || 'unknown';
        const plantTypeName = plantMap.get(plantTypeId) || `Plant Type ${plantTypeId.slice(-6)}`;
        
        if (!plantTypeMap.has(plantTypeId)) {
          plantTypeMap.set(plantTypeId, {
            plantTypeId,
            plantTypeName,
            dealerCount: new Set(),
            totalQuantity: 0,
            totalBookedQuantity: 0,
            totalRemainingQuantity: 0,
            acceptedOrders: 0,
            rejectedOrders: 0,
            subtypes: new Map() // Track subtypes for this plant type
          });
        }
        
        const stats = plantTypeMap.get(plantTypeId);
        stats.dealerCount.add(order.salesPerson.toString());
        stats.totalQuantity += order.numberOfPlants || 0;
        stats.acceptedOrders++;
        
        // Track subtype information
        const subTypeId = order.plantSubtype?.toString() || 'unknown';
        const subTypeName = subTypeMap.get(subTypeId) || `Subtype ${subTypeId.slice(-6)}`;
        
        if (!stats.subtypes.has(subTypeId)) {
          stats.subtypes.set(subTypeId, {
            subTypeId,
            subTypeName,
            totalQuantity: 0,
            totalBookedQuantity: 0,
            totalRemainingQuantity: 0
          });
        }
        
        const subTypeStats = stats.subtypes.get(subTypeId);
        subTypeStats.totalQuantity += order.numberOfPlants || 0;
        
      } else if (order.orderStatus === 'REJECTED') {
        const plantTypeId = order.plantName?.toString() || 'unknown';
        if (plantTypeMap.has(plantTypeId)) {
          plantTypeMap.get(plantTypeId).rejectedOrders++;
        }
      }
    });
    
    // Calculate booked quantities for each plant type
    for (const [plantTypeId, stats] of plantTypeMap) {
      const plantTypeOrders = dealerQuotaOrders.filter(order => 
        order.plantName?.toString() === plantTypeId
      );
      
      stats.totalBookedQuantity = plantTypeOrders.reduce((sum, order) => {
        return sum + (order.quotaUsed || 0);
      }, 0);
      
      stats.totalRemainingQuantity = stats.totalQuantity - stats.totalBookedQuantity;
      stats.bookingPercentage = stats.totalQuantity > 0 ? (stats.totalBookedQuantity / stats.totalQuantity) * 100 : 0;
    }
    
    // Convert map to array
    const plantTypeStats = Array.from(plantTypeMap.values()).map(stats => ({
      plantTypeId: stats.plantTypeId,
      plantTypeName: stats.plantTypeName,
      dealerCount: stats.dealerCount.size,
      totalQuantity: stats.totalQuantity,
      totalBookedQuantity: stats.totalBookedQuantity,
      totalRemainingQuantity: stats.totalRemainingQuantity,
      bookingPercentage: stats.bookingPercentage,
      acceptedOrders: stats.acceptedOrders,
      rejectedOrders: stats.rejectedOrders,
      subtypes: Array.from(stats.subtypes.values()).map(subTypeStats => ({
        subTypeId: subTypeStats.subTypeId,
        subTypeName: subTypeStats.subTypeName,
        totalQuantity: subTypeStats.totalQuantity,
        totalBookedQuantity: subTypeStats.totalBookedQuantity,
        totalRemainingQuantity: subTypeStats.totalRemainingQuantity,
        bookingPercentage: subTypeStats.totalQuantity > 0 ? (subTypeStats.totalBookedQuantity / subTypeStats.totalQuantity) * 100 : 0
      }))
    }));
    
    // Sort by plant type name
    plantTypeStats.sort((a, b) => a.plantTypeName.localeCompare(b.plantTypeName));
    
    // Get dealer-specific stats if dealerId is provided
    let dealerStats = null;
    if (dealerId) {
      const dealerOrders = orders.filter(order => order.salesPerson.toString() === dealerId);
      const acceptedDealerOrders = dealerOrders.filter(order => order.orderStatus === 'ACCEPTED');
      const rejectedDealerOrders = dealerOrders.filter(order => order.orderStatus === 'REJECTED');
      
      const dealerQuotaUsed = dealerQuotaOrders
        .filter(order => order.salesPerson.toString() === dealerId)
        .reduce((sum, order) => sum + (order.quotaUsed || 0), 0);
      
      const totalDealerQuantity = acceptedDealerOrders.reduce((sum, order) => sum + (order.numberOfPlants || 0), 0);
      
      dealerStats = {
        dealerId: dealerId,
        totalQuantity: totalDealerQuantity,
        totalBookedQuantity: dealerQuotaUsed,
        totalRemainingQuantity: totalDealerQuantity - dealerQuotaUsed,
        acceptedOrdersCount: acceptedDealerOrders.length,
        rejectedOrdersCount: rejectedDealerOrders.length,
                 orders: dealerOrders.map(order => ({
           orderId: order.orderId,
           plantType: plantMap.get(order.plantName?.toString()) || order.plantName?.toString() || 'Unknown',
           subType: subTypeMap.get(order.plantSubtype?.toString()) || order.plantSubtype?.toString() || 'Unknown',
           quantity: order.numberOfPlants,
           status: order.orderStatus,
           quotaUsed: order.quotaUsed || 0,
           quotaSource: order.quotaSource || 'none'
         }))
      };
    }

    // Return all stats
    res.json({
      success: true,
      overall: overallStats,
      byPlantType: plantTypeStats,
      dealerStats: dealerStats
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
    
    // Calculate summary stats manually
    const totalQuantity = dealerWallet.entries.reduce((sum, entry) => sum + (entry.quantity || 0), 0);
    const totalBookedQuantity = dealerWallet.entries.reduce((sum, entry) => sum + (entry.bookedQuantity || 0), 0);
    const totalRemainingQuantity = dealerWallet.entries.reduce((sum, entry) => sum + (entry.remainingQuantity || 0), 0);
    
    const summary = {
      totalQuantity,
      totalBookedQuantity,
      totalRemainingQuantity,
      bookingPercentage: totalQuantity > 0 ? (totalBookedQuantity / totalQuantity) * 100 : 0
    };
    
    // Get recent transactions (last 5)
    const recentTransactions = dealerWallet.transactions
      ? dealerWallet.transactions
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, 5)
      : [];
    
    // Format entries with populated data
    const formattedEntries = dealerWallet.entries.map(entry => {
      return {
        entryId: entry._id,
        plantTypeId: entry.plantType?._id,
        plantTypeName: entry.plantType?.name,
        subTypeId: entry.subType?._id,
        subTypeName: entry.subType?.name,
        bookingSlot: entry.bookingSlot ? {
          slotId: entry.bookingSlot._id,
          slotName: entry.bookingSlot.slotName,
          startDate: entry.bookingSlot.startDate,
          endDate: entry.bookingSlot.endDate
        } : null,
        quantity: entry.quantity || 0,
        bookedQuantity: entry.bookedQuantity || 0,
        remainingQuantity: entry.remainingQuantity || 0,
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

// Export all controller functions as raw async functions (not wrapped in catchAsync)
export {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  findUser,
  login,
  encryptPassword,
  changePassword,
  resetPasswordForUser,
  aboutMe,
  calculatePerformanceMetrics,
  getDealerWalletDetails,
  getDealerWalletTransactions,
  exportDealerWalletTransactionsCSV
};
