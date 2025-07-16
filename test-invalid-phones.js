import mongoose from 'mongoose';
import Farmer from './models/farmer.model.js';

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

// Test function to check for invalid phone farmers
const testInvalidPhoneFarmers = async () => {
  try {
    console.log('Checking for farmers with invalid phone numbers...');
    
    const invalidFarmers = await Farmer.find({ isInvalidPhone: true });
    
    console.log(`Found ${invalidFarmers.length} farmers with invalid phone numbers:`);
    
    if (invalidFarmers.length > 0) {
      invalidFarmers.forEach((farmer, index) => {
        console.log(`${index + 1}. ${farmer.name} - Phone: ${farmer.mobileNumber} - Original: ${farmer.originalPhoneNumber}`);
      });
    } else {
      console.log('No farmers with invalid phone numbers found.');
      
      // Let's also check total farmers count
      const totalFarmers = await Farmer.countDocuments();
      console.log(`Total farmers in database: ${totalFarmers}`);
    }
    
  } catch (error) {
    console.error('Error checking invalid phone farmers:', error);
  } finally {
    mongoose.connection.close();
  }
};

// Run the test
connectDB().then(() => {
  testInvalidPhoneFarmers();
}); 