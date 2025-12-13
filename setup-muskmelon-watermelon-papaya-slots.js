import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import moment from 'moment';

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

/**
 * Generate slots for a date range
 * @param {string} startDate - Start date in DD-MM-YYYY format
 * @param {string} endDate - End date in DD-MM-YYYY format
 * @param {number} slotSize - Number of days per slot (1 or 7)
 * @param {number} plantReadyDays - Plant ready days from subtype
 * @returns {Array} Array of slot objects
 */
const generateSlots = (startDate, endDate, slotSize, plantReadyDays = 0) => {
  const slots = [];
  const start = moment(startDate, 'DD-MM-YYYY');
  const end = moment(endDate, 'DD-MM-YYYY');
  
  let currentDate = start.clone();
  
  while (currentDate.isSameOrBefore(end)) {
    // Calculate slot end date
    const slotEnd = moment.min(
      currentDate.clone().add(slotSize - 1, 'days'),
      end.clone()
    );
    
    // Format dates as DD-MM-YYYY
    const startDay = currentDate.format('DD-MM-YYYY');
    const endDay = slotEnd.format('DD-MM-YYYY');
    
    // Get month name
    const monthName = currentDate.format('MMMM');
    
    // Create slot object with 0 totalPlants and availablePlants
    const slot = {
      startDay,
      endDay,
      month: monthName,
      totalPlants: 0, // Set to 0 as requested
      totalBookedPlants: 0,
      availablePlants: 0, // Set to 0 as requested
      buffer: 0,
      effectiveBuffer: 0,
      bufferAdjustedCapacity: 0,
      bufferAmount: 0,
      originalTotalPlants: 0,
      isOverflow: false,
      orders: [],
      allowedSalesmen: [],
      restrictToSalesmen: false,
      overflow: false,
      status: true,
      isManual: false,
      plantReadyDays,
      plantsSowed: 0,
      officeSowed: 0,
      primarySowed: 0, // Reset to 0
      sowingDate: null,
      plantReadyDate: null,
      reminderBeforePlantReadyDays: 0
    };
    
    slots.push(slot);
    
    // Move to next slot start
    currentDate.add(slotSize, 'days');
  }
  
  return slots;
};

