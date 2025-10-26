import mongoose from "mongoose";
import State from "../models/state.model.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};

// Function to load the comprehensive Indian location data
const loadCompleteIndianData = () => {
  try {
    const dataPath = path.join(process.cwd(), '..', 'nursery-mgmt', 'src', 'newstate.js');
    console.log(`Loading data from: ${dataPath}`);
    
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const locationData = JSON.parse(rawData);
    
    console.log(`Loaded ${locationData.length} states/UTs from file`);
    return locationData;
  } catch (error) {
    console.error("Error loading complete Indian data:", error);
    throw error;
  }
};

// Function to convert the data format to match our State model
const convertToStateModel = (rawData) => {
  const states = [];
  
  for (const stateData of rawData) {
    const state = {
      name: stateData.state,
      code: generateStateCode(stateData.state),
      districts: [],
      isActive: true
    };
    
    // Convert districts
    for (const districtData of stateData.districts) {
      const district = {
        name: districtData.district,
        code: generateDistrictCode(districtData.district, state.code),
        talukas: []
      };
      
      // Convert sub-districts to talukas
      for (const subDistrictData of districtData.subDistricts) {
        const taluka = {
          name: subDistrictData.subDistrict,
          code: generateTalukaCode(subDistrictData.subDistrict, district.code),
          villages: []
        };
        
        // Convert villages
        for (const villageName of subDistrictData.villages) {
          if (villageName && villageName.trim() !== '') {
            taluka.villages.push({
              name: villageName.trim(),
              code: generateVillageCode(villageName, taluka.code)
            });
          }
        }
        
        district.talukas.push(taluka);
      }
      
      state.districts.push(district);
    }
    
    states.push(state);
  }
  
  return states;
};

// Function to generate state codes
const generateStateCode = (stateName) => {
  const stateCodeMap = {
    "Andaman & Nicobar Islands": "AN",
    "Andhra Pradesh": "AP",
    "Arunachal Pradesh": "AR",
    "Assam": "AS",
    "Bihar": "BR",
    "Chhattisgarh": "CG",
    "Goa": "GA",
    "Gujarat": "GJ",
    "Haryana": "HR",
    "Himachal Pradesh": "HP",
    "Jharkhand": "JH",
    "Karnataka": "KA",
    "Kerala": "KL",
    "Madhya Pradesh": "MP",
    "Maharashtra": "MH",
    "Manipur": "MN",
    "Meghalaya": "ML",
    "Mizoram": "MZ",
    "Nagaland": "NL",
    "Odisha": "OR",
    "Punjab": "PB",
    "Rajasthan": "RJ",
    "Sikkim": "SK",
    "Tamil Nadu": "TN",
    "Telangana": "TG",
    "Tripura": "TR",
    "Uttar Pradesh": "UP",
    "Uttarakhand": "UK",
    "West Bengal": "WB",
    "Chandigarh": "CH",
    "Dadra & Nagar Haveli": "DN",
    "Daman & Diu": "DD",
    "Delhi": "DL",
    "Jammu & Kashmir": "JK",
    "Ladakh": "LA",
    "Lakshadweep": "LD",
    "Puducherry": "PY"
  };
  
  return stateCodeMap[stateName] || stateName.substring(0, 2).toUpperCase();
};

// Function to generate district codes
const generateDistrictCode = (districtName, stateCode) => {
  const words = districtName.split(' ');
  if (words.length === 1) {
    return `${stateCode}_${words[0].substring(0, 3).toUpperCase()}`;
  } else {
    return `${stateCode}_${words.map(w => w.substring(0, 2)).join('').toUpperCase()}`;
  }
};

// Function to generate taluka codes
const generateTalukaCode = (talukaName, districtCode) => {
  const words = talukaName.split(' ');
  if (words.length === 1) {
    return `${districtCode}_${words[0].substring(0, 3).toUpperCase()}`;
  } else {
    return `${districtCode}_${words.map(w => w.substring(0, 2)).join('').toUpperCase()}`;
  }
};

// Function to generate village codes
const generateVillageCode = (villageName, talukaCode) => {
  if (!villageName || villageName === null || villageName === undefined) {
    return `${talukaCode}_UNK`;
  }
  
  const words = villageName.toString().split(' ');
  if (words.length === 1) {
    return `${talukaCode}_${words[0].substring(0, 3).toUpperCase()}`;
  } else {
    return `${talukaCode}_${words.map(w => w.substring(0, 2)).join('').toUpperCase()}`;
  }
};

