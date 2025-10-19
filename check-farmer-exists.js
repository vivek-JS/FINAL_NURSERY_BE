import mongoose from 'mongoose';
import Farmer from './models/farmer.model.js';

// Connect to MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/nursery';

async function checkFarmer() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');
    
    const mobileNumber = 1221122333;
    console.log(`\nSearching for farmer with mobile: ${mobileNumber}`);
    
    const farmer = await Farmer.findOne({ mobileNumber });
    
    if (farmer) {
      console.log('\n✅ Farmer EXISTS:');
      console.log('Name:', farmer.name);
      console.log('Mobile:', farmer.mobileNumber);
      console.log('Village:', farmer.village);
      console.log('ID:', farmer._id);
    } else {
      console.log('\n❌ Farmer NOT FOUND with this mobile number');
    }
    
    // Also search by name
    console.log('\n\nSearching for farmers named "vasudev patil"...');
    const farmersByName = await Farmer.find({ 
      name: { $regex: /vasudev/i } 
    });
    
    if (farmersByName.length > 0) {
      console.log(`\nFound ${farmersByName.length} farmer(s):`);
      farmersByName.forEach((f, idx) => {
        console.log(`\n${idx + 1}. Name: ${f.name}`);
        console.log(`   Mobile: ${f.mobileNumber}`);
        console.log(`   ID: ${f._id}`);
      });
    } else {
      console.log('No farmers found with name "vasudev"');
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

checkFarmer();

