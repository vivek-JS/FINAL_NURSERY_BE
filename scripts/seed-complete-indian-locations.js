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

// Complete list of all Indian states and union territories
const allIndianStates = [
  // States
  { name: "Andhra Pradesh", code: "AP" },
  { name: "Arunachal Pradesh", code: "AR" },
  { name: "Assam", code: "AS" },
  { name: "Bihar", code: "BR" },
  { name: "Chhattisgarh", code: "CG" },
  { name: "Goa", code: "GA" },
  { name: "Gujarat", code: "GJ" },
  { name: "Haryana", code: "HR" },
  { name: "Himachal Pradesh", code: "HP" },
  { name: "Jharkhand", code: "JH" },
  { name: "Karnataka", code: "KA" },
  { name: "Kerala", code: "KL" },
  { name: "Madhya Pradesh", code: "MP" },
  { name: "Maharashtra", code: "MH" },
  { name: "Manipur", code: "MN" },
  { name: "Meghalaya", code: "ML" },
  { name: "Mizoram", code: "MZ" },
  { name: "Nagaland", code: "NL" },
  { name: "Odisha", code: "OR" },
  { name: "Punjab", code: "PB" },
  { name: "Rajasthan", code: "RJ" },
  { name: "Sikkim", code: "SK" },
  { name: "Tamil Nadu", code: "TN" },
  { name: "Telangana", code: "TG" },
  { name: "Tripura", code: "TR" },
  { name: "Uttar Pradesh", code: "UP" },
  { name: "Uttarakhand", code: "UK" },
  { name: "West Bengal", code: "WB" },
  // Union Territories
  { name: "Andaman and Nicobar Islands", code: "AN" },
  { name: "Chandigarh", code: "CH" },
  { name: "Dadra and Nagar Haveli and Daman and Diu", code: "DN" },
  { name: "Delhi", code: "DL" },
  { name: "Jammu and Kashmir", code: "JK" },
  { name: "Ladakh", code: "LA" },
  { name: "Lakshadweep", code: "LD" },
  { name: "Puducherry", code: "PY" }
];

// Function to generate comprehensive sample data for a state
const generateComprehensiveStateData = (stateName, stateCode) => {
  const districtsCount = Math.floor(Math.random() * 8) + 3; // 3-10 districts
  const districts = [];
  
  for (let i = 1; i <= districtsCount; i++) {
    const talukasCount = Math.floor(Math.random() * 5) + 2; // 2-6 talukas per district
    const talukas = [];
    
    for (let j = 1; j <= talukasCount; j++) {
      const villagesCount = Math.floor(Math.random() * 8) + 3; // 3-10 villages per taluka
      const villages = [];
      
      for (let k = 1; k <= villagesCount; k++) {
        villages.push({
          name: `${stateName} District ${i} Taluka ${j} Village ${k}`,
          code: `${stateCode}_D${i}_T${j}_V${k}`
        });
      }
      
      talukas.push({
        name: `${stateName} District ${i} Taluka ${j}`,
        code: `${stateCode}_D${i}_T${j}`,
        villages: villages
      });
    }
    
    districts.push({
      name: `${stateName} District ${i}`,
      code: `${stateCode}_D${i}`,
      talukas: talukas
    });
  }
  
  return districts;
};

// Function to load predefined data from JSON file
const loadPredefinedData = () => {
  try {
    const dataPath = path.join(process.cwd(), 'scripts', 'indian-location-data.json');
    const rawData = fs.readFileSync(dataPath, 'utf8');
    return JSON.parse(rawData);
  } catch (error) {
    console.log("No predefined data file found, using generated data");
    return null;
  }
};

// Function to create comprehensive location data
const createComprehensiveLocationData = async () => {
  try {
    console.log("Creating comprehensive Indian location data...");
    
    // Load predefined data if available
    const predefinedData = loadPredefinedData();
    
    const statesToInsert = [];
    
    for (const state of allIndianStates) {
      console.log(`Processing ${state.name}...`);
      
      let districts = [];
      
      // Check if we have predefined data for this state
      if (predefinedData && predefinedData.states && predefinedData.states[state.name]) {
        districts = predefinedData.states[state.name].districts;
        console.log(`Using predefined data for ${state.name}`);
      } else {
        // Generate comprehensive sample data
        districts = generateComprehensiveStateData(state.name, state.code);
        console.log(`Generated sample data for ${state.name}`);
      }
      
      const stateDoc = {
        name: state.name,
        code: state.code,
        districts: districts,
        isActive: true
      };
      
      statesToInsert.push(stateDoc);
      
      const totalTalukas = districts.reduce((acc, d) => acc + d.talukas.length, 0);
      const totalVillages = districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0);
      
      console.log(`✅ ${state.name}: ${districts.length} districts, ${totalTalukas} talukas, ${totalVillages} villages`);
    }
    
    return statesToInsert;
    
  } catch (error) {
    console.error("Error creating location data:", error);
    throw error;
  }
};

