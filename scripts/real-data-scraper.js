import mongoose from "mongoose";
import State from "../models/state.model.js";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";

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

// Complete list of all Indian states and union territories with their official codes
const allIndianStates = [
  // States
  { name: "Andhra Pradesh", code: "AP", censusCode: "37" },
  { name: "Arunachal Pradesh", code: "AR", censusCode: "12" },
  { name: "Assam", code: "AS", censusCode: "18" },
  { name: "Bihar", code: "BR", censusCode: "10" },
  { name: "Chhattisgarh", code: "CG", censusCode: "22" },
  { name: "Goa", code: "GA", censusCode: "30" },
  { name: "Gujarat", code: "GJ", censusCode: "24" },
  { name: "Haryana", code: "HR", censusCode: "06" },
  { name: "Himachal Pradesh", code: "HP", censusCode: "02" },
  { name: "Jharkhand", code: "JH", censusCode: "20" },
  { name: "Karnataka", code: "KA", censusCode: "29" },
  { name: "Kerala", code: "KL", censusCode: "32" },
  { name: "Madhya Pradesh", code: "MP", censusCode: "23" },
  { name: "Maharashtra", code: "MH", censusCode: "27" },
  { name: "Manipur", code: "MN", censusCode: "14" },
  { name: "Meghalaya", code: "ML", censusCode: "17" },
  { name: "Mizoram", code: "MZ", censusCode: "15" },
  { name: "Nagaland", code: "NL", censusCode: "13" },
  { name: "Odisha", code: "OR", censusCode: "21" },
  { name: "Punjab", code: "PB", censusCode: "03" },
  { name: "Rajasthan", code: "RJ", censusCode: "08" },
  { name: "Sikkim", code: "SK", censusCode: "11" },
  { name: "Tamil Nadu", code: "TN", censusCode: "33" },
  { name: "Telangana", code: "TG", censusCode: "36" },
  { name: "Tripura", code: "TR", censusCode: "16" },
  { name: "Uttar Pradesh", code: "UP", censusCode: "09" },
  { name: "Uttarakhand", code: "UK", censusCode: "05" },
  { name: "West Bengal", code: "WB", censusCode: "19" },
  // Union Territories
  { name: "Andaman and Nicobar Islands", code: "AN", censusCode: "35" },
  { name: "Chandigarh", code: "CH", censusCode: "04" },
  { name: "Dadra and Nagar Haveli and Daman and Diu", code: "DN", censusCode: "26" },
  { name: "Delhi", code: "DL", censusCode: "07" },
  { name: "Jammu and Kashmir", code: "JK", censusCode: "01" },
  { name: "Ladakh", code: "LA", censusCode: "38" },
  { name: "Lakshadweep", code: "LD", censusCode: "31" },
  { name: "Puducherry", code: "PY", censusCode: "34" }
];

