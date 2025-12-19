import express from "express";
import Order from "../models/order.model.js";
import DealerOrder from "../models/dealerOrder.model.js";
import PlantSlot from "../models/slots.model.js";
import User from "../models/user.model.js";
import Employee from "../models/employee.model.js";
import Farmer from "../models/farmer.model.js";
import Dispatch from "../models/dispatch.model.js";
import DealerBooking from "../models/dealerBooking.model.js";
import DealerWallet from "../models/dealerWallet.js";
import Sowing from "../models/sowing.model.js";
import Attendance from "../models/attendance.model.js";
import Lab from "../models/lab.model.js";
import Log from "../models/log.model.js";
import PlantOutward from "../models/plantOutward.model.js";
import InventoryTransaction from "../models/inventoryTransaction.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import Product from "../models/product.model.js";
import Batch from "../models/batch.model.js";
import SowingRequest from "../models/sowingRequest.model.js";
import ReturnRequest from "../models/returnRequest.model.js";

const router = express.Router();

/**
 * Clear All Data - WARNING: This is a destructive operation
 * Deletes all orders, slots, dealers, employees, farmers, and related data
 */
router.delete("/clear-all", async (req, res) => {
  try {
    console.log("Starting complete data deletion...");

    const deletionResults = {
      orders: 0,
      dealerOrders: 0,
      slots: 0,
      dispatches: 0,
      dealerBookings: 0,
      dealerWallets: 0,
      dealers: 0,
      farmers: 0,
      employees: 0,
      sowings: 0,
      sowingRequests: 0,
      returnRequests: 0,
      attendance: 0,
      labs: 0,
      logs: 0,
      plantOutward: 0,
      inventoryTransactions: 0,
      inventoryOutward: 0,
      batches: 0,
      products: 0,
    };

    // Step 1: Delete all dispatches first (referenced by orders)
    console.log("Deleting dispatches...");
    const dispatchResult = await Dispatch.deleteMany({});
    deletionResults.dispatches = dispatchResult.deletedCount;
    console.log(`Deleted ${dispatchResult.deletedCount} dispatches`);

    // Step 2: Delete all orders
    console.log("Deleting orders...");
    const ordersResult = await Order.deleteMany({});
    deletionResults.orders = ordersResult.deletedCount;
    console.log(`Deleted ${ordersResult.deletedCount} orders`);

    // Step 3: Delete dealer orders
    console.log("Deleting dealer orders...");
    const dealerOrdersResult = await DealerOrder.deleteMany({});
    deletionResults.dealerOrders = dealerOrdersResult.deletedCount;
    console.log(`Deleted ${dealerOrdersResult.deletedCount} dealer orders`);

    // Step 4: Delete dealer bookings
    console.log("Deleting dealer bookings...");
    const dealerBookingsResult = await DealerBooking.deleteMany({});
    deletionResults.dealerBookings = dealerBookingsResult.deletedCount;
    console.log(`Deleted ${dealerBookingsResult.deletedCount} dealer bookings`);

    // Step 5: Delete dealer wallets
    console.log("Deleting dealer wallets...");
    const dealerWalletsResult = await DealerWallet.deleteMany({});
    deletionResults.dealerWallets = dealerWalletsResult.deletedCount;
    console.log(`Deleted ${dealerWalletsResult.deletedCount} dealer wallets`);

    // Step 6: Delete all slots
    console.log("Deleting slots...");
    const slotsResult = await PlantSlot.deleteMany({});
    deletionResults.slots = slotsResult.deletedCount;
    console.log(`Deleted ${slotsResult.deletedCount} slots`);

    // Step 7: Delete plant outward records
    console.log("Deleting plant outward records...");
    const plantOutwardResult = await PlantOutward.deleteMany({});
    deletionResults.plantOutward = plantOutwardResult.deletedCount;
    console.log(`Deleted ${plantOutwardResult.deletedCount} plant outward records`);

    // Step 8: Delete sowing records
    console.log("Deleting sowing records...");
    const sowingResult = await Sowing.deleteMany({});
    deletionResults.sowings = sowingResult.deletedCount;
    console.log(`Deleted ${sowingResult.deletedCount} sowing records`);

    // Step 9: Delete attendance records
    console.log("Deleting attendance records...");
    const attendanceResult = await Attendance.deleteMany({});
    deletionResults.attendance = attendanceResult.deletedCount;
    console.log(`Deleted ${attendanceResult.deletedCount} attendance records`);

    // Step 10: Delete lab records
    console.log("Deleting lab records...");
    const labResult = await Lab.deleteMany({});
    deletionResults.labs = labResult.deletedCount;
    console.log(`Deleted ${labResult.deletedCount} lab records`);

    // Step 11: Delete log records
    console.log("Deleting log records...");
    const logResult = await Log.deleteMany({});
    deletionResults.logs = logResult.deletedCount;
    console.log(`Deleted ${logResult.deletedCount} log records`);

    // Step 12: Delete inventory transactions
    console.log("Deleting inventory transactions...");
    const inventoryTransactionResult = await InventoryTransaction.deleteMany({});
    deletionResults.inventoryTransactions = inventoryTransactionResult.deletedCount;
    console.log(`Deleted ${inventoryTransactionResult.deletedCount} inventory transactions`);

    // Step 13: Delete inventory outward records
    console.log("Deleting inventory outward records...");
    const inventoryOutwardResult = await InventoryOutward.deleteMany({});
    deletionResults.inventoryOutward = inventoryOutwardResult.deletedCount;
    console.log(`Deleted ${inventoryOutwardResult.deletedCount} inventory outward records`);

    // Step 13.5: Delete batches
    console.log("Deleting batches...");
    const batchResult = await Batch.deleteMany({});
    deletionResults.batches = batchResult.deletedCount;
    console.log(`Deleted ${batchResult.deletedCount} batches`);

    // Step 13.6: Delete products
    console.log("Deleting products...");
    const productResult = await Product.deleteMany({});
    deletionResults.products = productResult.deletedCount;
    console.log(`Deleted ${productResult.deletedCount} products`);

    // Step 13.7: Delete sowing requests
    console.log("Deleting sowing requests...");
    const sowingRequestResult = await SowingRequest.deleteMany({});
    deletionResults.sowingRequests = sowingRequestResult.deletedCount;
    console.log(`Deleted ${sowingRequestResult.deletedCount} sowing requests`);

    // Step 13.8: Delete return requests
    console.log("Deleting return requests...");
    const returnRequestResult = await ReturnRequest.deleteMany({});
    deletionResults.returnRequests = returnRequestResult.deletedCount;
    console.log(`Deleted ${returnRequestResult.deletedCount} return requests`);

    // Step 14: Delete dealers (Users with dealer role)
    console.log("Deleting dealers...");
    const dealersResult = await User.deleteMany({ role: "DEALER" });
    deletionResults.dealers = dealersResult.deletedCount;
    console.log(`Deleted ${dealersResult.deletedCount} dealers`);

    // Step 15: Delete farmers
    console.log("Deleting farmers...");
    const farmersResult = await Farmer.deleteMany({});
    deletionResults.farmers = farmersResult.deletedCount;
    console.log(`Deleted ${farmersResult.deletedCount} farmers`);

    // Step 16: Delete employees
    console.log("Deleting employees...");
    const employeesResult = await Employee.deleteMany({});
    deletionResults.employees = employeesResult.deletedCount;
    console.log(`Deleted ${employeesResult.deletedCount} employees`);

    // Step 17: Delete all other users except SUPER_ADMIN
    console.log("Deleting non-admin users...");
    const usersResult = await User.deleteMany({ role: { $ne: "SUPER_ADMIN" } });
    console.log(`Deleted ${usersResult.deletedCount} non-admin users`);

    console.log("✅ Data deletion completed successfully!");
    console.log("Summary:", deletionResults);

    res.status(200).json({
      success: true,
      message: "All data deleted successfully",
      summary: deletionResults,
    });
  } catch (error) {
    console.error("Error deleting data:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting data",
      error: error.message,
    });
  }
});