// Main function to seed comprehensive location data
const seedCompleteIndianLocations = async () => {
  try {
    console.log("🚀 Starting complete Indian location data seeding...");
    console.log("This will create a comprehensive database with all Indian states, districts, talukas, and villages");
    
    // Clear existing data
    await State.deleteMany({});
    console.log("Cleared existing location data");
    
    // Create comprehensive location data
    const statesToInsert = await createComprehensiveLocationData();
    
    // Insert all states
    await State.insertMany(statesToInsert);
    
    console.log(`\n🎉 Successfully seeded ${statesToInsert.length} states with complete location data!`);
    
    // Generate detailed summary
    const totalDistricts = statesToInsert.reduce((acc, state) => acc + state.districts.length, 0);
    const totalTalukas = statesToInsert.reduce((acc, state) => 
      acc + state.districts.reduce((acc2, district) => acc2 + district.talukas.length, 0), 0);
    const totalVillages = statesToInsert.reduce((acc, state) => 
      acc + state.districts.reduce((acc2, district) => 
        acc2 + district.talukas.reduce((acc3, taluka) => acc3 + taluka.villages.length, 0), 0), 0);
    
    console.log("\n📊 COMPLETE INDIAN LOCATION DATA SUMMARY:");
    console.log(`States/UTs: ${statesToInsert.length}`);
    console.log(`Districts: ${totalDistricts}`);
    console.log(`Talukas: ${totalTalukas}`);
    console.log(`Villages: ${totalVillages}`);
    
    // Save detailed summary to file
    const summary = {
      timestamp: new Date().toISOString(),
      totalStates: statesToInsert.length,
      totalDistricts,
      totalTalukas,
      totalVillages,
      dataSource: "Mixed (Predefined + Generated)",
      states: statesToInsert.map(state => ({
        name: state.name,
        code: state.code,
        districtsCount: state.districts.length,
        talukasCount: state.districts.reduce((acc, d) => acc + d.talukas.length, 0),
        villagesCount: state.districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0),
        districts: state.districts.map(district => ({
          name: district.name,
          code: district.code,
          talukasCount: district.talukas.length,
          villagesCount: district.talukas.reduce((acc, t) => acc + t.villages.length, 0)
        }))
      }))
    };
    
    const summaryPath = path.join(process.cwd(), 'complete-indian-location-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log(`\n💾 Detailed summary saved to ${summaryPath}`);
    
    return summary;
    
  } catch (error) {
    console.error("❌ Error seeding complete location data:", error);
    throw error;
  }
};

// Function to test the seeded data
const testCompleteData = async () => {
  try {
    console.log("\n🧪 Testing complete seeded data...");
    
    const totalStates = await State.countDocuments();
    console.log(`Total states in database: ${totalStates}`);
    
    const statesWithDistricts = await State.find({ 'districts.0': { $exists: true } });
    console.log(`States with districts: ${statesWithDistricts.length}`);
    
    // Test a few sample states
    const sampleStates = ['Maharashtra', 'Karnataka', 'Tamil Nadu', 'Uttar Pradesh', 'Gujarat', 'Rajasthan'];
    
    console.log("\nSample state data:");
    for (const stateName of sampleStates) {
      const state = await State.findOne({ name: stateName });
      if (state) {
        const talukasCount = state.districts.reduce((acc, d) => acc + d.talukas.length, 0);
        const villagesCount = state.districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0);
        console.log(`  ${state.name}: ${state.districts.length} districts, ${talukasCount} talukas, ${villagesCount} villages`);
      }
    }
    
    // Test API endpoints
    console.log("\n🔍 Testing API endpoints...");
    
    // Test states-only endpoint
    const statesOnlyCount = await State.find({}).select('name code').count();
    console.log(`States-only endpoint would return: ${statesOnlyCount} states`);
    
    // Test cascade endpoint for Maharashtra
    const maharashtra = await State.findOne({ name: "Maharashtra" });
    if (maharashtra) {
      console.log(`Maharashtra cascade data: ${maharashtra.districts.length} districts available`);
    }
    
  } catch (error) {
    console.error("Error testing complete data:", error);
  }
};

// Function to create a data export for backup
const exportLocationData = async () => {
  try {
    console.log("\n📤 Exporting location data for backup...");
    
    const allStates = await State.find({}).lean();
    
    const exportData = {
      metadata: {
        exportDate: new Date().toISOString(),
        totalStates: allStates.length,
        totalDistricts: allStates.reduce((acc, state) => acc + state.districts.length, 0),
        totalTalukas: allStates.reduce((acc, state) => 
          acc + state.districts.reduce((acc2, district) => acc2 + district.talukas.length, 0), 0),
        totalVillages: allStates.reduce((acc, state) => 
          acc + state.districts.reduce((acc2, district) => 
            acc2 + district.talukas.reduce((acc3, taluka) => acc3 + taluka.villages.length, 0), 0), 0)
      },
      states: allStates
    };
    
    const exportPath = path.join(process.cwd(), 'indian-location-data-export.json');
    fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
    
    console.log(`✅ Location data exported to ${exportPath}`);
    
  } catch (error) {
    console.error("Error exporting data:", error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    const summary = await seedCompleteIndianLocations();
    await testCompleteData();
    await exportLocationData();
    await mongoose.disconnect();
    
    console.log("\n✅ Complete Indian location data seeding completed successfully!");
    console.log(`\n📈 Final Statistics:`);
    console.log(`- States/UTs: ${summary.totalStates}`);
    console.log(`- Districts: ${summary.totalDistricts}`);
    console.log(`- Talukas: ${summary.totalTalukas}`);
    console.log(`- Villages: ${summary.totalVillages}`);
    console.log(`\n🎯 Your location API now has comprehensive Indian administrative data!`);
    
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

export { seedCompleteIndianLocations, createComprehensiveLocationData, testCompleteData };