// Function to import complete Indian location data
const importCompleteIndianData = async () => {
  try {
    console.log("🚀 Starting import of complete Indian location data...");
    
    // Load the comprehensive data
    const rawData = loadCompleteIndianData();
    
    // Convert to our model format
    console.log("Converting data to State model format...");
    const states = convertToStateModel(rawData);
    
    console.log(`Converted ${states.length} states with complete location hierarchy`);
    
    // Clear existing data
    console.log("Clearing existing location data...");
    await State.deleteMany({});
    
    // Insert all states
    console.log("Inserting complete location data...");
    await State.insertMany(states);
    
    // Generate statistics
    const totalDistricts = states.reduce((acc, state) => acc + state.districts.length, 0);
    const totalTalukas = states.reduce((acc, state) => 
      acc + state.districts.reduce((acc2, district) => acc2 + district.talukas.length, 0), 0);
    const totalVillages = states.reduce((acc, state) => 
      acc + state.districts.reduce((acc2, district) => 
        acc2 + district.talukas.reduce((acc3, taluka) => acc3 + taluka.villages.length, 0), 0), 0);
    
    console.log("\n🎉 Complete Indian location data imported successfully!");
    console.log("\n📊 COMPREHENSIVE STATISTICS:");
    console.log(`States/UTs: ${states.length}`);
    console.log(`Districts: ${totalDistricts}`);
    console.log(`Talukas: ${totalTalukas}`);
    console.log(`Villages: ${totalVillages}`);
    
    // Save summary
    const summary = {
      timestamp: new Date().toISOString(),
      totalStates: states.length,
      totalDistricts,
      totalTalukas,
      totalVillages,
      dataSource: "Complete Indian Location Dataset (newstate.js)",
      states: states.map(state => ({
        name: state.name,
        code: state.code,
        districtsCount: state.districts.length,
        talukasCount: state.districts.reduce((acc, d) => acc + d.talukas.length, 0),
        villagesCount: state.districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0)
      }))
    };
    
    const summaryPath = path.join(process.cwd(), 'complete-indian-import-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log(`\n💾 Summary saved to ${summaryPath}`);
    
    return summary;
    
  } catch (error) {
    console.error("❌ Error importing complete Indian data:", error);
    throw error;
  }
};

// Function to test the imported data
const testImportedData = async () => {
  try {
    console.log("\n🧪 Testing imported data...");
    
    const totalStates = await State.countDocuments();
    console.log(`Total states in database: ${totalStates}`);
    
    // Test a few sample states
    const sampleStates = ['Maharashtra', 'Karnataka', 'Tamil Nadu', 'Uttar Pradesh', 'Gujarat'];
    
    console.log("\nSample state data:");
    for (const stateName of sampleStates) {
      const state = await State.findOne({ name: stateName });
      if (state) {
        const talukasCount = state.districts.reduce((acc, d) => acc + d.talukas.length, 0);
        const villagesCount = state.districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0);
        console.log(`  ${state.name}: ${state.districts.length} districts, ${talukasCount} talukas, ${villagesCount} villages`);
      }
    }
    
    // Test Maharashtra specifically
    const maharashtra = await State.findOne({ name: "Maharashtra" });
    if (maharashtra) {
      console.log(`\nMaharashtra details:`);
      console.log(`- Districts: ${maharashtra.districts.length}`);
      console.log(`- Sample districts: ${maharashtra.districts.slice(0, 5).map(d => d.name).join(', ')}`);
    }
    
  } catch (error) {
    console.error("Error testing imported data:", error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    const summary = await importCompleteIndianData();
    await testImportedData();
    await mongoose.disconnect();
    
    console.log("\n✅ Complete Indian location data import completed successfully!");
    console.log(`\n📈 Final Statistics:`);
    console.log(`- States/UTs: ${summary.totalStates}`);
    console.log(`- Districts: ${summary.totalDistricts}`);
    console.log(`- Talukas: ${summary.totalTalukas}`);
    console.log(`- Villages: ${summary.totalVillages}`);
    console.log(`\n🎯 Your location API now has the most comprehensive Indian location data available!`);
    
    process.exit(0);
  } catch (error) {
    console.error("❌ Error in main execution:", error);
    process.exit(1);
  }
};

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { importCompleteIndianData, loadCompleteIndianData, convertToStateModel };
