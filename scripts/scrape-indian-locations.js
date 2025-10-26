import mongoose from "mongoose";
import State from "../models/state.model.js";
import dotenv from "dotenv";
import axios from "axios";
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

// Sample data for major states (this would be replaced with actual scraping)
const sampleLocationData = {
  "Maharashtra": {
    districts: [
      {
        name: "Pune",
        code: "PUN",
        talukas: [
          {
            name: "Pune City",
            code: "PUN_CITY",
            villages: [
              { name: "Koregaon Park", code: "KP" },
              { name: "Camp", code: "CAMP" },
              { name: "Deccan", code: "DECCAN" },
              { name: "Kalyani Nagar", code: "KN" },
              { name: "Viman Nagar", code: "VN" }
            ]
          },
          {
            name: "Haveli",
            code: "HAVELI",
            villages: [
              { name: "Hadapsar", code: "HAD" },
              { name: "Manjri", code: "MANJ" },
              { name: "Phursungi", code: "PHUR" },
              { name: "Uruli Kanchan", code: "URULI" },
              { name: "Loni Kalbhor", code: "LONI" }
            ]
          }
        ]
      },
      {
        name: "Mumbai",
        code: "MUM",
        talukas: [
          {
            name: "Mumbai City",
            code: "MUM_CITY",
            villages: [
              { name: "Colaba", code: "COL" },
              { name: "Marine Lines", code: "ML" },
              { name: "Nariman Point", code: "NP" },
              { name: "Fort", code: "FORT" },
              { name: "CST", code: "CST" }
            ]
          }
        ]
      }
    ]
  },
  "Karnataka": {
    districts: [
      {
        name: "Bangalore Urban",
        code: "BLR_URB",
        talukas: [
          {
            name: "Bangalore North",
            code: "BLR_N",
            villages: [
              { name: "Hebbal", code: "HEB" },
              { name: "Yelahanka", code: "YEL" },
              { name: "Doddaballapur", code: "DBP" }
            ]
          }
        ]
      }
    ]
  },
  "Tamil Nadu": {
    districts: [
      {
        name: "Chennai",
        code: "CHN",
        talukas: [
          {
            name: "Chennai Central",
            code: "CHN_C",
            villages: [
              { name: "T. Nagar", code: "TN" },
              { name: "Mylapore", code: "MYL" },
              { name: "Adyar", code: "ADY" }
            ]
          }
        ]
      }
    ]
  }
};

// Function to generate sample data for states that don't have detailed data
const generateSampleDataForState = (stateName) => {
  const sampleDistricts = [
    { name: `${stateName} District 1`, code: `${stateName.substring(0, 3).toUpperCase()}_D1` },
    { name: `${stateName} District 2`, code: `${stateName.substring(0, 3).toUpperCase()}_D2` },
    { name: `${stateName} District 3`, code: `${stateName.substring(0, 3).toUpperCase()}_D3` }
  ];

  return {
    districts: sampleDistricts.map(district => ({
      ...district,
      talukas: [
        {
          name: `${district.name} Taluka 1`,
          code: `${district.code}_T1`,
          villages: [
            { name: `${district.name} Village 1`, code: `${district.code}_V1` },
            { name: `${district.name} Village 2`, code: `${district.code}_V2` },
            { name: `${district.name} Village 3`, code: `${district.code}_V3` }
          ]
        },
        {
          name: `${district.name} Taluka 2`,
          code: `${district.code}_T2`,
          villages: [
            { name: `${district.name} Village 4`, code: `${district.code}_V4` },
            { name: `${district.name} Village 5`, code: `${district.code}_V5` }
          ]
        }
      ]
    }))
  };
};

// Function to scrape data from external sources (placeholder for now)
const scrapeLocationData = async (stateName) => {
  try {
    // This is where you would implement actual scraping logic
    // For now, we'll use sample data
    console.log(`Scraping data for ${stateName}...`);
    
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Return sample data or scraped data
    return sampleLocationData[stateName] || generateSampleDataForState(stateName);
  } catch (error) {
    console.error(`Error scraping data for ${stateName}:`, error);
    return generateSampleDataForState(stateName);
  }
};

