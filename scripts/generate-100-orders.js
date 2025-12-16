import mongoose from 'mongoose';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwiam9iVGl0bGUiOiJPRkZJQ0VfQURNSU4iLCJuYW1lIjoiU3VwZXIgQWRtaW4iLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNzY1Nzc0ODIyLCJleHAiOjE3NjU4NjEyMjIsImF1ZCI6Im51cnNlcnktdXNlcnMiLCJpc3MiOiJudXJzZXJ5LWFwcCJ9.lQYWa_QWtaUbTAucZllh43audqmTHgNxBoPqxYWaoH8';

// Connect to MongoDB (only for plants, slots, etc.)
await mongoose.connect(MONGODB_URI);
console.log('✅ Connected to MongoDB');

// Import models (not using Farmer model - will fetch from API)
const { default: PlantCms } = await import('../models/plantCms.model.js');
const { default: PlantSlot } = await import('../models/slots.model.js');
const { default: Tray } = await import('../models/tray.model.js');
const { default: User } = await import('../models/user.model.js');

// Helper function to get random element from array
const getRandomElement = (array) => array[Math.floor(Math.random() * array.length)];

// Helper function to get random number between min and max
const getRandomNumber = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Helper function to generate random date in a month
const getRandomDateInMonth = (year, month) => {
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = getRandomNumber(1, daysInMonth);
  const hour = getRandomNumber(9, 18);
  const minute = getRandomNumber(0, 59);
  return new Date(year, month - 1, day, hour, minute, 0);
};

// Helper function to format date for API
const formatDateForAPI = (date) => {
  return date.toISOString();
};

// Fetch all required data
console.log('\n📊 Fetching data from API and database...');

// Fetch farmers from API
let farmers = [];
try {
  const farmersResponse = await axios.get(
    `${API_BASE_URL}/api/v1/farmer/getFarmers`,
    {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 second timeout
      validateStatus: function (status) {
        return status < 500; // Don't throw for 4xx errors
      }
    }
  );
  
  // Check if request was successful
  if (farmersResponse.status >= 400) {
    throw new Error(`API returned status ${farmersResponse.status}: ${farmersResponse.data?.message || 'Unknown error'}`);
  }
  
  // Handle different response formats - API returns {status, message, data}
  if (farmersResponse.data) {
    if (Array.isArray(farmersResponse.data)) {
      farmers = farmersResponse.data;
    } else if (farmersResponse.data.data && Array.isArray(farmersResponse.data.data)) {
      farmers = farmersResponse.data.data;
    } else if (farmersResponse.data.status === 'success' && Array.isArray(farmersResponse.data.data)) {
      farmers = farmersResponse.data.data;
    }
  }
  console.log(`✅ Found ${farmers.length} farmers from API`);
} catch (error) {
  const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
  console.error('❌ Error fetching farmers from API:', errorMsg);
  if (error.code === 'ECONNREFUSED') {
    console.error('   Connection refused. Is the API server running on', API_BASE_URL, '?');
  } else if (error.code === 'ETIMEDOUT') {
    console.error('   Request timed out.');
  } else if (error.response) {
    console.error('   Response status:', error.response.status);
    if (error.response.data) {
      console.error('   Response data:', JSON.stringify(error.response.data).substring(0, 300));
    }
  } else if (error.request) {
    console.error('   No response received. Request made but no response.');
    console.error('   Error code:', error.code);
  }
  console.error('   Trying to continue with database query...');
  
  // Fallback to database query
  try {
    const { default: Farmer } = await import('../models/farmer.model.js');
    farmers = await Farmer.find({}).limit(200).lean();
    console.log(`✅ Found ${farmers.length} farmers from database`);
  } catch (dbError) {
    console.error('❌ Database query also failed:', dbError.message);
    farmers = [];
  }
}

if (farmers.length === 0) {
  console.error('❌ No farmers found. Please add farmers first.');
  process.exit(1);
}

