import mongoose from 'mongoose';
import PlantCms from '../models/plantCms.model.js';
import Product from '../models/product.model.js';
import InventoryOutward from '../models/inventoryOutward.model.js';

/**
 * Script to check why excessive sowing returns empty array
 * Run: node scripts/checkExcessiveSowingData.js
 */

const checkData = async () => {
  try {
    // Connect to MongoDB
    const dbUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';
    await mongoose.connect(dbUri);
    console.log('✅ Connected to MongoDB\n');

    let issues = [];
    let fixes = [];

    // Step 1: Check Plants
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('STEP 1: Checking Plants');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const totalPlants = await PlantCms.countDocuments({ isActive: true });
    const plantsWithSowing = await PlantCms.countDocuments({ 
      isActive: true,
      sowingAllowed: true 
    });

    console.log(`Total active plants: ${totalPlants}`);
    console.log(`Plants with sowingAllowed=true: ${plantsWithSowing}`);

    if (plantsWithSowing === 0) {
      console.log('❌ ISSUE: No plants have sowingAllowed enabled');
      issues.push('No plants with sowingAllowed=true');
      fixes.push(`db.plantcms.updateMany({ isActive: true }, { $set: { sowingAllowed: true }})`);
      
      // Show sample plants
      const samplePlants = await PlantCms.find({ isActive: true })
        .select('plantName sowingAllowed')
        .limit(5)
        .lean();
      console.log('\nSample plants:');
      samplePlants.forEach(p => {
        console.log(`  - ${p.plantName}: sowingAllowed=${p.sowingAllowed || false}`);
      });
    } else {
      console.log('✅ GOOD: Plants with sowing allowed found');
      
      // Show sample
      const samplePlant = await PlantCms.findOne({ 
        isActive: true,
        sowingAllowed: true 
      }).select('plantName subtypes').lean();
      
      if (samplePlant) {
        const activeSubtypes = samplePlant.subtypes?.filter(st => st.isActive).length || 0;
        console.log(`\nSample: ${samplePlant.plantName}`);
        console.log(`  - Total subtypes: ${samplePlant.subtypes?.length || 0}`);
        console.log(`  - Active subtypes: ${activeSubtypes}`);
      }
    }

    // Step 2: Check Products
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('STEP 2: Checking Products');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const totalProducts = await Product.countDocuments({ 'status.isActive': true });
    const productionProducts = await Product.countDocuments({
      'status.isActive': true,
      purpose: 'production'
    });

    console.log(`Total active products: ${totalProducts}`);
    console.log(`Products with purpose='production': ${productionProducts}`);

    if (productionProducts === 0) {
      console.log('❌ ISSUE: No products have purpose="production"');
      issues.push('No products with purpose="production"');
      
      // Show purposes being used
      const allProducts = await Product.find({ 'status.isActive': true })
        .select('productName purpose')
        .lean();
      const purposes = [...new Set(allProducts.map(p => p.purpose))];
      console.log('\nCurrent purposes in use:', purposes);
      console.log('\nSample products:');
      allProducts.slice(0, 5).forEach(p => {
        console.log(`  - ${p.productName}: purpose="${p.purpose}"`);
      });
      
      // Suggest fix based on product names
      const likelySeedProducts = allProducts.filter(p => 
        p.productName.toLowerCase().includes('seed') ||
        p.productName.includes('बीज')
      );
      
      if (likelySeedProducts.length > 0) {
        console.log(`\nFound ${likelySeedProducts.length} products that look like seeds (contain "seed" or "बीज")`);
        fixes.push(`db.products.updateMany({ productName: { $regex: /seed|बीज/i }, 'status.isActive': true }, { $set: { purpose: 'production' }})`);
      } else {
        fixes.push(`db.products.updateMany({ 'status.isActive': true }, { $set: { purpose: 'production' }})`);
      }
    } else {
      console.log('✅ GOOD: Products with purpose="production" found');
      
      // Show sample
      const sampleProduct = await Product.findOne({
        'status.isActive': true,
        purpose: 'production'
      }).select('productName plantId plantSubtypeInfo').lean();
      
      if (sampleProduct) {
        console.log(`\nSample: ${sampleProduct.productName}`);
        console.log(`  - Has plantId: ${!!sampleProduct.plantId}`);
        console.log(`  - plantSubtypeInfo entries: ${sampleProduct.plantSubtypeInfo?.length || 0}`);
        
        if (sampleProduct.plantSubtypeInfo && sampleProduct.plantSubtypeInfo.length > 0) {
          const withConversion = sampleProduct.plantSubtypeInfo.filter(info => info.conversionFactor > 0);
          console.log(`  - With conversion factor: ${withConversion.length}`);
        }
      }
    }

    // Step 3: Check Inventory Outwards
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('STEP 3: Checking Inventory Outwards');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const totalOutwards = await InventoryOutward.countDocuments();
    const productionOutwards = await InventoryOutward.countDocuments({
      purpose: 'production'
    });
    const outwardsWithAvailable = await InventoryOutward.countDocuments({
      purpose: 'production',
      'items.availableQuantity': { $gt: 0 }
    });

    console.log(`Total outward entries: ${totalOutwards}`);
    console.log(`Outwards with purpose='production': ${productionOutwards}`);
    console.log(`Outwards with available quantity: ${outwardsWithAvailable}`);

    if (outwardsWithAvailable === 0) {
      console.log('⚠️  WARNING: No outward entries with available quantity');
      console.log('This means excessive sowing will show plants but availablePackets=0');
      issues.push('No inventory outward entries with available quantity');
      fixes.push('Create inventory outward entries with purpose="production" for seed products');
      
      if (productionOutwards > 0) {
        // Check if they have items but no available quantity
        const outwardSample = await InventoryOutward.findOne({ purpose: 'production' })
          .select('items')
          .lean();
        
        if (outwardSample && outwardSample.items.length > 0) {
          const totalQty = outwardSample.items.reduce((sum, i) => sum + (i.quantity || 0), 0);
          const availableQty = outwardSample.items.reduce((sum, i) => sum + (i.availableQuantity || 0), 0);
          console.log('\nSample outward entry:');
          console.log(`  - Total items: ${outwardSample.items.length}`);
          console.log(`  - Total quantity: ${totalQty}`);
          console.log(`  - Available quantity: ${availableQty}`);
          
          if (availableQty === 0 && totalQty > 0) {
            console.log('  ⚠️  All stock has been used. Create new outward entries.');
          }
        }
      }
    } else {
      console.log('✅ GOOD: Inventory outwards with available stock found');
    }

    // Summary
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    if (issues.length === 0) {
      console.log('✅ All checks passed! API should return data.');
      console.log('\nIf still getting empty array, check:');
      console.log('  1. Server logs for detailed debug messages');
      console.log('  2. Product plantSubtypeInfo has matching subtypeIds');
      console.log('  3. Conversion factors are set in plantSubtypeInfo');
    } else {
      console.log(`❌ Found ${issues.length} issue(s):\n`);
      issues.forEach((issue, idx) => {
        console.log(`${idx + 1}. ${issue}`);
      });
      
      console.log('\n🔧 FIXES TO RUN:\n');
      fixes.forEach((fix, idx) => {
        console.log(`${idx + 1}. ${fix}\n`);
      });
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('Error running check:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Disconnected from MongoDB');
  }
};

checkData();