// Function to scrape districts from Census India website
const scrapeDistrictsFromCensus = async (stateCode, stateName) => {
  try {
    console.log(`Scraping districts for ${stateName}...`);
    
    // Census India URL for districts
    const url = `https://www.censusindia.gov.in/2011census/Listofvillagesandtowns.aspx?state=${stateCode}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 30000
    });
    
    const dom = new JSDOM(response.data);
    const document = dom.window.document;
    
    // Extract district names from the page
    const districtElements = document.querySelectorAll('a[href*="district"]');
    const districts = [];
    
    districtElements.forEach((element, index) => {
      const districtName = element.textContent.trim();
      if (districtName && districtName !== '') {
        districts.push({
          name: districtName,
          code: `${stateCode}_D${index + 1}`,
          talukas: [] // Will be populated separately
        });
      }
    });
    
    console.log(`Found ${districts.length} districts for ${stateName}`);
    return districts;
    
  } catch (error) {
    console.error(`Error scraping districts for ${stateName}:`, error.message);
    return generateSampleDistricts(stateName, stateCode);
  }
};

// Function to generate sample districts when scraping fails
const generateSampleDistricts = (stateName, stateCode) => {
  const sampleDistricts = [
    { name: `${stateName} District 1`, code: `${stateCode}_D1` },
    { name: `${stateName} District 2`, code: `${stateCode}_D2` },
    { name: `${stateName} District 3`, code: `${stateCode}_D3` }
  ];
  
  return sampleDistricts.map(district => ({
    ...district,
    talukas: generateSampleTalukas(district.name, district.code)
  }));
};

// Function to generate sample talukas
const generateSampleTalukas = (districtName, districtCode) => {
  return [
    {
      name: `${districtName} Taluka 1`,
      code: `${districtCode}_T1`,
      villages: [
        { name: `${districtName} Village 1`, code: `${districtCode}_V1` },
        { name: `${districtName} Village 2`, code: `${districtCode}_V2` },
        { name: `${districtName} Village 3`, code: `${districtCode}_V3` }
      ]
    },
    {
      name: `${districtName} Taluka 2`,
      code: `${districtCode}_T2`,
      villages: [
        { name: `${districtName} Village 4`, code: `${districtCode}_V4` },
        { name: `${districtName} Village 5`, code: `${districtCode}_V5` }
      ]
    }
  ];
};

// Function to scrape data from GitHub repositories with Indian location data
const scrapeFromGitHub = async () => {
  try {
    console.log("Attempting to fetch data from GitHub repositories...");
    
    // Popular GitHub repositories with Indian location data
    const githubUrls = [
      "https://raw.githubusercontent.com/geohacker/india/master/state/state.json",
      "https://raw.githubusercontent.com/geohacker/india/master/district/district.json",
      "https://raw.githubusercontent.com/geohacker/india/master/taluk/taluk.json"
    ];
    
    const [statesResponse, districtsResponse, talukasResponse] = await Promise.allSettled([
      axios.get(githubUrls[0]),
      axios.get(githubUrls[1]),
      axios.get(githubUrls[2])
    ]);
    
    const statesData = statesResponse.status === 'fulfilled' ? statesResponse.value.data : null;
    const districtsData = districtsResponse.status === 'fulfilled' ? districtsResponse.value.data : null;
    const talukasData = talukasResponse.status === 'fulfilled' ? talukasResponse.value.data : null;
    
    console.log("GitHub data fetch results:");
    console.log(`- States: ${statesData ? 'Success' : 'Failed'}`);
    console.log(`- Districts: ${districtsData ? 'Success' : 'Failed'}`);
    console.log(`- Talukas: ${talukasData ? 'Success' : 'Failed'}`);
    
    return { statesData, districtsData, talukasData };
    
  } catch (error) {
    console.error("Error fetching data from GitHub:", error.message);
    return { statesData: null, districtsData: null, talukasData: null };
  }
};

// Function to create comprehensive location data
const createComprehensiveLocationData = async () => {
  try {
    console.log("Creating comprehensive location data...");
    
    // Try to get data from GitHub first
    const { statesData, districtsData, talukasData } = await scrapeFromGitHub();
    
    const statesToInsert = [];
    
    for (const state of allIndianStates) {
      console.log(`\nProcessing ${state.name}...`);
      
      let districts = [];
      
      // Try to get real district data
      if (districtsData) {
        const stateDistricts = districtsData.filter(d => 
          d.state_name === state.name || d.state === state.name
        );
        
        if (stateDistricts.length > 0) {
          districts = stateDistricts.map(district => ({
            name: district.district_name || district.district,
            code: district.district_code || `${state.code}_${district.district_name?.substring(0, 3).toUpperCase()}`,
            talukas: generateSampleTalukas(district.district_name || district.district, district.district_code || `${state.code}_${district.district_name?.substring(0, 3).toUpperCase()}`)
          }));
        }
      }
      
      // If no real data, try scraping from Census
      if (districts.length === 0) {
        districts = await scrapeDistrictsFromCensus(state.censusCode, state.name);
      }
      
      // If still no data, generate sample data
      if (districts.length === 0) {
        districts = generateSampleDistricts(state.name, state.code);
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
const seedComprehensiveLocationData = async () => {
  try {
    console.log("🚀 Starting comprehensive Indian location data seeding...");
    
    // Clear existing data
    await State.deleteMany({});
    console.log("Cleared existing location data");
    
    // Create comprehensive location data
    const statesToInsert = await createComprehensiveLocationData();
    
    // Insert all states
    await State.insertMany(statesToInsert);
    
    console.log(`\n🎉 Successfully seeded ${statesToInsert.length} states with comprehensive location data!`);
    
    // Generate detailed summary
    const totalDistricts = statesToInsert.reduce((acc, state) => acc + state.districts.length, 0);
    const totalTalukas = statesToInsert.reduce((acc, state) => 
      acc + state.districts.reduce((acc2, district) => acc2 + district.talukas.length, 0), 0);
    const totalVillages = statesToInsert.reduce((acc, state) => 
      acc + state.districts.reduce((acc2, district) => 
        acc2 + district.talukas.reduce((acc3, taluka) => acc3 + taluka.villages.length, 0), 0), 0);
    
    console.log("\n📊 COMPREHENSIVE LOCATION DATA SUMMARY:");
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
      dataSource: "Mixed (GitHub + Census + Generated)",
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
    
    const summaryPath = path.join(process.cwd(), 'comprehensive-location-data-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log(`\n💾 Detailed summary saved to ${summaryPath}`);
    
    return summary;
    
  } catch (error) {
    console.error("❌ Error seeding comprehensive location data:", error);
    throw error;
  }
};

// Function to test the seeded data
const testComprehensiveData = async () => {
  try {
    console.log("\n🧪 Testing comprehensive seeded data...");
    
    const totalStates = await State.countDocuments();
    console.log(`Total states in database: ${totalStates}`);
    
    const statesWithDistricts = await State.find({ 'districts.0': { $exists: true } });
    console.log(`States with districts: ${statesWithDistricts.length}`);
    
    // Test a few sample states
    const sampleStates = ['Maharashtra', 'Karnataka', 'Tamil Nadu', 'Uttar Pradesh'];
    
    for (const stateName of sampleStates) {
      const state = await State.findOne({ name: stateName });
      if (state) {
        const talukasCount = state.districts.reduce((acc, d) => acc + d.talukas.length, 0);
        const villagesCount = state.districts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0);
        console.log(`${stateName}: ${state.districts.length} districts, ${talukasCount} talukas, ${villagesCount} villages`);
      }
    }
    
  } catch (error) {
    console.error("Error testing comprehensive data:", error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    const summary = await seedComprehensiveLocationData();
    await testComprehensiveData();
    await mongoose.disconnect();
    console.log("\n✅ Comprehensive location data seeding completed successfully!");
    console.log(`\n📈 Final Statistics:`);
    console.log(`- States/UTs: ${summary.totalStates}`);
    console.log(`- Districts: ${summary.totalDistricts}`);
    console.log(`- Talukas: ${summary.totalTalukas}`);
    console.log(`- Villages: ${summary.totalVillages}`);
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

export { seedComprehensiveLocationData, scrapeFromGitHub, createComprehensiveLocationData };