// Fetch plants from API
let plants = [];
let allSubtypes = [];
try {
  const plantsResponse = await axios.get(
    `${API_BASE_URL}/api/v1/plantcms/plants`,
    {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Accept': 'application/json',
      },
    }
  );
  
  if (plantsResponse.data && plantsResponse.data.data) {
    plants = Array.isArray(plantsResponse.data.data) 
      ? plantsResponse.data.data 
      : (plantsResponse.data.data.data || []);
  }
  console.log(`✅ Found ${plants.length} plants from API`);
  
  // Get all subtypes from all plants
  plants.forEach(plant => {
    if (plant.subtypes && plant.subtypes.length > 0) {
      plant.subtypes.forEach(subtype => {
        allSubtypes.push({
          plantId: plant._id || plant.id,
          plantName: plant.name,
          subtypeId: subtype._id || subtype.id,
          subtypeName: subtype.name,
        });
      });
    }
  });
  console.log(`✅ Found ${allSubtypes.length} plant subtypes`);
} catch (error) {
  console.error('❌ Error fetching plants from API:', error.response?.data || error.message);
  console.error('   Trying to continue with database query...');
  
  // Fallback to database query
  plants = await PlantCms.find({}).lean();
  console.log(`✅ Found ${plants.length} plants from database`);
  
  // Get all subtypes from all plants
  plants.forEach(plant => {
    if (plant.subtypes && plant.subtypes.length > 0) {
      plant.subtypes.forEach(subtype => {
        allSubtypes.push({
          plantId: plant._id,
          plantName: plant.name,
          subtypeId: subtype._id,
          subtypeName: subtype.name,
        });
      });
    }
  });
  console.log(`✅ Found ${allSubtypes.length} plant subtypes`);
}

if (plants.length === 0) {
  console.error('❌ No plants found. Please add plants first.');
  process.exit(1);
}

if (allSubtypes.length === 0) {
  console.error('❌ No plant subtypes found. Please add plant subtypes first.');
  process.exit(1);
}

