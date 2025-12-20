import mongoose from 'mongoose';
import PlantSlot from '../models/slots.model.js';
import PlantCms from '../models/plantCms.model.js';
import SowingRequest from '../models/sowingRequest.model.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const findExcessiveSowingSlots = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/nursery';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // First, find all excessive sowing requests to get their linked slots
    const excessiveRequests = await SowingRequest.find({ isExcessiveSowing: true })
      .select('_id requestNumber plantId subtypeId linkedSlotIds isExcessiveSowing')
      .lean();
    
    console.log(`📋 Found ${excessiveRequests.length} excessive sowing requests`);
    
    // Create a map of slot IDs to excessive requests
    const slotToRequestMap = new Map();
    excessiveRequests.forEach(req => {
      if (req.linkedSlotIds && req.linkedSlotIds.length > 0) {
        req.linkedSlotIds.forEach(slotId => {
          const slotIdStr = slotId.toString();
          if (!slotToRequestMap.has(slotIdStr)) {
            slotToRequestMap.set(slotIdStr, []);
          }
          slotToRequestMap.get(slotIdStr).push({
            requestId: req._id.toString(),
            requestNumber: req.requestNumber,
          });
        });
      }
    });

    // Find all slots with excessive sowing data
    const plantSlots = await PlantSlot.find({}).populate('plantId', 'name subtypes');

    const excessiveSlots = [];

    plantSlots.forEach(plantSlot => {
      plantSlot.subtypeSlots.forEach(subtypeSlot => {
        subtypeSlot.slots.forEach(slot => {
          const excessivePackets = slot.excessiveSowing?.packets || 0;
          const excessivePlants = slot.excessiveSowing?.plants || 0;
          const slotIdStr = slot._id.toString();
          const linkedExcessiveRequests = slotToRequestMap.get(slotIdStr) || [];

          // Include slot if it has excessive sowing data OR is linked to excessive requests
          if (excessivePackets > 0 || excessivePlants > 0 || linkedExcessiveRequests.length > 0) {
            // Get plant name
            const plantName = plantSlot.plantId?.name || 'Unknown';
            
            // Get subtype name
            const plant = plantSlot.plantId;
            let subtypeName = 'Unknown';
            if (plant && plant.subtypes) {
              const subtype = plant.subtypes.find(
                st => st._id.toString() === subtypeSlot.subtypeId?.toString()
              );
              subtypeName = subtype?.name || 'Unknown';
            }

            excessiveSlots.push({
              slotId: slot._id.toString(),
              plantId: plantSlot.plantId?._id?.toString() || 'Unknown',
              plantName: plantName,
              subtypeId: subtypeSlot.subtypeId?.toString() || 'Unknown',
              subtypeName: subtypeName,
              startDay: slot.startDay,
              endDay: slot.endDay,
              month: slot.month,
              excessiveSowing: {
                packets: excessivePackets,
                plants: excessivePlants,
              },
              totalPlants: slot.totalPlants || 0,
              primarySowed: slot.primarySowed || 0,
              availablePlants: slot.availablePlants || 0,
              sowingInProgress: slot.sowingInProgress || false,
              sowingCompleted: slot.sowingCompleted || false,
              actualSowingDate: slot.actualSowingDate || null,
              linkedSowingRequests: slot.linkedSowingRequests?.map(id => id.toString()) || [],
              linkedExcessiveRequests: linkedExcessiveRequests,
              hasExcessiveSowingData: excessivePackets > 0 || excessivePlants > 0,
              isLinkedToExcessiveRequest: linkedExcessiveRequests.length > 0,
            });
          }
        });
      });
    });

    console.log('\n========================================');
    console.log(`📊 Found ${excessiveSlots.length} slots with excessive sowing data`);
    console.log('========================================\n');

    if (excessiveSlots.length === 0) {
      console.log('No slots with excessive sowing data found.');
    } else {
      // Group by plant/subtype
      const grouped = {};
      excessiveSlots.forEach(slot => {
        const key = `${slot.plantName} - ${slot.subtypeName}`;
        if (!grouped[key]) {
          grouped[key] = [];
        }
        grouped[key].push(slot);
      });

      // Display results
      Object.keys(grouped).forEach(key => {
        console.log(`\n🌱 ${key}`);
        console.log('─'.repeat(80));
        grouped[key].forEach(slot => {
          console.log(`  Slot ID: ${slot.slotId}`);
          console.log(`  Date Range: ${slot.startDay} to ${slot.endDay}`);
          console.log(`  Excessive Sowing Data: ${slot.excessiveSowing.packets} packets, ${slot.excessiveSowing.plants} plants`);
          console.log(`  Total Plants: ${slot.totalPlants}`);
          console.log(`  Primary Sowed: ${slot.primarySowed}`);
          console.log(`  Available Plants: ${slot.availablePlants}`);
          console.log(`  Sowing In Progress: ${slot.sowingInProgress ? 'Yes' : 'No'}`);
          console.log(`  Sowing Completed: ${slot.sowingCompleted ? 'Yes' : 'No'}`);
          if (slot.actualSowingDate) {
            console.log(`  Actual Sowing Date: ${slot.actualSowingDate}`);
          }
          if (slot.linkedSowingRequests.length > 0) {
            console.log(`  All Linked Sowing Requests: ${slot.linkedSowingRequests.join(', ')}`);
          }
          if (slot.linkedExcessiveRequests.length > 0) {
            console.log(`  🔄 Linked Excessive Requests: ${slot.linkedExcessiveRequests.map(r => r.requestNumber).join(', ')}`);
          }
          console.log(`  Has Excessive Data: ${slot.hasExcessiveSowingData ? 'Yes' : 'No'}`);
          console.log(`  Linked to Excessive Request: ${slot.isLinkedToExcessiveRequest ? 'Yes' : 'No'}`);
          console.log('');
        });
      });

      // Summary
      console.log('\n========================================');
      console.log('📈 SUMMARY');
      console.log('========================================');
      console.log(`Total Slots with Excessive Sowing: ${excessiveSlots.length}`);
      const totalPackets = excessiveSlots.reduce((sum, slot) => sum + slot.excessiveSowing.packets, 0);
      const totalPlants = excessiveSlots.reduce((sum, slot) => sum + slot.excessiveSowing.plants, 0);
      console.log(`Total Excessive Packets: ${totalPackets}`);
      console.log(`Total Excessive Plants: ${totalPlants}`);
      console.log(`Unique Plant/Subtype Combinations: ${Object.keys(grouped).length}`);
      console.log('========================================\n');

      // Export to JSON
      const fs = await import('fs');
      const outputPath = './excessive-sowing-slots.json';
      fs.writeFileSync(outputPath, JSON.stringify(excessiveSlots, null, 2));
      console.log(`✅ Results exported to ${outputPath}`);
    }

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

// Run the script
findExcessiveSowingSlots();

