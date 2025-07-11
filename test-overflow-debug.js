const mongoose = require('mongoose');
const { updateSlot } = require('./controllers/factory.controller');

// Connect to database
mongoose.connect('mongodb+srv://vivekpatel:vivekpatel@cluster0.5ek3d.mongodb.net/nursery?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function testOverflowFunctionality() {
  try {
    console.log('Testing overflow functionality...');
    
    // Test 1: Regular call without overflow (should fail if not enough plants)
    console.log('\n--- Test 1: Regular call (should respect capacity) ---');
    try {
      await updateSlot(
        'bookingSlot123', // Replace with actual slot ID
        10, // plantsNeeded
        'subtract'
      );
      console.log('✓ Regular call succeeded');
    } catch (error) {
      console.log('✗ Regular call failed (expected):', error.message);
    }
    
    // Test 2: Call with overflow allowed (should succeed even with 0 capacity)
    console.log('\n--- Test 2: Call with overflow allowed ---');
    try {
      await updateSlot(
        'bookingSlot123', // Replace with actual slot ID
        10, // plantsNeeded
        'subtract',
        true // allowOverflow
      );
      console.log('✓ Overflow call succeeded');
    } catch (error) {
      console.log('✗ Overflow call failed:', error.message);
    }
    
  } catch (error) {
    console.error('Test error:', error);
  } finally {
    mongoose.connection.close();
  }
}

testOverflowFunctionality(); 