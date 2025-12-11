import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGO_URL or MONGODB_URI environment variable is required.');
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const addRandomPrimarySowing = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    
    console.log('\n🌱 Adding Random Primary Sowing for Muskmelon Layalpur');
    console.log('═══════════════════════════════════════════════\n');
    
    // Find Muskmelon plant
    const muskmelon = await PlantCms.findOne({
      name: { $regex: new RegExp('^muskmelon$', 'i') }
    });
    
    if (!muskmelon) {
      console.log('❌ Muskmelon plant not found.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found plant: ${muskmelon.name} (${muskmelon._id})`);
    
    // Find Layalpur subtype
    const layalpurSubtype = muskmelon.subtypes.find(
      st => st.name && st.name.toLowerCase() === 'layalpur'
    );
    
    if (!layalpurSubtype) {
      console.log('❌ Layalpur subtype not found in Muskmelon.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`✅ Found subtype: ${layalpurSubtype.name} (${layalpurSubtype._id})\n`);
    
    // Find PlantSlot documents for Muskmelon
    const plantSlots = await PlantSlot.find({
      plantId: muskmelon._id
    });
    
    if (plantSlots.length === 0) {
      console.log('❌ No slots found for Muskmelon.');
      await mongoose.connection.close();
      return;
    }
    
    console.log(`📊 Found ${plantSlots.length} PlantSlot document(s) for Muskmelon\n`);
    
    let totalSlotsUpdated = 0;
    let totalPrimarySowedAdded = 0;
    
    // Process each year's slots
    for (const plantSlot of plantSlots) {
      console.log(`📅 Processing Year ${plantSlot.year}...`);
      
      // Find Layalpur subtype slots
      const layalpurSubtypeSlot = plantSlot.subtypeSlots.find(
        st => st.subtypeId.toString() === layalpurSubtype._id.toString()
      );
      
      if (!layalpurSubtypeSlot || !layalpurSubtypeSlot.slots || layalpurSubtypeSlot.slots.length === 0) {
        console.log(`   ⚠️  No slots found for Layalpur in year ${plantSlot.year}\n`);
        continue;
      }
      
      const slots = layalpurSubtypeSlot.slots;
      console.log(`   Found ${slots.length} slots for Layalpur`);
      
      // Update ALL slots
      const indicesToUpdate = slots.map((_, index) => index);
      
      console.log(`   Will update ALL ${slots.length} slots with primary sowing\n`);
      
      // Update slots with random primary sowing values
      const updates = [];
      
      for (const index of indicesToUpdate) {
        const slot = slots[index];
        
        // Random primary sowing: 1000 to 10000 plants
        const randomPrimarySowed = Math.floor(Math.random() * 9000) + 1000;
        
        // Random sowing date within the slot's month
        const slotDate = slot.startDay; // Format: DD-MM-YYYY
        const [day, month, year] = slotDate.split('-');
        const slotStart = new Date(`${year}-${month}-${day}`);
        
        // Random date within the slot (or up to 7 days before slot start)
        const daysBeforeSlot = Math.floor(Math.random() * 7);
        const sowingDate = new Date(slotStart);
        sowingDate.setDate(sowingDate.getDate() - daysBeforeSlot);
        
        const sowingDateStr = sowingDate.toISOString().split('T')[0].split('-').reverse().join('-');
        
        updates.push({
          slotId: slot._id,
          primarySowed: randomPrimarySowed,
          sowingDate: sowingDateStr,
          slotDate: slotDate
        });
      }
      
      // Update each slot
      for (const update of updates) {
        await PlantSlot.updateOne(
          { 
            _id: plantSlot._id,
            "subtypeSlots.subtypeId": layalpurSubtype._id
          },
          {
            $set: {
              "subtypeSlots.$[subtypeSlot].slots.$[slot].primarySowed": update.primarySowed,
              "subtypeSlots.$[subtypeSlot].slots.$[slot].sowingDate": update.sowingDate,
              "subtypeSlots.$[subtypeSlot].slots.$[slot].plantsSowed": update.primarySowed // Update total as well
            }
          },
          {
            arrayFilters: [
              { "subtypeSlot.subtypeId": layalpurSubtype._id },
              { "slot._id": update.slotId }
            ]
          }
        );
        
        totalSlotsUpdated++;
        totalPrimarySowedAdded += update.primarySowed;
        
        console.log(`   ✅ Updated slot ${update.slotDate}: primarySowed = ${update.primarySowed.toLocaleString()}, sowingDate = ${update.sowingDate}`);
      }
      
      console.log();
    }
    
    // Summary
    console.log('═══════════════════════════════════════════════');
    console.log('📊 SUMMARY');
    console.log('═══════════════════════════════════════════════');
    console.log(`Plant: Muskmelon`);
    console.log(`Subtype: Layalpur`);
    console.log(`Total Slots Updated: ${totalSlotsUpdated}`);
    console.log(`Total Primary Sowed Added: ${totalPrimarySowedAdded.toLocaleString()} plants`);
    
    // Verify updates
    console.log('\n🔍 Verifying updates...\n');
    const verifySlots = await PlantSlot.find({
      plantId: muskmelon._id
    });
    
    let totalPrimarySowed = 0;
    let slotsWithSowing = 0;
    
    verifySlots.forEach(ps => {
      const layalpurSubtypeSlot = ps.subtypeSlots.find(
        st => st.subtypeId.toString() === layalpurSubtype._id.toString()
      );
      
      if (layalpurSubtypeSlot && layalpurSubtypeSlot.slots) {
        layalpurSubtypeSlot.slots.forEach(slot => {
          if (slot.primarySowed > 0) {
            slotsWithSowing++;
            totalPrimarySowed += slot.primarySowed;
          }
        });
      }
    });
    
    console.log(`✅ Verification:`);
    console.log(`   Slots with primary sowing: ${slotsWithSowing}`);
    console.log(`   Total primary sowed: ${totalPrimarySowed.toLocaleString()} plants`);
    
    console.log('\n✅ Random primary sowing added successfully!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

addRandomPrimarySowing();