// Function to validate and clean location data
const validateLocationData = (data) => {
  const cleaned = {
    districts: data.districts?.map(district => ({
      name: district.name?.trim() || "Unknown District",
      code: district.code?.trim().toUpperCase() || "UNK",
      talukas: district.talukas?.map(taluka => ({
        name: taluka.name?.trim() || "Unknown Taluka",
        code: taluka.code?.trim().toUpperCase() || "UNK",
        villages: taluka.villages?.map(village => ({
          name: village.name?.trim() || "Unknown Village",
          code: village.code?.trim().toUpperCase() || "UNK"
        })) || []
      })) || []
    })) || []
  };
  
  return cleaned;
};

// Main function to seed all location data
const seedAllLocationData = async () => {
  try {
    console.log("Starting comprehensive location data seeding...");
    
    // Clear existing data
    await State.deleteMany({});
    console.log("Cleared existing location data");
    
    const statesToInsert = [];
    
    for (const state of allIndianStates) {
      console.log(`Processing ${state.name}...`);
      
      // Scrape or generate data for this state
      const locationData = await scrapeLocationData(state.name);
      
      // Validate and clean the data
      const cleanedData = validateLocationData(locationData);
      
      // Create state document
      const stateDoc = {
        name: state.name,
        code: state.code,
        districts: cleanedData.districts,
        isActive: true
      };
      
      statesToInsert.push(stateDoc);
      
      console.log(`✅ ${state.name}: ${cleanedData.districts.length} districts, ${cleanedData.districts.reduce((acc, d) => acc + d.talukas.length, 0)} talukas, ${cleanedData.districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0)} villages`);
    }
    
    // Insert all states
    await State.insertMany(statesToInsert);
    
    console.log(`\n🎉 Successfully seeded ${statesToInsert.length} states with complete location data!`);
    
    // Generate summary report
    const totalDistricts = statesToInsert.reduce((acc, state) => acc + state.districts.length, 0);
    const totalTalukas = statesToInsert.reduce((acc, state) => 
      acc + state.districts.reduce((acc2, district) => acc2 + district.talukas.length, 0), 0);
    const totalVillages = statesToInsert.reduce((acc, state) => 
      acc + state.districts.reduce((acc2, district) => 
        acc2 + district.talukas.reduce((acc3, taluka) => acc3 + taluka.villages.length, 0), 0), 0);
    
    console.log("\n📊 LOCATION DATA SUMMARY:");
    console.log(`States/UTs: ${statesToInsert.length}`);
    console.log(`Districts: ${totalDistricts}`);
    console.log(`Talukas: ${totalTalukas}`);
    console.log(`Villages: ${totalVillages}`);
    
    // Save summary to file
    const summary = {
      timestamp: new Date().toISOString(),
      totalStates: statesToInsert.length,
      totalDistricts,
      totalTalukas,
      totalVillages,
      states: statesToInsert.map(state => ({
        name: state.name,
        code: state.code,
        districtsCount: state.districts.length,
        talukasCount: state.districts.reduce((acc, d) => acc + d.talukas.length, 0),
        villagesCount: state.districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0)
      }))
    };
    
    fs.writeFileSync(
      path.join(process.cwd(), 'location-data-summary.json'),
      JSON.stringify(summary, null, 2)
    );
    
    console.log("\n💾 Summary saved to location-data-summary.json");
    
  } catch (error) {
    console.error("❌ Error seeding location data:", error);
    throw error;
  }
};

// Function to test the seeded data
const testSeededData = async () => {
  try {
    console.log("\n🧪 Testing seeded data...");
    
    const totalStates = await State.countDocuments();
    console.log(`Total states in database: ${totalStates}`);
    
    const statesWithDistricts = await State.find({ 'districts.0': { $exists: true } });
    console.log(`States with districts: ${statesWithDistricts.length}`);
    
    const sampleState = await State.findOne({ name: "Maharashtra" });
    if (sampleState) {
      console.log(`\nMaharashtra sample data:`);
      console.log(`- Districts: ${sampleState.districts.length}`);
      console.log(`- Talukas: ${sampleState.districts.reduce((acc, d) => acc + d.talukas.length, 0)}`);
      console.log(`- Villages: ${sampleState.districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0)}`);
    }
    
  } catch (error) {
    console.error("Error testing data:", error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await seedAllLocationData();
    await testSeededData();
    await mongoose.disconnect();
    console.log("\n✅ Location data seeding completed successfully!");
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

export { seedAllLocationData, scrapeLocationData, validateLocationData };