/**
 * Clear only orders and related data (keeps users, employees, farmers, slots)
 */
router.delete("/clear-orders-only", async (req, res) => {
  try {
    console.log("Starting order deletion only...");

    const deletionResults = {
      orders: 0,
      dealerOrders: 0,
      dispatches: 0,
      dealerBookings: 0,
      dealerWallets: 0,
    };

    // Delete dispatches
    const dispatchResult = await Dispatch.deleteMany({});
    deletionResults.dispatches = dispatchResult.deletedCount;

    // Delete orders
    const ordersResult = await Order.deleteMany({});
    deletionResults.orders = ordersResult.deletedCount;

    // Delete dealer orders
    const dealerOrdersResult = await DealerOrder.deleteMany({});
    deletionResults.dealerOrders = dealerOrdersResult.deletedCount;

    // Delete dealer bookings
    const dealerBookingsResult = await DealerBooking.deleteMany({});
    deletionResults.dealerBookings = dealerBookingsResult.deletedCount;

    // Delete dealer wallets
    const dealerWalletsResult = await DealerWallet.deleteMany({});
    deletionResults.dealerWallets = dealerWalletsResult.deletedCount;

    console.log("✅ Order deletion completed!");
    res.status(200).json({
      success: true,
      message: "Orders deleted successfully",
      summary: deletionResults,
    });
  } catch (error) {
    console.error("Error deleting orders:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting orders",
      error: error.message,
    });
  }
});

