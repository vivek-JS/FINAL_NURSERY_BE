import dotenv from "dotenv";
import mongoose from "mongoose";
import AgriSalesOrder from "./models/agriSalesOrder.model.js";
import { InventoryProduct } from "./models/inventory.model.js";
import Farmer from "./models/farmer.model.js";
import User from "./models/user.model.js";

dotenv.config();

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }
    await mongoose.connect(uri);
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }
};

const create150AgriSalesOrders = async () => {
  try {
    await connectDB();

    console.log("\n🌾 Creating 150 Ram Agri Sales Orders...\n");

    // Fetch data from database
    console.log("📊 Fetching data from database...");

    // Fetch farmers with valid location info
    const farmers = await Farmer.find({
      village: { $exists: true, $ne: null },
      taluka: { $exists: true, $ne: null },
      district: { $exists: true, $ne: null },
      mobileNumber: { $exists: true, $ne: null },
    }).limit(150);

    if (farmers.length === 0) {
      console.error("❌ No farmers found with valid location and mobile number");
      process.exit(1);
    }

    console.log(`✅ Found ${farmers.length} farmers`);

    // Fetch salesmen/users with role SALES or jobTitle SALES
    const salesmen = await User.find({
      $or: [
        { role: "SALES" },
        { jobTitle: "SALES" },
        { role: "ADMIN" },
        { jobTitle: "OFFICE_ADMIN" },
      ],
      isDisabled: { $ne: true },
    }).limit(20);

    if (salesmen.length === 0) {
      console.error("❌ No salesmen/users found. Please create at least one user with role SALES or ADMIN");
      process.exit(1);
    }

    console.log(`✅ Found ${salesmen.length} salesmen/users`);

    // Fetch Agri Sales products
    const products = await InventoryProduct.find({
      isAgriSales: true,
      isActive: true,
    }).limit(20);

    if (products.length === 0) {
      console.error("❌ No Agri Sales products found. Please run create-agri-sales-products.js first");
      process.exit(1);
    }

    console.log(`✅ Found ${products.length} Agri Sales products`);

    // Payment modes
    const paymentModes = ["Cash", "UPI", "Cheque", "NEFT/RTGS", "Wallet"];
    const orderStatuses = ["PENDING", "ACCEPTED", "COMPLETED"];
    const paymentStatuses = ["COLLECTED", "PENDING", "REJECTED"];

    console.log("\n🚀 Creating 150 orders...\n");

    let createdCount = 0;
    let errorCount = 0;

    // Create 150 orders
    for (let i = 0; i < 150; i++) {
      try {
        // Random farmer
        const farmer = farmers[Math.floor(Math.random() * farmers.length)];

        // Random salesman
        const salesman = salesmen[Math.floor(Math.random() * salesmen.length)];

        // Random product
        const product = products[Math.floor(Math.random() * products.length)];

        // Random quantity based on product unit
        let quantity;
        let rate;
        const unit = product.unit || "kg";

        if (unit === "kg") {
          quantity = Math.floor(Math.random() * 500) + 10; // 10-510 kg
          rate = Math.floor(Math.random() * 100) + 30; // 30-130 per kg
        } else if (unit === "packets" || unit === "bags") {
          quantity = Math.floor(Math.random() * 50) + 1; // 1-51 packets/bags
          rate = Math.floor(Math.random() * 500) + 100; // 100-600 per packet/bag
        } else if (unit === "l" || unit === "ml") {
          quantity = unit === "l" ? Math.floor(Math.random() * 100) + 1 : Math.floor(Math.random() * 1000) + 10;
          rate = Math.floor(Math.random() * 200) + 50; // 50-250 per liter/ml
        } else {
          quantity = Math.floor(Math.random() * 100) + 1; // 1-101 pieces
          rate = Math.floor(Math.random() * 300) + 50; // 50-350 per piece
        }

        const totalAmount = quantity * rate;

        // Random order date (last 60 days)
        const orderDate = new Date();
        orderDate.setDate(orderDate.getDate() - Math.floor(Math.random() * 60));

        // Random order status
        const orderStatus = orderStatuses[Math.floor(Math.random() * orderStatuses.length)];

        // Create payments (70% of orders have payments)
        const payments = [];
        const hasPayment = Math.random() < 0.7;

        if (hasPayment) {
          const numPayments = Math.floor(Math.random() * 3) + 1; // 1-3 payments
          let totalPaid = 0;

          for (let j = 0; j < numPayments; j++) {
            const paymentAmount = Math.floor(Math.random() * (totalAmount - totalPaid)) + 1;
            const paymentStatus = paymentStatuses[Math.floor(Math.random() * paymentStatuses.length)];
            const modeOfPayment = paymentModes[Math.floor(Math.random() * paymentModes.length)];

            const paymentDate = new Date(orderDate);
            paymentDate.setDate(paymentDate.getDate() + Math.floor(Math.random() * 30));

            payments.push({
              paidAmount: paymentStatus === "REJECTED" ? 0 : paymentAmount,
              paymentStatus: paymentStatus,
              paymentDate: paymentDate,
              modeOfPayment: modeOfPayment,
              bankName: modeOfPayment === "Cheque" || modeOfPayment === "NEFT/RTGS" ? "Bank of India" : "",
              remark: `Payment ${j + 1} for order`,
              isWalletPayment: modeOfPayment === "Wallet",
            });

            if (paymentStatus === "COLLECTED") {
              totalPaid += paymentAmount;
            }
          }
        }

        // Calculate payment status
        const collectedPayments = payments.filter((p) => p.paymentStatus === "COLLECTED");
        const totalPaidAmount = collectedPayments.reduce((sum, p) => sum + p.paidAmount, 0);
        const balanceAmount = totalAmount - totalPaidAmount;

        let paymentStatus = "PENDING";
        if (balanceAmount <= 0) {
          paymentStatus = "COMPLETED";
        } else if (totalPaidAmount > 0) {
          paymentStatus = "PARTIAL";
        }

        // Create order
        const order = new AgriSalesOrder({
          customerName: farmer.name,
          customerMobile: farmer.mobileNumber?.toString() || `9999999${String(i).padStart(3, "0")}`,
          customerVillage: farmer.village || `Village_${i}`,
          customerTaluka: farmer.talukaName || farmer.taluka || `Taluka_${i}`,
          customerDistrict: farmer.districtName || farmer.district || `District_${i}`,
          customerState: farmer.stateName || farmer.state || "Maharashtra",
          productId: product._id,
          productName: product.name,
          quantity: quantity,
          unit: unit,
          rate: rate,
          totalAmount: totalAmount,
          orderStatus: orderStatus,
          payment: payments,
          paymentStatus: paymentStatus,
          totalPaidAmount: totalPaidAmount,
          balanceAmount: balanceAmount,
          orderDate: orderDate,
          createdBy: salesman._id,
          stockDeducted: orderStatus === "ACCEPTED" || orderStatus === "COMPLETED",
          stockDeductedAt:
            orderStatus === "ACCEPTED" || orderStatus === "COMPLETED" ? orderDate : undefined,
        });

        await order.save();
        createdCount++;

        if (createdCount % 25 === 0) {
          console.log(`✅ Created ${createdCount}/150 orders...`);
        }
      } catch (error) {
        console.error(`❌ Error creating order ${i + 1}:`, error.message);
        errorCount++;
      }
    }

    console.log("\n📊 Summary:");
    console.log(`   ✅ Created: ${createdCount} orders`);
    console.log(`   ❌ Errors: ${errorCount} orders`);
    console.log(`   📦 Total: ${createdCount} orders\n`);

    // Show statistics
    const stats = await AgriSalesOrder.aggregate([
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalAmount: { $sum: "$totalAmount" },
          totalPaid: { $sum: "$totalPaidAmount" },
          totalBalance: { $sum: "$balanceAmount" },
        },
      },
    ]);

    if (stats.length > 0) {
      const stat = stats[0];
      console.log("📈 Statistics:");
      console.log(`   Total Orders: ${stat.totalOrders}`);
      console.log(`   Total Amount: ₹${stat.totalAmount.toLocaleString()}`);
      console.log(`   Total Paid: ₹${stat.totalPaid.toLocaleString()}`);
      console.log(`   Total Balance: ₹${stat.totalBalance.toLocaleString()}`);
    }

    console.log("\n✅ Done! 150 Agri Sales orders created successfully.\n");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating orders:", error);
    process.exit(1);
  }
};

create150AgriSalesOrders();

