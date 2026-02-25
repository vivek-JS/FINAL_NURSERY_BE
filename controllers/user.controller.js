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
import DealerLedgerEntry from "../models/dealerLedgerEntry.model.js";
import PlantCms from "../models/plantCms.model.js";
import mongoose from "mongoose";
import { uploadImageToCloudinary } from "../utils/cloudinaryUtils.js";
import axios from "axios";
import moment from "moment";
import { ImageAnnotatorClient } from "@google-cloud/vision";

const setRoleFromJobTitle = (req, res, next) => {
  if (req.body.jobTitle) {
    req.body.role = req.body.jobTitle;
  }
  next();
};

const createUser = [isPhoneNumberExists(User, "User"), setRoleFromJobTitle, createOne(User, "User")];
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
  const password = req.body.password || "1234";
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
    console.log("Request body:", JSON.stringify(req.body));
    const { password } = req.body;
    let phoneNumber = Number(req.body?.phoneNumber);

    // Validate phoneNumber
    if (!req.body?.phoneNumber || isNaN(phoneNumber)) {
      console.log("Invalid phone number provided:", req.body?.phoneNumber);
      return next(new AppError("Valid phone number is required", 400));
    }

    console.log("Looking for user with phone number:", phoneNumber, "(type:", typeof phoneNumber, ")");
    const user = await User.findOne({ phoneNumber: phoneNumber });
    console.log("User found:", !!user);
    
    if (user) {
      console.log("User details - Name:", user.name, "Phone:", user.phoneNumber, "isDisabled:", user.isDisabled);
      console.log("Password hash exists:", !!user.password, "Length:", user.password?.length);
      const passwordMatch = await bcrypt.compare(password, user.password);
      console.log("Password comparison result:", passwordMatch, "for password:", password);
      
      if (!passwordMatch) {
        console.log("Authentication failed - password mismatch");
        return next(new AppError("Wrong credentials", 400));
      }
    } else {
      console.log("Authentication failed - user not found");
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
      jobTitle: user.jobTitle,
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

    // Check if current user is super admin - prioritize jobTitle over role
    const userRole = req.user?.jobTitle || req.user?.role;
    if (userRole !== 'SUPER_ADMIN') {
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

  // Handle null/undefined/empty refreshToken gracefully
  if (!refreshToken || refreshToken === null || refreshToken === 'null') {
    return res.status(400).json(
      generateResponse('error', 'Refresh token is required', null, null)
    );
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
 * Get immutable dealer ledger entries for audit
 * GET /dealers/:dealerId/ledger?startDate=&endDate=&page=&limit=
 */
const getDealerLedger = async (req, res) => {
  try {
    const { dealerId } = req.params;
    const { startDate, endDate, page = 1, limit = 50 } = req.query;

    if (!dealerId || !mongoose.Types.ObjectId.isValid(dealerId)) {
      return res.status(400).json({
        success: false,
        message: "Valid dealer ID is required",
      });
    }

    const query = { dealer: new mongoose.Types.ObjectId(dealerId) };

    if (startDate || endDate) {
      query.entryDate = {};
      if (startDate) query.entryDate.$gte = new Date(startDate);
      if (endDate) query.entryDate.$lte = new Date(endDate + "T23:59:59.999Z");
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [entries, totalCount] = await Promise.all([
      DealerLedgerEntry.find(query)
        .populate("createdBy", "name")
        .populate("orderId", "orderId numberOfPlants")
        .sort({ entryDate: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      DealerLedgerEntry.countDocuments(query),
    ]);

    const totalDebit = (
      await DealerLedgerEntry.aggregate([
        { $match: query },
        { $group: { _id: null, total: { $sum: "$debit" } } },
      ])
    )[0]?.total || 0;

    const totalCredit = (
      await DealerLedgerEntry.aggregate([
        { $match: query },
        { $group: { _id: null, total: { $sum: "$credit" } } },
      ])
    )[0]?.total || 0;

    return res.status(200).json({
      success: true,
      data: {
        entries,
        summary: {
          totalDebit,
          totalCredit,
          balance: totalCredit - totalDebit,
        },
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching dealer ledger:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching dealer ledger",
      error: error.message,
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
      
      // For dealer orders:
      // - totalQuantity = sum of numberOfPlants from ACCEPTED orders only
      // - totalBookedQuantity = sum of quotaUsed (actual quota allocated)
      if (order.orderStatus === 'ACCEPTED') {
        acceptedOrders.push(order);
        totalQuantity += order.numberOfPlants || 0;
        totalBookedQuantity += order.quotaUsed || 0;
      } else if (order.orderStatus === 'REJECTED') {
        rejectedOrders.push(order);
      }
    });
    
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
      // Only count ACCEPTED orders for total quantity
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
      
      // Track order status counts and quantities
      if (order.orderStatus === 'ACCEPTED') {
        stats.acceptedOrders++;
        stats.totalQuantity += order.numberOfPlants || 0;
        stats.totalBookedQuantity += order.quotaUsed || 0;
        subTypeStats.totalQuantity += order.numberOfPlants || 0;
        subTypeStats.totalBookedQuantity += order.quotaUsed || 0;
      } else if (order.orderStatus === 'REJECTED') {
        stats.rejectedOrders++;
      }
    });
    
    // Calculate remaining quantities and percentages for each plant type and subtype
    for (const [plantTypeId, stats] of plantTypeMap) {
      stats.totalRemainingQuantity = stats.totalQuantity - stats.totalBookedQuantity;
      stats.bookingPercentage = stats.totalQuantity > 0 ? (stats.totalBookedQuantity / stats.totalQuantity) * 100 : 0;
      
      // Calculate remaining quantities and percentages for each subtype
      for (const [subTypeId, subTypeStats] of stats.subtypes) {
        subTypeStats.totalRemainingQuantity = subTypeStats.totalQuantity - subTypeStats.totalBookedQuantity;
        subTypeStats.bookingPercentage = subTypeStats.totalQuantity > 0 ? (subTypeStats.totalBookedQuantity / subTypeStats.totalQuantity) * 100 : 0;
      }
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
      
      // Calculate booked quantity from quotaUsed in ACCEPTED orders
      const dealerBookedQuantity = acceptedDealerOrders.reduce((sum, order) => {
        return sum + (order.quotaUsed || 0);
      }, 0);
      
      // Count total quantity from ACCEPTED dealer orders only
      const totalDealerQuantity = acceptedDealerOrders.reduce((sum, order) => sum + (order.numberOfPlants || 0), 0);
      
      dealerStats = {
        dealerId: dealerId,
        totalQuantity: totalDealerQuantity,
        totalBookedQuantity: dealerBookedQuantity,
        totalRemainingQuantity: totalDealerQuantity - dealerBookedQuantity,
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
    
    // Find the dealer's wallet using aggregation to handle subdocument references
    const walletData = await DealerWallet.aggregate([
      { $match: { dealer: new mongoose.Types.ObjectId(dealerId) } },
      {
        $lookup: {
          from: 'plantcms',
          localField: 'entries.plantType',
          foreignField: '_id',
          as: 'plantTypes'
        }
      }
    ]);
    
    const dealerWallet = walletData[0];
    
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

// Controller to reset all dealer passwords to 1234
const resetAllDealerPasswords = async (req, res, next) => {
  try {
    // Check if current user is super admin or admin - prioritize jobTitle over role
    const userRole = req.user?.jobTitle || req.user?.role;
    if (!req.user || (userRole !== "SUPER_ADMIN" && userRole !== "ADMIN")) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin or Admin can reset dealer passwords"
      });
    }

    // Default password for dealers
    const DEFAULT_PASSWORD = "1234";
    
    // Hash the default password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, salt);

    // Find all dealers (active and not disabled)
    const dealers = await User.find({
      $or: [
        { role: 'DEALER' },
        { jobTitle: 'DEALER' }
      ],
      isDisabled: { $ne: true }
    });

    if (dealers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No active dealers found"
      });
    }

    // Update all dealer passwords
    const updatePromises = dealers.map(dealer => 
      User.findByIdAndUpdate(
        dealer._id,
        {
          password: hashedPassword,
          isPasswordSet: false // Force password change on next login
        },
        { new: true }
      )
    );

    await Promise.all(updatePromises);

    res.status(200).json({
      success: true,
      message: `Successfully reset passwords for ${dealers.length} dealer(s) to 1234`,
      count: dealers.length,
      dealers: dealers.map(d => ({
        id: d._id,
        name: d.name,
        phoneNumber: d.phoneNumber
      }))
    });

  } catch (error) {
    console.error("Error resetting dealer passwords:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reset dealer passwords",
      error: error.message
    });
  }
};

// Controller to reset all dispatch manager passwords to 1234
const resetAllDispatchManagerPasswords = async (req, res, next) => {
  try {
    // Check if current user is super admin or admin - prioritize jobTitle over role
    const userRole = req.user?.jobTitle || req.user?.role;
    if (!req.user || (userRole !== "SUPER_ADMIN" && userRole !== "ADMIN")) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin or Admin can reset dispatch manager passwords"
      });
    }

    // Default password for dispatch managers
    const DEFAULT_PASSWORD = "1234";
    
    // Hash the default password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, salt);

    // Find all dispatch managers (active and not disabled)
    const dispatchManagers = await User.find({
      $or: [
        { role: 'DISPATCH_MANAGER' },
        { jobTitle: 'DISPATCH_MANAGER' }
      ],
      isDisabled: { $ne: true }
    });

    if (dispatchManagers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No active dispatch managers found"
      });
    }

    // Update all dispatch manager passwords
    const updatePromises = dispatchManagers.map(manager => 
      User.findByIdAndUpdate(
        manager._id,
        {
          password: hashedPassword,
          isPasswordSet: false // Force password change on next login
        },
        { new: true }
      )
    );

    await Promise.all(updatePromises);

    res.status(200).json({
      success: true,
      message: `Successfully reset passwords for ${dispatchManagers.length} dispatch manager(s) to 1234`,
      count: dispatchManagers.length,
      dispatchManagers: dispatchManagers.map(m => ({
        id: m._id,
        name: m.name,
        phoneNumber: m.phoneNumber
      }))
    });

  } catch (error) {
    console.error("Error resetting dispatch manager passwords:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reset dispatch manager passwords",
      error: error.message
    });
  }
};

