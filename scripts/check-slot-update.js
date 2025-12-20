import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PlantSlot from '../models/slots.model.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';

const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const checkSlot = async (slotId) => {
  try {
    console.log(`\n🔍 Checking slot: ${slotId}\n`);
    
    const mongoose = (await import('mongoose')).default;
    const slotObjectId = new mongoose.Types.ObjectId(slotId);
    
    // Try multiple query methods
    console.log('1. Searching with ObjectId...');
    let plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotObjectId }
    ).lean();

    if (!plantSlot) {
      console.log('   ❌ Not found with ObjectId, trying string...');
      plantSlot = await PlantSlot.findOne(
        { "subtypeSlots.slots._id": slotId }
      ).lean();
    }

    if (!plantSlot) {
      console.log('   ❌ Not found with string, searching all years...');
      const allSlots = await PlantSlot.find({
        "subtypeSlots.slots._id": slotObjectId
      }).limit(5).lean();
      
      if (allSlots.length > 0) {
        plantSlot = allSlots[0];
        console.log(`   ✅ Found in year ${plantSlot.year}`);
      }
    }

    if (!plantSlot) {
      console.log('❌ Slot not found in any PlantSlot document');
      
      // Check GRNs anyway
      const { default: GRN } = await import('../models/grn.model.js');
      const grns = await GRN.find({
        "items.slotId": slotObjectId,
        status: 'approved'
      }).select('grnNumber items.acceptedQuantity items.slotId').lean();
      
      if (grns.length > 0) {
        console.log(`\n⚠️ Found ${grns.length} approved GRN(s) with this slotId, but slot not found in database:`);
        grns.forEach(grn => {
          const item = grn.items.find(i => i.slotId && i.slotId.toString() === slotId);
          if (item) {
            console.log(`   - GRN: ${grn.grnNumber}, Accepted: ${item.acceptedQuantity}`);
          }
        });
        console.log('\n   This suggests the slot may have been deleted or the slotId is incorrect.');
      }
      return;
    }

    console.log(`✅ Found PlantSlot document (Year: ${plantSlot.year}, Plant: ${plantSlot.plantId})`);
    
    // Find the specific slot
    let slot = null;
    let foundInSubtype = null;
    
    for (const subtypeSlot of plantSlot.subtypeSlots || []) {
      slot = subtypeSlot.slots?.find(
        (s) => s._id && s._id.toString() === slotId.toString()
      );
      if (slot) {
        foundInSubtype = subtypeSlot;
        break;
      }
    }

    if (!slot) {
      console.log('❌ Specific slot not found in any subtype');
      return;
    }

    console.log('\n📊 Slot Information:');
    console.log('   Slot ID:', slot._id);
    console.log('   Start Day:', slot.startDay);
    console.log('   End Day:', slot.endDay);
    console.log('   Total Plants:', slot.totalPlants);
    console.log('   Available Plants:', slot.availablePlants);
    console.log('   Total Booked Plants:', slot.totalBookedPlants);
    console.log('   Plants Sowed:', slot.plantsSowed);
    console.log('   Status:', slot.status);
    
    // Check if there are any GRN items with this slotId
    const { default: GRN } = await import('../models/grn.model.js');
    const grns = await GRN.find({
      "items.slotId": slotObjectId,
      status: 'approved'
    }).select('grnNumber items.acceptedQuantity items.slotId').lean();

    if (grns.length > 0) {
      console.log(`\n📦 Found ${grns.length} approved GRN(s) with this slotId:`);
      let totalAdded = 0;
      grns.forEach(grn => {
        const item = grn.items.find(i => i.slotId && i.slotId.toString() === slotId);
        if (item) {
          console.log(`   - GRN: ${grn.grnNumber}, Accepted Quantity: ${item.acceptedQuantity}`);
          totalAdded += item.acceptedQuantity || 0;
        }
      });
      console.log(`\n   Total quantity that should have been added: ${totalAdded}`);
      console.log(`   Current availablePlants: ${slot.availablePlants}`);
      console.log(`   Expected availablePlants (if update worked): ${(slot.availablePlants || 0) - totalAdded} + ${totalAdded} = ${slot.availablePlants}`);
    } else {
      console.log('\n⚠️ No approved GRNs found with this slotId');
    }

  } catch (error) {
    console.error('❌ Error checking slot:', error);
    console.error('   Stack:', error.stack);
  }
};

const main = async () => {
  await connectDB();
  
  const slotId = process.argv[2];
  if (!slotId) {
    console.log('Usage: node check-slot-update.js <slotId>');
    process.exit(1);
  }
  
  await checkSlot(slotId);
  
  await mongoose.disconnect();
  console.log('\n✅ Disconnected from MongoDB');
  process.exit(0);
};

main();