// Fetch sales persons from API
let salesPersons = [];
try {
  const salesResponse = await axios.get(
    `${API_BASE_URL}/api/v1/user/allusers`,
    {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  
  // Handle response format: {status, message, data: [...]}
  if (salesResponse.data && salesResponse.data.data && Array.isArray(salesResponse.data.data)) {
    // Filter for sales persons (DEALER, SALES role, or jobTitle: SALES)
    salesPersons = salesResponse.data.data.filter(user => 
      (user.role === 'DEALER' || user.role === 'SALES' || user.role === 'SALES_PERSON') ||
      user.jobTitle === 'SALES'
    );
  }
  console.log(`✅ Found ${salesPersons.length} sales persons from API`);
} catch (error) {
  console.error('❌ Error fetching sales persons from API:', error.response?.data?.message || error.message);
  console.error('   Trying to continue with database query...');
  
  // Fallback to database query
  salesPersons = await User.find({ 
    role: { $in: ['SALES_PERSON', 'DEALER', 'OFFICE_ADMIN', 'SUPER_ADMIN'] } 
  }).limit(50).lean();
  console.log(`✅ Found ${salesPersons.length} sales persons from database`);
}

if (salesPersons.length === 0) {
  // Try to get any user as fallback
  const anyUser = await User.findOne({}).lean();
  if (anyUser) {
    salesPersons.push(anyUser);
    console.log(`⚠️  Using fallback user: ${anyUser.name || anyUser._id}`);
  } else {
    console.error('❌ No sales persons found. Please add sales persons first.');
    process.exit(1);
  }
}

// Fetch slots from API for each plant/subtype combination
let slots = [];
try {
  // Get slots for each plant/subtype combination from our allSubtypes
  const slotPromises = allSubtypes.map(async (subtype) => {
    try {
      const slotsResponse = await axios.get(
        `${API_BASE_URL}/api/v1/slots/getslots`,
        {
          params: {
            plantId: subtype.plantId,
            subtypeId: subtype.subtypeId,
            year: 2025, // Get slots for 2025
          },
          headers: {
            'Authorization': `Bearer ${AUTH_TOKEN}`,
            'Accept': 'application/json',
          },
          timeout: 15000, // Increased timeout
        }
      );
      
      // API returns: { slots: [{ slots: [{ _id: ... }] }] }
      if (slotsResponse.data && slotsResponse.data.slots) {
        const slotData = Array.isArray(slotsResponse.data.slots) 
          ? slotsResponse.data.slots 
          : [];
        
        // Extract slots from nested structure
        const extractedSlots = [];
        slotData.forEach(slotGroup => {
          if (slotGroup.slots && Array.isArray(slotGroup.slots)) {
            slotGroup.slots.forEach(slot => {
              if (slot._id) {
                extractedSlots.push({
                  _id: slot._id,
                  plantId: subtype.plantId,
                  subtypeId: subtype.subtypeId,
                  startDay: slot.startDay,
                  endDay: slot.endDay,
                });
              }
            });
          }
        });
        
        return extractedSlots;
      }
      return [];
    } catch (error) {
      // Silently skip errors for individual subtypes
      return [];
    }
  });
  
  const slotArrays = await Promise.all(slotPromises);
  slots = slotArrays.flat();
  console.log(`✅ Found ${slots.length} booking slots from API`);
} catch (error) {
  console.error('❌ Error fetching slots from API:', error.message);
  console.error('   Trying to continue with database query...');
  
  // Fallback to database query
  slots = await PlantSlot.find({}).lean();
  console.log(`✅ Found ${slots.length} booking slots from database`);
}

if (slots.length === 0) {
  console.warn('⚠️  No booking slots found. Will use a default slot ID if provided.');
  // Use a default slot ID from the example curl (if it exists)
  slots = [{ _id: '6923004ddba45a54eba6fa05' }]; // From the example curl
  console.log('⚠️  Using default slot ID from example');
}

let cavities = await Tray.find({}).limit(50).lean();
console.log(`✅ Found ${cavities.length} cavities/trays`);

if (cavities.length === 0) {
  console.warn('⚠️  No cavities found. Will use a default cavity ID if provided.');
  // Use a default cavity ID from the example curl (if it exists)
  cavities = [{ _id: '688f4d33198b3cd86a8ee267' }]; // From the example curl
  console.log('⚠️  Using default cavity ID from example');
}

// Define date ranges
const dateRanges = [
  { year: 2025, month: 12, name: 'December 2025' },
  { year: 2026, month: 1, name: 'January 2026' },
  { year: 2026, month: 2, name: 'February 2026' },
  { year: 2026, month: 3, name: 'March 2026' },
];

// Payment statuses
const paymentStatuses = ['not paid', 'partially paid', 'paid'];
const orderStatuses = ['ACCEPTED', 'PENDING', 'PROCESSING'];

// Rate ranges for different plants (you can adjust these)
const rateRanges = {
  default: { min: 1.5, max: 3.5 },
  tomato: { min: 2.0, max: 3.0 },
  chilli: { min: 1.8, max: 2.8 },
  brinjal: { min: 2.2, max: 3.2 },
};

// Generate 100 orders
console.log('\n🚀 Generating 100 orders...\n');

const orders = [];
let successCount = 0;
let errorCount = 0;

for (let i = 1; i <= 100; i++) {
  try {
    // Select random data
    const farmer = getRandomElement(farmers);
    const subtypeData = getRandomElement(allSubtypes);
    const salesPerson = getRandomElement(salesPersons);
    
    // Find slots for this specific plant/subtype combination
    let availableSlots = slots.filter(slot => 
      (slot.plantId && slot.plantId.toString() === subtypeData.plantId.toString()) ||
      (!slot.plantId) // Include slots without plantId filter
    );
    
    // If no specific slots found, use any slot
    if (availableSlots.length === 0) {
      availableSlots = slots;
    }
    
    const slot = getRandomElement(availableSlots);
    const cavity = cavities.length > 0 ? getRandomElement(cavities) : null;
    
    // Random plant quantity between 1000 and 45000
    const numberOfPlants = getRandomNumber(1000, 45000);
    
    // Random rate based on plant type
    const plantNameLower = subtypeData.plantName.toLowerCase();
    let rateRange = rateRanges.default;
    if (plantNameLower.includes('tomato')) rateRange = rateRanges.tomato;
    else if (plantNameLower.includes('chilli')) rateRange = rateRanges.chilli;
    else if (plantNameLower.includes('brinjal')) rateRange = rateRanges.brinjal;
    
    const rate = parseFloat((Math.random() * (rateRange.max - rateRange.min) + rateRange.min).toFixed(2));
    
    // Random date from one of the months
    const dateRange = getRandomElement(dateRanges);
    const orderDate = getRandomDateInMonth(dateRange.year, dateRange.month);
    let deliveryDate = getRandomDateInMonth(dateRange.year, dateRange.month);
    
    // Ensure delivery date is after order date (at least 1 day later)
    if (deliveryDate <= orderDate) {
      deliveryDate = new Date(orderDate);
      deliveryDate.setDate(deliveryDate.getDate() + getRandomNumber(1, 60));
    }
    
    const paymentStatus = getRandomElement(paymentStatuses);
    const orderStatus = getRandomElement(orderStatuses);
    
    // Prepare order data
    const orderData = {
      name: farmer.name,
      village: farmer.village || 'Abit Khind',
      taluka: farmer.taluka || 'Akola',
      state: farmer.state || 'Maharashtra',
      district: farmer.district || 'Ahmadnagar',
      stateName: farmer.stateName || 'Maharashtra',
      districtName: farmer.districtName || 'Ahmadnagar',
      talukaName: farmer.talukaName || 'Akola',
      mobileNumber: (farmer.mobileNumber?.toString() || farmer.mobileNumber || `9${getRandomNumber(100000000, 999999999)}`),
      typeOfPlants: '',
      numberOfPlants: numberOfPlants.toString(),
      rate: rate.toString(),
      paymentStatus: paymentStatus,
      salesPerson: (salesPerson._id || salesPerson.id || salesPerson).toString(),
      orderStatus: orderStatus,
      plantName: subtypeData.plantId.toString(),
      plantSubtype: subtypeData.subtypeId.toString(),
      bookingSlot: slot._id.toString(),
      cavity: cavity ? cavity._id.toString() : (cavities.length > 0 ? getRandomElement(cavities)._id.toString() : '688f4d33198b3cd86a8ee267'),
      orderDate: formatDateForAPI(orderDate),
      deliveryDate: formatDateForAPI(deliveryDate),
      orderPaymentStatus: paymentStatus === 'paid' ? 'COMPLETED' : 'PENDING',
      orderBookingDate: formatDateForAPI(orderDate),
    };
    
    // Make API call
    const response = await axios.post(
      `${API_BASE_URL}/api/v1/farmer/createFarmer`,
      orderData,
      {
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    
    if (response.data && (response.data.status === 'success' || response.data.status === 'Success')) {
      successCount++;
      console.log(`✅ Order ${i}/100 created - ${farmer.name} - ${numberOfPlants} ${subtypeData.plantName} ${subtypeData.subtypeName} - ${dateRange.name}`);
    } else {
      errorCount++;
      console.log(`❌ Order ${i}/100 failed - ${response.data?.message || 'Unknown error'}`);
    }
    
    // Small delay to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 100));
    
  } catch (error) {
    errorCount++;
    console.log(`❌ Order ${i}/100 failed - ${error.response?.data?.message || error.message}`);
  }
}

console.log('\n📊 Summary:');
console.log(`✅ Successfully created: ${successCount} orders`);
console.log(`❌ Failed: ${errorCount} orders`);
console.log(`📈 Total: ${successCount + errorCount} orders attempted`);

// Close MongoDB connection
await mongoose.disconnect();
console.log('\n✅ Disconnected from MongoDB');
process.exit(0);