// Upload media (images) to Cloudinary
const uploadMedia = async (req, res, next) => {
  try {
    if (!req.file) {
      return next(new AppError("No file uploaded. Please provide a file.", 400));
    }

    const { media_type = "IMAGE" } = req.body;

    // Validate file type
    if (media_type === "IMAGE") {
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];
      if (!allowedTypes.includes(req.file.mimetype)) {
        return next(new AppError("Invalid file type. Only JPG, PNG, WEBP, AVIF, and GIF images are allowed.", 400));
      }
    }

    // Upload to Cloudinary
    const uploadResult = await uploadImageToCloudinary(
      req.file.buffer,
      `nursery-${media_type.toLowerCase()}s`,
      {
        resource_type: media_type === "IMAGE" ? "image" : "auto",
      }
    );

    if (!uploadResult.success) {
      return next(new AppError(uploadResult.error || "Failed to upload media", 500));
    }

    return res.status(200).json({
      success: true,
      message: "Media uploaded successfully",
      data: {
        media_url: uploadResult.url,
        public_id: uploadResult.publicId,
        format: uploadResult.format,
        width: uploadResult.width,
        height: uploadResult.height,
        bytes: uploadResult.bytes,
      },
    });
  } catch (error) {
    console.error("Error uploading media:", error);
    return next(new AppError(error.message || "Failed to upload media", 500));
  }
};

