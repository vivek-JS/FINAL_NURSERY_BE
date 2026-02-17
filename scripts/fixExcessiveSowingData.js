import mongoose from 'mongoose';
import PlantCms from '../models/plantCms.model.js';
import Product from '../models/product.model.js';

/**
 * Script to fix excessive sowing data
 * Enables sowingAllowed for all plants and sets purpose='production' for seed products
 */

async function fixData() {
  try {
    // Connect to MongoDB
    const dbUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/nursery';
    await mongoose.connect(dbUri);
    console.log('✅ Connected to MongoDB\n');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('FIX 1: Enable Sowing for All Plants');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Get plants before
    const plantsBefore = await PlantCms.find({}).select('name sowingAllowed').lean();
    console.log('\nPlants before fix:');
    plantsBefore.forEach(p => {
      console.log(`  - ${p.name}: sowingAllowed=${p.sowingAllowed || false}`);
    });

    // Enable sowing for all plants
    const plantResult = await PlantCms.updateMany(
      {},
      { $set: { sowingAllowed: true }}
    );

    console.log(`\n✅ Updated ${plantResult.modifiedCount} plants`);

    // Verify
    const plantsAfter = await PlantCms.find({}).select('name sowingAllowed').lean();
    console.log('\nPlants after fix:');
    plantsAfter.forEach(p => {
      console.log(`  - ${p.name}: sowingAllowed=${p.sowingAllowed}`);
    });

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('FIX 2: Set Purpose for Products');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Get products before
    const productsBefore = await Product.find({}).select('name purpose plantId category').lean();
    console.log('\nProducts before fix:');
    productsBefore.forEach(p => {
      console.log(`  - ${p.name}: purpose="${p.purpose || 'none'}", category="${p.category}", hasPlantId=${!!p.plantId}`);
    });

    // Check which products should be set to production
    // Option 1: Products with plantId (seed products)
    const productsWithPlantId = await Product.find({ plantId: { $exists: true, $ne: null }}).countDocuments();
    console.log(`\n📊 Products with plantId: ${productsWithPlantId}`);

    // Option 2: Products in "seeds" or "बीज" category
    const seedProducts = await Product.find({
      $or: [
        { category: { $regex: /seed/i }},
        { category: { $regex: /बीज/}},
        { name: { $regex: /seed/i }},
        { name: { $regex: /बीज/}}
      ]
    }).countDocuments();
    console.log(`📊 Products with "seed" or "बीज" in name/category: ${seedProducts}`);

    // Ask user which strategy to use (for now, we'll use products with plantId)
    console.log('\n🔧 Setting purpose="production" for products with plantId...');
    
    const productResult = await Product.updateMany(
      { plantId: { $exists: true, $ne: null }},
      { $set: { purpose: 'production' }}
    );

    console.log(`✅ Updated ${productResult.modifiedCount} products`);

    // If no products were updated with plantId, try by category
    if (productResult.modifiedCount === 0) {
      console.log('\n⚠️  No products with plantId found. Trying by category/name pattern...');
      
      const alternativeResult = await Product.updateMany(
        {
          $or: [
            { category: { $regex: /seed/i }},
            { category: { $regex: /बीज/}},
            { name: { $regex: /seed/i }},
            { name: { $regex: /बीज/}}
          ]
        },
        { $set: { purpose: 'production' }}
      );

      console.log(`✅ Updated ${alternativeResult.modifiedCount} products by category/name pattern`);
    }

    // Verify
    const productsAfter = await Product.find({}).select('name purpose plantId').lean();
    console.log('\nProducts after fix:');
    productsAfter.forEach(p => {
      console.log(`  - ${p.name}: purpose="${p.purpose || 'none'}", hasPlantId=${!!p.plantId}`);
    });

    const productionCount = await Product.countDocuments({ purpose: 'production' });
    console.log(`\n📊 Total products with purpose="production": ${productionCount}`);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const plantsWithSowing = await PlantCms.countDocuments({ sowingAllowed: true });
    const productsWithProduction = await Product.countDocuments({ purpose: 'production' });

    console.log(`\n✅ Plants with sowingAllowed=true: ${plantsWithSowing}`);
    console.log(`✅ Products with purpose="production": ${productsWithProduction}`);

    if (plantsWithSowing > 0 && productsWithProduction > 0) {
      console.log('\n🎉 SUCCESS! Your excessive sowing API should now return data!');
      console.log('\nTest with:');
      console.log('  curl http://localhost:8000/api/v1/sowing/excessive/available-plants \\');
      console.log('    -H "Authorization: Bearer YOUR_TOKEN"');
    } else {
      console.log('\n⚠️  WARNING: Some fixes may not have worked.');
      console.log('\nYou may need to:');
      if (plantsWithSowing === 0) {
        console.log('  1. Manually enable "Sowing Allowed" in Plant CMS UI');
      }
      if (productsWithProduction === 0) {
        console.log('  2. Manually set purpose="production" for seed products in Products UI');
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('❌ Error fixing data:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Disconnected from MongoDB');
  }
}

// Check if running directly
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (process.argv[1] === __filename) {
  fixData();
}

export default fixData;







