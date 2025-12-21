import mongoose from 'mongoose';
import PlantSlot from '../models/slots.model.js';
import dotenv from 'dotenv';
import { config } from 'dotenv';

config();

const slotId = '6946ad02417da3a25906bcbc';

async function getSlotDetails() {
  try {
    // Connect to MongoDB - try to get from environment or use default
    const mongoUri = process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/nursery';
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const slotObjectId = new mongoose.Types.ObjectId(slotId);
    console.log(`Searching for slot ID: ${slotId}\n`);
    
    // Find the PlantSlot document containing this slot - get FULL document
    const plantSlotDoc = await PlantSlot.findOne({
      "subtypeSlots.slots._id": slotObjectId,
    }).lean();

    if (!plantSlotDoc) {
      console.log('❌ Slot not found in database');
      console.log('Trying to find in all PlantSlot documents...\n');
      
      // Try to find in all documents
      const allDocs = await PlantSlot.find({}).lean();
      console.log(`Found ${allDocs.length} PlantSlot documents`);
      
      for (const doc of allDocs) {
        for (const subtype of doc.subtypeSlots || []) {
          for (const slot of subtype.slots || []) {
            if (slot._id && slot._id.toString() === slotId) {
              console.log('\n✅ FOUND SLOT!\n');
              console.log('=== FULL DATABASE-LEVEL SLOT DETAILS ===\n');
              console.log(JSON.stringify({
                plantSlotDocument: doc,
                matchedSubtype: subtype,
                matchedSlot: slot
              }, null, 2));
              await mongoose.connection.close();
              process.exit(0);
            }
          }
        }
      }
      
      console.log('❌ Slot still not found after full search');
      await mongoose.connection.close();
      process.exit(1);
    }

    // Find the specific slot
    let matchedSubtype = null;
    let matchedSlot = null;

    for (const subtype of plantSlotDoc.subtypeSlots || []) {
      const slot = (subtype.slots || []).find(
        (item) => item._id && item._id.toString() === slotObjectId.toString()
      );
      if (slot) {
        matchedSubtype = subtype;
        matchedSlot = slot;
        break;
      }
    }

    if (!matchedSlot) {
      console.log('❌ Slot not found in subtypeSlots');
      await mongoose.connection.close();
      process.exit(1);
    }

    // Output FULL database document details
    console.log('=== FULL DATABASE-LEVEL SLOT DETAILS ===\n');
    console.log(JSON.stringify({
      plantSlotDocument: plantSlotDoc,
      matchedSubtype: matchedSubtype,
      matchedSlot: matchedSlot
    }, null, 2));

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

getSlotDetails();