// Process image with OCR to extract payment information
const processOCR = async (req, res, next) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return next(new AppError("Image URL is required", 400));
    }

    // Download image from URL
    const imageResponse = await axios({
      method: "GET",
      url: imageUrl,
      responseType: "arraybuffer",
      timeout: 30000, // 30 second timeout
    });

    const imageBuffer = Buffer.from(imageResponse.data);
    const imageBase64 = imageBuffer.toString("base64");

    // Try OCR services in priority order: PaddleOCR > Google Vision > Tesseract
    let text = "";
    
    // Option 1: PaddleOCR (if PaddleOCR service URL is configured)
    if (process.env.PADDLEOCR_SERVICE_URL) {
      try {
        const paddleUrl = process.env.PADDLEOCR_SERVICE_URL;
        const paddleResponse = await axios.post(
          `${paddleUrl}/ocr`,
          {
            imageUrl: imageUrl,
          },
          {
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
        
        // PaddleOCR service should return { text: "...", results: [...] }
        if (paddleResponse.data) {
          text = paddleResponse.data.text || paddleResponse.data.data?.text || "";
          
          // If PaddleOCR returns structured results, we can also extract structured data
          if (paddleResponse.data.results || paddleResponse.data.data?.results) {
            // PaddleOCR returns array of [bbox, text, confidence]
            const results = paddleResponse.data.results || paddleResponse.data.data.results || [];
            if (Array.isArray(results) && results.length > 0 && !text) {
              // Combine all text from results
              text = results
                .map(item => {
                  // Handle different response formats
                  if (Array.isArray(item) && item.length > 1) {
                    return item[1]; // Text is usually at index 1
                  }
                  return item.text || item[1] || "";
                })
                .filter(t => t)
                .join(" ");
            }
          }
        }
      } catch (paddleError) {
        console.error("PaddleOCR service error:", paddleError.response?.data || paddleError.message);
        // Continue to next fallback
      }
    }
    
    // Option 2: Google Cloud Vision API (if no PaddleOCR or if PaddleOCR failed)
    if (!text && process.env.GOOGLE_CLOUD_VISION_API_KEY) {
      // Use REST API with API key (recommended for simple integration)
      const visionApiUrl = `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_CLOUD_VISION_API_KEY}`;
      
      try {
        const visionResponse = await axios.post(visionApiUrl, {
          requests: [{
            image: {
              content: imageBase64,
            },
            features: [{
              type: "TEXT_DETECTION",
              maxResults: 10,
            }],
          }],
        }, {
          headers: {
            'Content-Type': 'application/json',
          },
        });
        
        if (visionResponse.data.responses && visionResponse.data.responses[0]) {
          const response = visionResponse.data.responses[0];
          if (response.fullTextAnnotation) {
            text = response.fullTextAnnotation.text || "";
          } else if (response.textAnnotations && response.textAnnotations.length > 0) {
            // First annotation contains all text
            text = response.textAnnotations[0].description || "";
          }
        }
      } catch (visionError) {
        console.error("Google Cloud Vision API error:", visionError.response?.data || visionError.message);
        // Fallback to Tesseract if Google Vision fails
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng");
        const ocrResult = await worker.recognize(imageBuffer);
        text = ocrResult.data.text;
        await worker.terminate();
      }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Use Google Cloud Vision client library with service account
      const client = new ImageAnnotatorClient({
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
      });
      
      try {
        const [result] = await client.textDetection({
          image: {
            content: imageBase64,
          },
        });
        
        if (result.fullTextAnnotation) {
          text = result.fullTextAnnotation.text || "";
        } else if (result.textAnnotations && result.textAnnotations.length > 0) {
          text = result.textAnnotations[0].description || "";
        }
      } catch (visionError) {
        console.error("Google Cloud Vision client error:", visionError);
        // Fallback to Tesseract
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng");
        const ocrResult = await worker.recognize(imageBuffer);
        text = ocrResult.data.text;
        await worker.terminate();
      }
    } else {
      // Fallback to Tesseract if no Google Cloud credentials
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      const ocrResult = await worker.recognize(imageBuffer);
      text = ocrResult.data.text;
      await worker.terminate();
    }

    // Extract information from text
    const lowerText = text.toLowerCase();
    const extractedData = {
      rawText: text,
      amount: null,
      transactionId: null,
      chequeNumber: null,
      date: null,
      bankName: null,
      type: "Receipt",
    };

    // Extract amount - improved patterns for UPI receipts
    // First, try to find amount near "paid", "₹", or "amount" keywords
    const contextPatterns = [
      /(?:paid|amount|total)[\s:]*₹?\s*([\d,]+\.?\d{2})/gi,
      /₹\s*([\d,]+\.?\d{2})/gi, // ₹90.00 format
    ];
    const contextAmounts = [];
    for (const pattern of contextPatterns) {
      const matches = [...text.matchAll(pattern)];
      for (const match of matches) {
        const amount = match[1].replace(/,/g, "");
        const numAmount = parseFloat(amount);
        if (amount && numAmount > 0 && numAmount < 1000000) {
          contextAmounts.push(numAmount);
        }
      }
    }
    
    // If no context amounts found, try generic decimal patterns
    if (contextAmounts.length === 0) {
      const decimalPattern = /(\d{1,6}\.\d{2})/g; // Numbers with 2 decimal places
      const matches = [...text.matchAll(decimalPattern)];
      for (const match of matches) {
        const amount = match[1];
        const numAmount = parseFloat(amount);
        if (numAmount > 0 && numAmount < 1000000 && numAmount % 0.01 === 0) { // Valid currency amount
          contextAmounts.push(numAmount);
        }
      }
    }
    
    // Prefer smaller amounts (transaction amounts are usually smaller than account numbers)
    // Filter out very large numbers that might be transaction IDs or dates
    const validAmounts = contextAmounts.filter(amt => amt > 0 && amt < 50000);
    
    if (validAmounts.length > 0) {
      // If multiple amounts, prefer the one that's more reasonable (usually the smaller one for transactions)
      // Or if there's only one reasonable amount, use it
      if (validAmounts.length === 1) {
        extractedData.amount = validAmounts[0].toString();
      } else {
        // For multiple amounts, prefer smaller amounts (transaction amounts vs totals)
        extractedData.amount = Math.min(...validAmounts).toString();
      }
    }

    // Extract transaction ID - improved patterns for UPI receipts
    const txnPatterns = [
      /(?:transaction\s*id|txn\s*id|id)[\s:]*(\d{12,15})/i, // 171221161822 format
      /(\d{12,15})/g, // Long numeric IDs (12-15 digits)
      /(?:transaction|txn|ref)[\s#:]*([A-Z0-9]{8,20})/i,
      /(?:upi|upi\s*ref)[\s:]*([A-Z0-9]{8,20})/i,
      /(?:ref|reference)[\s:]*([A-Z0-9]{6,20})/i,
    ];
    
    // Try structured patterns first
    for (const pattern of txnPatterns) {
      if (pattern.global) {
        const matches = [...text.matchAll(pattern)];
        for (const match of matches) {
          const id = match[1];
          // Filter out dates and amounts (they shouldn't be transaction IDs)
          if (id && !id.includes('.') && parseInt(id) > 100000000000) {
            extractedData.transactionId = id;
            break;
          }
        }
      } else {
        const match = text.match(pattern);
        if (match && match[1]) {
          extractedData.transactionId = match[1].toUpperCase();
          break;
        }
      }
      if (extractedData.transactionId) break;
    }

    // Extract cheque number
    if (lowerText.includes("cheque") || lowerText.includes("chq")) {
      extractedData.type = "Cheque";
      const chequePatterns = [
        /(?:cheque|chq|check)[\s#:]*no\.?[\s:]*(\d{6,12})/i,
        /cheque[\s#:]*(\d{6,12})/i,
      ];
      for (const pattern of chequePatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          extractedData.chequeNumber = match[1];
          break;
        }
      }
    } else {
      extractedData.type = "Digital Payment";
    }

    // Extract date - improved patterns for various formats
    const datePatterns = [
      /(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})/i, // "6th Sep 25" format
      /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/,
      /(\d{4}[-/]\d{1,2}[-/]\d{1,2})/, // YYYY-MM-DD
      /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i, // "6 Sep 2025"
    ];
    
    let dateMatch = null;
    for (const pattern of datePatterns) {
      dateMatch = text.match(pattern);
      if (dateMatch) break;
    }
    
    if (dateMatch) {
      try {
        const dateStr = dateMatch[1].trim();
        let date;
        
        // Handle "6th Sep 25" or "6 Sep 2025" format
        if (/\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(dateStr)) {
          const monthMap = {
            'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
            'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
          };
          
          const parts = dateStr.replace(/(\d+)(st|nd|rd|th)/i, '$1').split(/\s+/);
          if (parts.length >= 3) {
            const day = parseInt(parts[0]);
            const monthName = parts[1].toLowerCase().substring(0, 3);
            const yearStr = parts[2];
            
            let year = parseInt(yearStr);
            if (year < 100) {
              year = year < 50 ? 2000 + year : 1900 + year;
            }
            
            if (monthMap[monthName] !== undefined) {
              date = new Date(year, monthMap[monthName], day);
            }
          }
        } else if (dateStr.includes("/")) {
          const parts = dateStr.split("/");
          if (parts.length === 3) {
            if (parts[2].length === 4) {
              date = new Date(parts[2], parts[1] - 1, parts[0]);
              if (isNaN(date.getTime())) {
                date = new Date(parts[2], parts[0] - 1, parts[1]);
              }
            } else {
              const year = parseInt(parts[2]) < 50 ? 2000 + parseInt(parts[2]) : 1900 + parseInt(parts[2]);
              date = new Date(year, parts[1] - 1, parts[0]);
            }
          }
        } else if (dateStr.includes("-")) {
          date = new Date(dateStr);
        }
        
        if (date && !isNaN(date.getTime())) {
          extractedData.date = moment(date).format("YYYY-MM-DD");
        }
      } catch (e) {
        console.error("Date parsing error:", e);
      }
    }

    // Extract bank name - improved patterns
    const banks = [
      { pattern: /state\s*bank\s*of\s*india/i, name: "State Bank of India" },
      { pattern: /state\s*bank/i, name: "State Bank of India" },
      { pattern: /\bSBI\b/i, name: "SBI" },
      { pattern: /HDFC/i, name: "HDFC" },
      { pattern: /ICICI/i, name: "ICICI" },
      { pattern: /Axis/i, name: "Axis" },
      { pattern: /Kotak/i, name: "Kotak" },
      { pattern: /Punjab\s*National\s*Bank/i, name: "Punjab National Bank" },
      { pattern: /\bPNB\b/i, name: "PNB" },
      { pattern: /Bank\s*of\s*Baroda/i, name: "Bank of Baroda" },
      { pattern: /Canara\s*Bank/i, name: "Canara Bank" },
      { pattern: /Union\s*Bank/i, name: "Union Bank" },
      { pattern: /Indian\s*Bank/i, name: "Indian Bank" },
      { pattern: /Bank\s*of\s*India/i, name: "Bank of India" },
    ];
    for (const bank of banks) {
      if (bank.pattern.test(text)) {
        extractedData.bankName = bank.name;
        break;
      }
    }

    return res.status(200).json({
      success: true,
      message: "OCR processing completed",
      data: extractedData,
    });
  } catch (error) {
    console.error("Error processing OCR:", error);
    return next(new AppError(error.message || "OCR processing failed", 500));
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
  resetAllDealerPasswords,
  resetAllDispatchManagerPasswords,
  aboutMe,
  calculatePerformanceMetrics,
  getDealerWalletDetails,
  getDealerWalletTransactions,
  getDealerLedger,
  exportDealerWalletTransactionsCSV,
  uploadMedia,
  processOCR
};