const setupSlots = async () => {
  try {
    await connectDB();
    
    const PlantCms = (await import('./models/plantCms.model.js')).default;
    const PlantSlot = (await import('./models/slots.model.js')).default;
    const Order = (await import('./models/order.model.js')).default;
    
    console.log('\n🌱 Setting up Slots for Muskmelon, Watermelon, and Papaya');
    console.log('═══════════════════════════════════════════════\n');
    
    // Step 1: Delete all Muskmelon orders
    console.log('📋 Step 1: Deleting all Muskmelon orders...\n');
    const muskmelonPlant = await PlantCms.findOne({
      name: { $regex: new RegExp('^muskmelon$', 'i') }
    });
    
    if (muskmelonPlant) {
      const muskmelonOrders = await Order.find({
        plantName: muskmelonPlant._id
      });
      
      if (muskmelonOrders.length > 0) {
        const deleteResult = await Order.deleteMany({
          plantName: muskmelonPlant._id
        });
        console.log(`✅ Deleted ${deleteResult.deletedCount} Muskmelon order(s)`);
      } else {
        console.log('ℹ️  No Muskmelon orders found to delete');
      }
    } else {
      console.log('⚠️  Muskmelon plant not found, skipping order deletion');
    }
    
    // Step 2: Setup slots for each plant
    const plantsToSetup = [
      { name: 'muskmelon', slotSize: 1, description: '1-day slots with 0 available' },
      { name: 'watermelon', slotSize: 1, description: '1-day slots with 0 available' },
      { name: 'papaya', slotSize: 7, description: '7-day slots (same as Banana) with 0 available' }
    ];
    
    const years = [2025, 2026];
    
    for (const plantConfig of plantsToSetup) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`🌿 Processing ${plantConfig.name.toUpperCase()}`);
      console.log(`${'='.repeat(50)}\n`);
      
      // Find plant
      const plant = await PlantCms.findOne({
        name: { $regex: new RegExp(`^${plantConfig.name}$`, 'i') }
      });
      
      if (!plant) {
        console.log(`❌ ${plantConfig.name} plant not found, skipping...`);
        continue;
      }
      
      console.log(`✅ Found plant: ${plant.name} (${plant._id})`);
      console.log(`   Subtypes: ${plant.subtypes?.length || 0}`);
      if (plant.subtypes && plant.subtypes.length > 0) {
        plant.subtypes.forEach((subtype, idx) => {
          console.log(`      ${idx + 1}. ${subtype.name} (${subtype._id})`);
        });
      }
      
      // Delete existing slots
      const existingSlots = await PlantSlot.find({ plantId: plant._id });
      if (existingSlots.length > 0) {
        console.log(`\n🗑️  Deleting ${existingSlots.length} existing PlantSlot document(s)...`);
        await PlantSlot.deleteMany({ plantId: plant._id });
        console.log('✅ Existing slots deleted');
      }
      
      // Update plant slotSize
      if (plant.slotSize !== plantConfig.slotSize) {
        plant.slotSize = plantConfig.slotSize;
        await plant.save();
        console.log(`✅ Updated ${plant.name} slotSize to ${plantConfig.slotSize}`);
      }
      
      // Create slots for each year
      for (const year of years) {
        console.log(`\n📅 Creating slots for year ${year}...`);
        console.log(`   Slot Size: ${plantConfig.slotSize} days`);
        console.log(`   Total Plants: 0`);
        console.log(`   Available Plants: 0`);
        
        const startDate = `01-01-${year}`;
        const endDate = `31-12-${year}`;
        
        // Create subtypeSlots array
        const subtypeSlots = [];
        
        // Process each subtype
        for (const subtype of plant.subtypes) {
          const plantReadyDays = subtype.plantReadyDays || 0;
          
          // Generate slots for this subtype
          const slots = generateSlots(
            startDate,
            endDate,
            plantConfig.slotSize,
            plantReadyDays
          );
          
          console.log(`   ${subtype.name}: ${slots.length} slots`);
          
          // Add to subtypeSlots
          subtypeSlots.push({
            subtypeId: subtype._id,
            slots: slots
          });
        }
        
        // Create PlantSlot document for this year
        const plantSlot = new PlantSlot({
          plantId: plant._id,
          year: year,
          subtypeSlots: subtypeSlots
        });
        
        await plantSlot.save();
        console.log(`   ✅ Created PlantSlot document for year ${year}`);
        console.log(`      Total slots: ${subtypeSlots.reduce((sum, st) => sum + st.slots.length, 0)}`);
      }
    }
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 SETUP SUMMARY');
    console.log('='.repeat(50));
    
    for (const plantConfig of plantsToSetup) {
      const plant = await PlantCms.findOne({
        name: { $regex: new RegExp(`^${plantConfig.name}$`, 'i') }
      });
      
      if (plant) {
        const slots = await PlantSlot.find({ plantId: plant._id });
        let totalSlots = 0;
        let totalAvailable = 0;
        let totalPrimarySowed = 0;
        
        slots.forEach(ps => {
          ps.subtypeSlots?.forEach(st => {
            st.slots?.forEach(slot => {
              totalSlots++;
              totalAvailable += slot.availablePlants || 0;
              totalPrimarySowed += slot.primarySowed || 0;
            });
          });
        });
        
        console.log(`\n${plant.name.toUpperCase()}:`);
        console.log(`   Slot Size: ${plantConfig.slotSize} days`);
        console.log(`   PlantSlot Documents: ${slots.length}`);
        console.log(`   Total Slots: ${totalSlots}`);
        console.log(`   Total Available: ${totalAvailable}`);
        console.log(`   Total Primary Sowed: ${totalPrimarySowed}`);
      }
    }
    
    console.log('\n✅ Setup completed successfully!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
};

setupSlots();




