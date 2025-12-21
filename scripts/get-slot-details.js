import dotenv from 'dotenv';
import mongoose from 'mongoose';
import PlantSlot from '../models/slots.model.js';

dotenv.config();

const slotId = process.argv[2] || '69468f91a0b657d0f8b87c9c';

async function getSlotDetails() {
  try {
    // Connect to MongoDB
    const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!mongoUrl) {
      console.error('❌ MONGO_URL not found in environment variables');
      process.exit(1);
    }

    await mongoose.connect(mongoUrl);
    console.log('✅ Connected to MongoDB');

    // Convert slotId to ObjectId
    let slotObjectId;
    try {
      slotObjectId = new mongoose.Types.ObjectId(slotId);
    } catch (e) {
      console.error(`❌ Invalid slotId format: ${slotId}`, e);
      process.exit(1);
    }

    console.log(`\n🔍 Searching for slot: ${slotId}\n`);

    // Find the slot document
    const plantSlotDoc = await PlantSlot.findOne({
      "subtypeSlots.slots._id": slotObjectId
    });

    if (!plantSlotDoc) {
      console.log('❌ Slot not found in database');
      process.exit(1);
    }

    console.log('✅ Slot found!\n');
    console.log('='.repeat(80));
    console.log('PLANT SLOT DOCUMENT DETAILS');
    console.log('='.repeat(80));
    console.log(`Plant ID: ${plantSlotDoc.plantId}`);
    console.log(`Year: ${plantSlotDoc.year}`);
    console.log(`Created At: ${plantSlotDoc.createdAt}`);
    console.log(`Updated At: ${plantSlotDoc.updatedAt}`);
    console.log(`\nTotal Subtype Slots: ${plantSlotDoc.subtypeSlots?.length || 0}\n`);

    // Find the specific slot
    let foundSlot = null;
    let foundSubtypeIndex = -1;
    let foundSlotIndex = -1;

    for (let i = 0; i < (plantSlotDoc.subtypeSlots || []).length; i++) {
      const subtypeSlot = plantSlotDoc.subtypeSlots[i];
      for (let j = 0; j < (subtypeSlot.slots || []).length; j++) {
        const slot = subtypeSlot.slots[j];
        if (slot._id && slot._id.toString() === slotObjectId.toString()) {
          foundSlot = slot;
          foundSubtypeIndex = i;
          foundSlotIndex = j;
          break;
        }
      }
      if (foundSlot) break;
    }

    if (!foundSlot) {
      console.log('❌ Slot not found in document structure');
      process.exit(1);
    }

    const subtypeSlot = plantSlotDoc.subtypeSlots[foundSubtypeIndex];

    console.log('='.repeat(80));
    console.log('SUBTYPE SLOT DETAILS');
    console.log('='.repeat(80));
    console.log(`Subtype ID: ${subtypeSlot.subtypeId}`);
    console.log(`Subtype Name: ${subtypeSlot.subtypeName || 'N/A'}`);
    console.log(`Total Slots in Subtype: ${subtypeSlot.slots?.length || 0}\n`);

    console.log('='.repeat(80));
    console.log('SLOT DETAILS');
    console.log('='.repeat(80));
    console.log(`Slot ID: ${foundSlot._id}`);
    console.log(`Start Day: ${foundSlot.startDay || 'N/A'}`);
    console.log(`End Day: ${foundSlot.endDay || 'N/A'}`);
    console.log(`Month: ${foundSlot.month || 'N/A'}`);
    console.log(`Status: ${foundSlot.status !== false ? 'Active' : 'Inactive'}`);
    console.log(`\n📊 CAPACITY & BOOKING:`);
    console.log(`  Total Plants: ${foundSlot.totalPlants || 0}`);
    console.log(`  Total Booked Plants: ${foundSlot.totalBookedPlants || 0}`);
    console.log(`  Available Plants: ${foundSlot.availablePlants || 0}`);
    console.log(`  Plants Sowed: ${foundSlot.plantsSowed || 0}`);
    console.log(`  Office Sowed: ${foundSlot.officeSowed || 0}`);
    console.log(`  Primary Sowed: ${foundSlot.primarySowed || 0}`);
    console.log(`\n📅 SOWING DETAILS:`);
    console.log(`  Plant Ready Days: ${foundSlot.plantReadyDays || 0}`);
    console.log(`  Is Manual: ${foundSlot.isManual || false}`);
    console.log(`  Is Overflow: ${foundSlot.isOverflow || false}`);
    console.log(`\n📦 BUFFER SETTINGS:`);
    console.log(`  Buffer: ${foundSlot.buffer || 0}%`);
    console.log(`  Effective Buffer: ${foundSlot.effectiveBuffer || 0}%`);
    console.log(`  Buffer Adjusted Capacity: ${foundSlot.bufferAdjustedCapacity || 0}`);
    console.log(`  Buffer Amount: ${foundSlot.bufferAmount || 0}`);
    console.log(`  Original Total Plants: ${foundSlot.originalTotalPlants || 0}`);

    // Product Stock Details
    if (foundSlot.productStock && foundSlot.productStock.length > 0) {
      console.log(`\n🛒 PRODUCT STOCK (${foundSlot.productStock.length} products):`);
      console.log('='.repeat(80));
      foundSlot.productStock.forEach((product, index) => {
        console.log(`\nProduct ${index + 1}: ${product.productName}`);
        console.log(`  Available: ${product.available || 0}`);
        console.log(`  Booked: ${product.booked || 0}`);
        console.log(`  PO Quantity: ${product.poQuantity || 0}`);
        console.log(`  Received: ${product.received ? 'Yes' : 'No'}`);
        const totalAvailable = (product.available || 0) - (product.booked || 0) + (product.poQuantity || 0);
        console.log(`  Total Available for Booking: ${totalAvailable}`);
      });
    } else {
      console.log(`\n🛒 PRODUCT STOCK: No products tracked in this slot`);
    }

    // Orders
    if (foundSlot.orders && foundSlot.orders.length > 0) {
      console.log(`\n📋 ORDERS: ${foundSlot.orders.length} order(s) linked`);
      console.log(`  Order IDs: ${foundSlot.orders.map(o => o.toString()).join(', ')}`);
    } else {
      console.log(`\n📋 ORDERS: No orders linked`);
    }

    // Allowed Salesmen
    if (foundSlot.allowedSalesmen && foundSlot.allowedSalesmen.length > 0) {
      console.log(`\n👥 ALLOWED SALESMEN: ${foundSlot.allowedSalesmen.length} salesman(s)`);
      console.log(`  Salesman IDs: ${foundSlot.allowedSalesmen.map(s => s.toString()).join(', ')}`);
    } else {
      console.log(`\n👥 ALLOWED SALESMEN: All salesmen can access`);
    }

    // Gap Coverage
    if (foundSlot.gapCovered && foundSlot.gapCovered.length > 0) {
      console.log(`\n🔄 GAP COVERAGE: ${foundSlot.gapCovered.length} gap(s) covered`);
      foundSlot.gapCovered.forEach((gap, index) => {
        console.log(`  Gap ${index + 1}:`);
        console.log(`    From Slot: ${gap.fromSlotId}`);
        console.log(`    From Slot Date: ${gap.fromSlotDate}`);
        console.log(`    Plants Covered: ${gap.plantsCovered}`);
        console.log(`    Coverage Date: ${gap.coverageDate}`);
      });
    }

    // Slot Trail
    if (foundSlot.slotTrail && foundSlot.slotTrail.length > 0) {
      console.log(`\n🛤️  SLOT TRAIL: ${foundSlot.slotTrail.length} trail entry/entries`);
      foundSlot.slotTrail.forEach((trail, index) => {
        console.log(`  Trail ${index + 1}:`);
        console.log(`    Date: ${trail.date}`);
        console.log(`    Action: ${trail.action}`);
        console.log(`    Quantity: ${trail.quantity}`);
      });
    }

    // Full JSON dump
    console.log('\n' + '='.repeat(80));
    console.log('FULL SLOT OBJECT (JSON)');
    console.log('='.repeat(80));
    console.log(JSON.stringify(foundSlot.toObject(), null, 2));

    console.log('\n' + '='.repeat(80));
    console.log('✅ Slot details retrieved successfully!');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('❌ Error fetching slot details:', error);
    console.error('Stack:', error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  }
}

getSlotDetails();

