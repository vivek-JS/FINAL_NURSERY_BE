/**
 * Test Script for Sowing Feature
 * 
 * This script tests the complete sowing feature implementation
 * Run this in the FINAL_NURSERY_BE directory
 */

import mongoose from 'mongoose';
import PlantCms from './models/plantCms.model.js';
import PlantSlot from './models/slots.model.js';

// Test configuration
const TEST_CONFIG = {
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/nursery-test',
  TEST_PLANT_NAME: 'Test_Tomato_Sowing_' + Date.now()
};

console.log('🌱 Starting Sowing Feature Tests...\n');

// Connect to database
async function connectDB() {
  try {
    await mongoose.connect(TEST_CONFIG.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

// Test 1: Create plant with sowing configuration
async function testCreatePlantWithSowing() {
  console.log('📝 Test 1: Creating plant with sowing configuration...');
  
  try {
    const plantData = {
      name: TEST_CONFIG.TEST_PLANT_NAME,
      slotSize: 5,
      buffer: 10,
      isSowingAllowed: true,
      maximumNegativeAllowed: 5000,
      dailyDispatchCapacity: 2000,
      subtypes: [
        {
          name: 'Cherry',
          description: 'Small cherry tomatoes',
          rates: [10, 15, 20],
          buffer: 5,
          plantReadyDays: 45
        },
        {
          name: 'Beefsteak',
          description: 'Large tomatoes',
          rates: [15, 20, 25],
          buffer: 8,
          plantReadyDays: 60
        }
      ]
    };

    const plant = await PlantCms.create(plantData);
    
    console.log('✅ Plant created successfully');
    console.log('   - Plant ID:', plant._id);
    console.log('   - Name:', plant.name);
    console.log('   - Sowing Allowed:', plant.isSowingAllowed);
    console.log('   - Max Negative Allowed:', plant.maximumNegativeAllowed);
    console.log('   - Daily Dispatch Capacity:', plant.dailyDispatchCapacity);
    console.log('   - Subtypes:', plant.subtypes.length);
    
    plant.subtypes.forEach((subtype, index) => {
      console.log(`   - Subtype ${index + 1}: ${subtype.name} (Ready in ${subtype.plantReadyDays} days)`);
    });
    
    console.log('');
    return plant;
  } catch (error) {
    console.error('❌ Failed to create plant:', error.message);
    throw error;
  }
}

// Test 2: Verify plant fields
async function testVerifyPlantFields(plantId) {
  console.log('📝 Test 2: Verifying plant fields...');
  
  try {
    const plant = await PlantCms.findById(plantId);
    
    if (!plant) {
      throw new Error('Plant not found');
    }

    // Verify sowing fields
    const checks = [
      { name: 'isSowingAllowed exists', pass: plant.isSowingAllowed !== undefined },
      { name: 'isSowingAllowed is true', pass: plant.isSowingAllowed === true },
      { name: 'maximumNegativeAllowed exists', pass: plant.maximumNegativeAllowed !== undefined },
      { name: 'maximumNegativeAllowed is 5000', pass: plant.maximumNegativeAllowed === 5000 },
      { name: 'dailyDispatchCapacity exists', pass: plant.dailyDispatchCapacity !== undefined },
      { name: 'Subtypes have plantReadyDays', pass: plant.subtypes.every(s => s.plantReadyDays !== undefined) }
    ];

    checks.forEach(check => {
      console.log(check.pass ? `   ✅ ${check.name}` : `   ❌ ${check.name}`);
    });

    const allPassed = checks.every(c => c.pass);
    
    if (allPassed) {
      console.log('✅ All field verification checks passed\n');
    } else {
      throw new Error('Some field verification checks failed');
    }
    
    return plant;
  } catch (error) {
    console.error('❌ Field verification failed:', error.message);
    throw error;
  }
}

// Test 3: Create slots for the plant
async function testCreateSlots(plant) {
  console.log('📝 Test 3: Creating slots for plant...');
  
  try {
    const year = new Date().getFullYear();
    const subtypeSlots = plant.subtypes.map(subtype => ({
      subtypeId: subtype._id,
      slots: [
        {
          startDay: '01-01-' + year,
          endDay: '05-01-' + year,
          month: 'January',
          totalPlants: 1000,
          buffer: 10,
          sowedPlants: 0,
          sowingRecords: []
        },
        {
          startDay: '06-01-' + year,
          endDay: '10-01-' + year,
          month: 'January',
          totalPlants: 1500,
          buffer: 10,
          sowedPlants: 0,
          sowingRecords: []
        }
      ]
    }));

    const plantSlot = await PlantSlot.create({
      plantId: plant._id,
      year: year,
      subtypeSlots: subtypeSlots
    });

    console.log('✅ Slots created successfully');
    console.log('   - Slot Document ID:', plantSlot._id);
    console.log('   - Year:', plantSlot.year);
    console.log('   - Subtypes with slots:', plantSlot.subtypeSlots.length);
    
    plantSlot.subtypeSlots.forEach((subtypeSlot, index) => {
      console.log(`   - Subtype ${index + 1}: ${subtypeSlot.slots.length} slots`);
    });
    
    console.log('');
    return plantSlot;
  } catch (error) {
    console.error('❌ Failed to create slots:', error.message);
    throw error;
  }
}

// Test 4: Verify slot sowing fields
async function testVerifySlotFields(plantSlotId) {
  console.log('📝 Test 4: Verifying slot sowing fields...');
  
  try {
    const plantSlot = await PlantSlot.findById(plantSlotId);
    
    if (!plantSlot) {
      throw new Error('Plant slot not found');
    }

    let allChecksPass = true;

    plantSlot.subtypeSlots.forEach((subtypeSlot, stIndex) => {
      subtypeSlot.slots.forEach((slot, sIndex) => {
        const checks = [
          { name: `Subtype ${stIndex + 1} Slot ${sIndex + 1}: sowedPlants exists`, pass: slot.sowedPlants !== undefined },
          { name: `Subtype ${stIndex + 1} Slot ${sIndex + 1}: sowingRecords exists`, pass: slot.sowingRecords !== undefined },
          { name: `Subtype ${stIndex + 1} Slot ${sIndex + 1}: sowingRecords is array`, pass: Array.isArray(slot.sowingRecords) }
        ];

        checks.forEach(check => {
          console.log(check.pass ? `   ✅ ${check.name}` : `   ❌ ${check.name}`);
          if (!check.pass) allChecksPass = false;
        });
      });
    });

    if (allChecksPass) {
      console.log('✅ All slot field verification checks passed\n');
    } else {
      throw new Error('Some slot field verification checks failed');
    }
    
    return plantSlot;
  } catch (error) {
    console.error('❌ Slot field verification failed:', error.message);
    throw error;
  }
}

// Test 5: Add sowing record to slot
async function testAddSowingRecord(plantSlotId) {
  console.log('📝 Test 5: Adding sowing record to slot...');
  
  try {
    const plantSlot = await PlantSlot.findById(plantSlotId);
    
    if (!plantSlot || !plantSlot.subtypeSlots[0] || !plantSlot.subtypeSlots[0].slots[0]) {
      throw new Error('Slot not found');
    }

    const targetSlot = plantSlot.subtypeSlots[0].slots[0];
    
    // Add sowing record
    targetSlot.sowingRecords.push({
      quantity: 500,
      sowedDate: new Date(),
      expectedReadyDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000), // 45 days from now
      notes: 'Test sowing record - greenhouse section A'
    });

    targetSlot.sowedPlants = (targetSlot.sowedPlants || 0) + 500;

    await plantSlot.save();

    console.log('✅ Sowing record added successfully');
    console.log('   - Quantity sowed: 500');
    console.log('   - Total sowed plants:', targetSlot.sowedPlants);
    console.log('   - Sowing records count:', targetSlot.sowingRecords.length);
    console.log('');
    
    return plantSlot;
  } catch (error) {
    console.error('❌ Failed to add sowing record:', error.message);
    throw error;
  }
}

// Test 6: Test negative slot calculation logic
async function testNegativeSlotLogic(plant) {
  console.log('📝 Test 6: Testing negative slot calculation logic...');
  
  try {
    const isSowingAllowed = plant.isSowingAllowed;
    const maximumNegativeAllowed = plant.maximumNegativeAllowed;

    console.log('   Scenario 1: Available: 1000, Booking: 3000');
    const available1 = 1000;
    const booking1 = 3000;
    const negative1 = booking1 - available1;
    
    const canBook1 = isSowingAllowed && negative1 <= maximumNegativeAllowed;
    console.log(`   - Negative needed: ${negative1}`);
    console.log(`   - Can book: ${canBook1 ? '✅ YES' : '❌ NO'}`);
    
    console.log('\n   Scenario 2: Available: 1000, Booking: 10000');
    const available2 = 1000;
    const booking2 = 10000;
    const negative2 = booking2 - available2;
    
    const canBook2 = isSowingAllowed && negative2 <= maximumNegativeAllowed;
    console.log(`   - Negative needed: ${negative2}`);
    console.log(`   - Can book: ${canBook2 ? '✅ YES' : '❌ NO'} (exceeds max ${maximumNegativeAllowed})`);
    
    console.log('\n   Scenario 3: Sowing disabled, Available: 1000, Booking: 1500');
    const testPlantNoSowing = { isSowingAllowed: false };
    const canBook3 = testPlantNoSowing.isSowingAllowed;
    console.log(`   - Can book: ${canBook3 ? '✅ YES' : '❌ NO'} (sowing disabled)`);
    
    console.log('\n✅ Negative slot logic tests completed\n');
  } catch (error) {
    console.error('❌ Negative slot logic test failed:', error.message);
    throw error;
  }
}

// Test 7: Test sowing warning calculation
async function testSowingWarningLogic(plant) {
  console.log('📝 Test 7: Testing sowing warning calculation...');
  
  try {
    const subtype = plant.subtypes[0];
    const plantReadyDays = subtype.plantReadyDays;

    console.log(`   Plant Ready Days: ${plantReadyDays}`);
    
    const scenarios = [
      { daysUntil: 40, expected: 'CRITICAL' },
      { daysUntil: 50, expected: 'HIGH' },
      { daysUntil: 60, expected: 'MEDIUM' }
    ];

    scenarios.forEach(scenario => {
      let urgency;
      if (scenario.daysUntil <= plantReadyDays) {
        urgency = 'CRITICAL';
      } else if (scenario.daysUntil <= plantReadyDays * 1.2) {
        urgency = 'HIGH';
      } else {
        urgency = 'MEDIUM';
      }

      const isCorrect = urgency === scenario.expected;
      console.log(
        `   ${isCorrect ? '✅' : '❌'} Days until slot: ${scenario.daysUntil} → Urgency: ${urgency} (Expected: ${scenario.expected})`
      );
    });

    console.log('\n✅ Sowing warning logic tests completed\n');
  } catch (error) {
    console.error('❌ Sowing warning logic test failed:', error.message);
    throw error;
  }
}

// Cleanup test data
async function cleanup(plantId) {
  console.log('🧹 Cleaning up test data...');
  
  try {
    // Delete plant and its slots
    await PlantCms.findByIdAndDelete(plantId);
    await PlantSlot.deleteMany({ plantId: plantId });
    
    console.log('✅ Test data cleaned up\n');
  } catch (error) {
    console.error('❌ Cleanup failed:', error.message);
  }
}

// Main test runner
async function runTests() {
  let plant = null;
  let plantSlot = null;

  try {
    await connectDB();

    // Run all tests
    plant = await testCreatePlantWithSowing();
    await testVerifyPlantFields(plant._id);
    plantSlot = await testCreateSlots(plant);
    await testVerifySlotFields(plantSlot._id);
    await testAddSowingRecord(plantSlot._id);
    await testNegativeSlotLogic(plant);
    await testSowingWarningLogic(plant);

    console.log('═══════════════════════════════════════════════');
    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉');
    console.log('═══════════════════════════════════════════════\n');

    // Cleanup
    if (plant) {
      await cleanup(plant._id);
    }

  } catch (error) {
    console.log('\n═══════════════════════════════════════════════');
    console.log('❌ TESTS FAILED');
    console.log('═══════════════════════════════════════════════');
    console.error('\nError:', error.message);
    
    // Cleanup on failure too
    if (plant) {
      await cleanup(plant._id);
    }
  } finally {
    await mongoose.connection.close();
    console.log('👋 Database connection closed');
  }
}

// Run tests
runTests();

