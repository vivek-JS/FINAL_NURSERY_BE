import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Fix invalid slotTrail entries with missing or invalid activityName
 */
const fixInvalidSlotTrail = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB');

    const PlantSlot = (await import('./models/slots.model.js')).default;

    // Activity name mapping
    const activityNameMap = {
      'ADD': 'Plants Added',
      'SUBTRACT': 'Plants Subtracted',
      'BUFFER_APPLIED': 'Buffer Applied',
      'BUFFER_RELEASED': 'Buffer Released',
      'ADD_WITH_BUFFER': 'Plants Added with Buffer',
      'ADD_WITH_BUFFER_RELEASE': 'Plants Added with Buffer Release',
      'SUBTRACT_WITH_BUFFER': 'Plants Subtracted with Buffer',
      'SUBTRACT_WITH_BUFFER_RELEASE': 'Plants Subtracted with Buffer Release',
      'UPDATE': 'Slot Updated',
      'ORDER_CANCELLED': 'Order Cancelled',
      'ORDER_RETURNED': 'Order Returned',
      'SOWING_STARTED': 'Sowing Started',
      'SOWING_COMPLETED': 'Sowing Completed',
      'SOWING_CANCELLED': 'Sowing Cancelled',
      'SOWING_PRIMARY': 'Primary Location Sowing',
      'SOWING_OFFICE': 'Office Location Sowing',
      'SOWING_EXCESSIVE': 'Excessive Sowing',
      'EXCESSIVE_SOWING_ADDED': 'Excessive Sowing Added',
      'STOCK_REQUEST_CREATED': 'Stock Request Created',
      'STOCK_REQUEST_ISSUED': 'Stock Request Issued',
      'STOCK_REQUEST_CANCELLED': 'Stock Request Cancelled',
      'GAP_COVERED': 'Gap Covered',
      'SOWING_IN_PROGRESS_CLEARED': 'Sowing In Progress Cleared',
      'PACKETS_RETURNED': 'Packets Returned',
      'PACKETS_USED': 'Packets Used',
    };

    const getActivityName = (action) => {
      if (!action) return 'Unknown Activity';
      return activityNameMap[action] || action.replace(/_/g, ' ');
    };

    // Find all PlantSlot documents
    const slots = await PlantSlot.find({});
    console.log(`📦 Found ${slots.length} PlantSlot documents to check`);

    let totalFixed = 0;
    let documentsToSave = [];

    for (const slot of slots) {
      let hasChanges = false;

      for (const subtypeSlot of slot.subtypeSlots || []) {
        for (const s of subtypeSlot.slots || []) {
          if (s.slotTrail && s.slotTrail.length > 0) {
            for (const trail of s.slotTrail) {
              // Check if activityName is missing, empty, or invalid
              if (!trail.activityName || 
                  trail.activityName === 'undefined' || 
                  trail.activityName.trim().length < 2) {
                const newActivityName = getActivityName(trail.action);
                trail.activityName = newActivityName;
                hasChanges = true;
                totalFixed++;
              }
            }
          }
        }
      }

      if (hasChanges) {
        documentsToSave.push(slot);
      }
    }

    console.log(`\n🔧 Fixed ${totalFixed} invalid slotTrail entries`);
    console.log(`💾 Saving ${documentsToSave.length} PlantSlot documents...`);

    // Save all documents with fixes
    for (const slot of documentsToSave) {
      try {
        await slot.save();
      } catch (error) {
        console.error(`❌ Error saving PlantSlot ${slot._id}:`, error.message);
      }
    }

    console.log(`\n✅ Successfully fixed all invalid slotTrail entries!`);
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error fixing slotTrail:', error);
    process.exit(1);
  }
};

fixInvalidSlotTrail();





