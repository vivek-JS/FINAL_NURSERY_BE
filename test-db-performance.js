import mongoose from 'mongoose';
import State from './models/state.model.js';

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery');
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

async function testDatabaseQueries() {
  console.log('🚀 Database Query Performance Test');
  console.log('==================================');
  
  await connectDB();
  
  // Test 1: Find state by exact name
  console.log('\n🧪 Test 1: Find state by exact name');
  const start1 = Date.now();
  const state1 = await State.findOne({ name: 'Maharashtra' }).lean();
  const duration1 = Date.now() - start1;
  console.log(`✅ Duration: ${duration1}ms`);
  console.log(`📊 Found: ${state1 ? 'Yes' : 'No'}`);
  console.log(`📈 Districts count: ${state1?.districts?.length || 0}`);
  
  // Test 2: Find state by regex (old method)
  console.log('\n🧪 Test 2: Find state by regex (old method)');
  const start2 = Date.now();
  const state2 = await State.findOne({ 
    name: { $regex: new RegExp('Maharashtra', 'i') } 
  }).lean();
  const duration2 = Date.now() - start2;
  console.log(`✅ Duration: ${duration2}ms`);
  console.log(`📊 Found: ${state2 ? 'Yes' : 'No'}`);
  
  // Test 3: Find state by case-insensitive exact match
  console.log('\n🧪 Test 3: Find state by case-insensitive exact match');
  const start3 = Date.now();
  const state3 = await State.findOne({ 
    name: { $regex: new RegExp('^Maharashtra$', 'i') } 
  }).lean();
  const duration3 = Date.now() - start3;
  console.log(`✅ Duration: ${duration3}ms`);
  console.log(`📊 Found: ${state3 ? 'Yes' : 'No'}`);
  
  // Test 4: Get all states (for comparison)
  console.log('\n🧪 Test 4: Get all states');
  const start4 = Date.now();
  const allStates = await State.find({}).select('name code').lean();
  const duration4 = Date.now() - start4;
  console.log(`✅ Duration: ${duration4}ms`);
  console.log(`📊 Total states: ${allStates.length}`);
  
  // Test 5: Count total documents
  console.log('\n🧪 Test 5: Count total documents');
  const start5 = Date.now();
  const count = await State.countDocuments();
  const duration5 = Date.now() - start5;
  console.log(`✅ Duration: ${duration5}ms`);
  console.log(`📊 Total documents: ${count}`);
  
  // Summary
  console.log('\n📋 Performance Summary');
  console.log('======================');
  console.log(`⏱️  Exact match: ${duration1}ms`);
  console.log(`⏱️  Regex match: ${duration2}ms`);
  console.log(`⏱️  Case-insensitive exact: ${duration3}ms`);
  console.log(`⏱️  Get all states: ${duration4}ms`);
  console.log(`⏱️  Count documents: ${duration5}ms`);
  
  if (duration2 > duration1) {
    const improvement = ((duration2 - duration1) / duration2 * 100).toFixed(1);
    console.log(`⚡ Exact match is ${improvement}% faster than regex`);
  }
  
  // Check if indexes exist
  console.log('\n🔍 Index Information');
  console.log('===================');
  try {
    const indexes = await State.collection.getIndexes();
    console.log('📊 Available indexes:');
    Object.keys(indexes).forEach(indexName => {
      console.log(`  - ${indexName}: ${JSON.stringify(indexes[indexName].key)}`);
    });
  } catch (error) {
    console.log('❌ Could not retrieve index information:', error.message);
  }
  
  await mongoose.disconnect();
  console.log('\n✅ Test completed');
}

testDatabaseQueries().catch(console.error); 