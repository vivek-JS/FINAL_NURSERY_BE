import dotenv from "dotenv";
import mongoose from "mongoose";
import { InventoryProduct } from "./models/inventory.model.js";

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

const createAgriSalesProducts = async () => {
  try {
    await connectDB();

    console.log("\n🌾 Creating Ram Agri Sales Products...\n");

    const agriSalesProducts = [
      {
        name: "Urea Fertilizer",
        description: "High-quality urea fertilizer for agricultural use",
        category: "Fertilizers",
        unit: "kg",
        minStockLevel: 100,
        maxStockLevel: 5000,
        currentStock: 1000,
        costPrice: 35,
        sellingPrice: 45,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["fertilizer", "urea", "agriculture"],
      },
      {
        name: "NPK 19:19:19",
        description: "Balanced NPK fertilizer for all crops",
        category: "Fertilizers",
        unit: "kg",
        minStockLevel: 50,
        maxStockLevel: 3000,
        currentStock: 500,
        costPrice: 120,
        sellingPrice: 150,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["fertilizer", "npk", "balanced"],
      },
      {
        name: "DAP Fertilizer",
        description: "Diammonium Phosphate fertilizer",
        category: "Fertilizers",
        unit: "kg",
        minStockLevel: 80,
        maxStockLevel: 4000,
        currentStock: 800,
        costPrice: 55,
        sellingPrice: 70,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["fertilizer", "dap", "phosphate"],
      },
      {
        name: "Neem Oil Pesticide",
        description: "Organic neem oil pesticide - 100% natural",
        category: "Chemicals",
        unit: "l",
        minStockLevel: 20,
        maxStockLevel: 500,
        currentStock: 100,
        costPrice: 280,
        sellingPrice: 350,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["pesticide", "neem", "organic"],
      },
      {
        name: "Tomato Seeds - Hybrid",
        description: "High yield hybrid tomato seeds - Premium quality",
        category: "Seeds",
        unit: "packets",
        minStockLevel: 50,
        maxStockLevel: 1000,
        currentStock: 200,
        costPrice: 120,
        sellingPrice: 150,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["seeds", "tomato", "hybrid"],
      },
      {
        name: "Potting Soil - Premium",
        description: "Premium quality potting soil with nutrients",
        category: "Soil",
        unit: "bags",
        minStockLevel: 30,
        maxStockLevel: 500,
        currentStock: 150,
        costPrice: 200,
        sellingPrice: 250,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["soil", "potting", "premium"],
      },
      {
        name: "Cucumber Seeds",
        description: "High quality cucumber seeds for farming",
        category: "Seeds",
        unit: "packets",
        minStockLevel: 40,
        maxStockLevel: 800,
        currentStock: 180,
        costPrice: 100,
        sellingPrice: 130,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["seeds", "cucumber"],
      },
      {
        name: "Organic Compost",
        description: "Rich organic compost for better crop yield",
        category: "Soil",
        unit: "bags",
        minStockLevel: 25,
        maxStockLevel: 400,
        currentStock: 120,
        costPrice: 150,
        sellingPrice: 200,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["compost", "organic", "soil"],
      },
      {
        name: "Insecticide - Cypermethrin",
        description: "Effective insecticide for pest control",
        category: "Chemicals",
        unit: "ml",
        minStockLevel: 50,
        maxStockLevel: 1000,
        currentStock: 300,
        costPrice: 450,
        sellingPrice: 550,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["insecticide", "pest-control", "chemical"],
      },
      {
        name: "Grow Bags - 12x12",
        description: "Grow bags for container gardening",
        category: "Pots",
        unit: "pieces",
        minStockLevel: 100,
        maxStockLevel: 2000,
        currentStock: 500,
        costPrice: 25,
        sellingPrice: 35,
        supplier: {
          name: "Ram Biotek",
          contact: "+919876543210",
          email: "supplier@rambiotek.com",
        },
        isActive: true,
        isAgriSales: true,
        tags: ["grow-bags", "containers", "pots"],
      },
    ];

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const productData of agriSalesProducts) {
      // Check if product already exists
      const existingProduct = await InventoryProduct.findOne({
        name: productData.name,
        category: productData.category,
      });

      if (existingProduct) {
        // Update existing product to enable isAgriSales
        if (!existingProduct.isAgriSales) {
          existingProduct.isAgriSales = true;
          existingProduct.isActive = true;
          // Update stock if current stock is 0
          if (existingProduct.currentStock === 0) {
            existingProduct.currentStock = productData.currentStock;
          }
          await existingProduct.save();
          console.log(`✅ Updated: ${productData.name} (enabled for Agri Sales)`);
          updatedCount++;
        } else {
          console.log(`⏭️  Skipped: ${productData.name} (already enabled for Agri Sales)`);
          skippedCount++;
        }
      } else {
        // Create new product
        const product = await InventoryProduct.create(productData);
        console.log(`✅ Created: ${product.name} - Stock: ${product.currentStock} ${product.unit} - Price: ₹${product.sellingPrice}/${product.unit}`);
        createdCount++;
      }
    }

    console.log("\n📊 Summary:");
    console.log(`   ✅ Created: ${createdCount} products`);
    console.log(`   🔄 Updated: ${updatedCount} products`);
    console.log(`   ⏭️  Skipped: ${skippedCount} products`);
    console.log(`   📦 Total: ${createdCount + updatedCount + skippedCount} products\n`);

    // Show all Agri Sales products
    const allAgriSalesProducts = await InventoryProduct.find({ isAgriSales: true, isActive: true });
    console.log(`🌾 Total Agri Sales Products Available: ${allAgriSalesProducts.length}`);
    console.log("\n📋 Product List:");
    allAgriSalesProducts.forEach((product, index) => {
      console.log(
        `   ${index + 1}. ${product.name} (${product.category}) - Stock: ${product.currentStock} ${product.unit} - ₹${product.sellingPrice}/${product.unit}`
      );
    });

    console.log("\n✅ Done! Products are ready for Ram Agri Sales orders.\n");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating products:", error);
    process.exit(1);
  }
};

createAgriSalesProducts();