/**
 * Clear slots only
 */
router.delete("/clear-slots-only", async (req, res) => {
  try {
    console.log("Deleting slots...");
    const result = await PlantSlot.deleteMany({});
    
    res.status(200).json({
      success: true,
      message: `Deleted ${result.deletedCount} slots successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting slots:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting slots",
      error: error.message,
    });
  }
});

/**
 * Clear dealers only (keeps other data)
 */
router.delete("/clear-dealers-only", async (req, res) => {
  try {
    console.log("Deleting dealers...");
    
    // Delete dealer orders first
    await DealerOrder.deleteMany({});
    
    // Delete dealer bookings
    await DealerBooking.deleteMany({});
    
    // Delete dealer wallets
    await DealerWallet.deleteMany({});
    
    // Delete dealers (users with dealer role)
    const result = await User.deleteMany({ role: "DEALER" });
    
    res.status(200).json({
      success: true,
      message: `Deleted ${result.deletedCount} dealers successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting dealers:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting dealers",
      error: error.message,
    });
  }
});

/**
 * Clear inventory only (batches + outwards + transactions)
 */
router.delete("/clear-inventory-only", async (req, res) => {
  try {
    console.log("Deleting inventory...");
    
    const deletionResults = {
      batches: 0,
      inventoryOutward: 0,
      inventoryTransactions: 0,
    };
    
    // Delete batches
    const batchResult = await Batch.deleteMany({});
    deletionResults.batches = batchResult.deletedCount;
    
    // Delete inventory outward
    const outwardResult = await InventoryOutward.deleteMany({});
    deletionResults.inventoryOutward = outwardResult.deletedCount;
    
    // Delete inventory transactions
    const transactionResult = await InventoryTransaction.deleteMany({});
    deletionResults.inventoryTransactions = transactionResult.deletedCount;
    
    res.status(200).json({
      success: true,
      message: "Inventory deleted successfully",
      summary: deletionResults,
      totalDeleted: Object.values(deletionResults).reduce((sum, count) => sum + count, 0),
    });
  } catch (error) {
    console.error("Error deleting inventory:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting inventory",
      error: error.message,
    });
  }
});

/**
 * Clear products only
 */
router.delete("/clear-products-only", async (req, res) => {
  try {
    console.log("Deleting products...");
    const result = await Product.deleteMany({});
    
    res.status(200).json({
      success: true,
      message: `Deleted ${result.deletedCount} products successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting products:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting products",
      error: error.message,
    });
  }
});

export default router;





