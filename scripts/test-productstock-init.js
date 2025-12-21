import dotenv from 'dotenv';
import mongoose from 'mongoose';
import PurchaseOrder from '../models/purchaseOrder.model.js';
import PlantSlot from '../models/slots.model.js';
import Product from '../models/product.model.js';

dotenv.config();

const poId = process.argv[2] || '6946ebf157dce8d87e7e9d02';

async function testProductStockInit() {
  try {
    const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!mongoUrl) {
      console.error('❌ MONGO_URL not found');
      process.exit(1);
    }

    await mongoose.connect(mongoUrl);
    console.log('✅ Connected to MongoDB\n');

    // Find the PO
    const po = await PurchaseOrder.findById(poId);
    if (!po) {
      console.log('❌ PO not found');
      process.exit(1);
    }

    console.log(`📦 PO: ${po.poNumber}`);
    console.log(`Items: ${po.items.length}\n`);

    // Populate products (skip unit to avoid schema issues)
    await po.populate(['items.product']);

    for (const poItem of po.items) {
      console.log(`\n🔍 Item ${po.items.indexOf(poItem) + 1}:`);
      console.log(`  Product ID: ${poItem.product?._id || poItem.product}`);
      console.log(`  Product Type: ${typeof poItem.product}`);
      console.log(`  Product Category: ${poItem.product?.category}`);
      console.log(`  Slot ID: ${poItem.slotId}`);
      console.log(`  Product Name: ${poItem.productName}`);
      console.log(`  Quantity: ${poItem.quantity}`);

      // Check conditions
      const hasProduct = !!poItem.product;
      const isPlantsCategory = poItem.product?.category === 'plants';
      const hasSlotId = !!poItem.slotId;
      const hasProductName = !!poItem.productName;

      console.log(`\n  Conditions Check:`);
      console.log(`    Has Product: ${hasProduct}`);
      console.log(`    Is Plants Category: ${isPlantsCategory}`);
      console.log(`    Has Slot ID: ${hasSlotId}`);
      console.log(`    Has Product Name: ${hasProductName}`);
      console.log(`    All Conditions Met: ${isPlantsCategory && hasSlotId && hasProductName}`);

      if (isPlantsCategory && hasSlotId && hasProductName) {
        console.log(`\n  ✅ Should initialize productStock!`);
        
        // Try to find slot
        const slotObjectId = new mongoose.Types.ObjectId(poItem.slotId);
        const slotDoc = await PlantSlot.findOne({
          "subtypeSlots.slots._id": slotObjectId
        });

        if (slotDoc) {
          console.log(`  ✅ Slot document found (Year: ${slotDoc.year})`);
          
          // Find the slot
          let foundSlot = null;
          for (const subtypeSlot of slotDoc.subtypeSlots || []) {
            const slot = subtypeSlot.slots.find(s => s._id && s._id.toString() === slotObjectId.toString());
            if (slot) {
              foundSlot = slot;
              break;
            }
          }

          if (foundSlot) {
            console.log(`  ✅ Slot found in document`);
            console.log(`  Current productStock:`, foundSlot.productStock || []);
            
            // Try to initialize
            if (!foundSlot.productStock) {
              foundSlot.productStock = [];
            }
            
            let productStock = foundSlot.productStock.find(ps => ps.productName === poItem.productName);
            
            if (!productStock) {
              foundSlot.productStock.push({
                productName: poItem.productName,
                available: 0,
                booked: 0,
                poQuantity: poItem.quantity,
                received: false
              });
              console.log(`  ✅ Would create productStock entry`);
            } else {
              console.log(`  ✅ ProductStock entry already exists`);
            }
            
            await slotDoc.save();
            console.log(`  ✅ Slot saved successfully`);
            
            // Verify
            const updatedSlotDoc = await PlantSlot.findOne({
              "subtypeSlots.slots._id": slotObjectId
            });
            for (const subtypeSlot of updatedSlotDoc.subtypeSlots || []) {
              const slot = subtypeSlot.slots.find(s => s._id && s._id.toString() === slotObjectId.toString());
              if (slot) {
                console.log(`  ✅ Verified productStock:`, slot.productStock || []);
                break;
              }
            }
          } else {
            console.log(`  ❌ Slot not found in document structure`);
          }
        } else {
          console.log(`  ❌ Slot document not found`);
        }
      } else {
        console.log(`  ❌ Conditions not met - productStock will NOT be initialized`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error);
    console.error('Stack:', error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected');
  }
}

testProductStockInit();

