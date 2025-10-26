import mongoose from "mongoose";
import State from "../models/state.model.js";
import dotenv from "dotenv";

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

// Complete list of all 36 districts of Maharashtra
const maharashtraDistricts = [
  { name: "Ahmednagar", code: "AHM" },
  { name: "Akola", code: "AKO" },
  { name: "Amravati", code: "AMR" },
  { name: "Aurangabad", code: "AUR" },
  { name: "Beed", code: "BEE" },
  { name: "Bhandara", code: "BHA" },
  { name: "Buldhana", code: "BUL" },
  { name: "Chandrapur", code: "CHA" },
  { name: "Dhule", code: "DHU" },
  { name: "Gadchiroli", code: "GAD" },
  { name: "Gondia", code: "GON" },
  { name: "Hingoli", code: "HIN" },
  { name: "Jalgaon", code: "JAL" },
  { name: "Jalna", code: "JALN" },
  { name: "Kolhapur", code: "KOL" },
  { name: "Latur", code: "LAT" },
  { name: "Mumbai City", code: "MUM_C" },
  { name: "Mumbai Suburban", code: "MUM_S" },
  { name: "Nagpur", code: "NAG" },
  { name: "Nanded", code: "NAN" },
  { name: "Nandurbar", code: "NANB" },
  { name: "Nashik", code: "NAS" },
  { name: "Osmanabad", code: "OSM" },
  { name: "Palghar", code: "PAL" },
  { name: "Parbhani", code: "PAR" },
  { name: "Pune", code: "PUN" },
  { name: "Raigad", code: "RAI" },
  { name: "Ratnagiri", code: "RAT" },
  { name: "Sangli", code: "SAN" },
  { name: "Satara", code: "SAT" },
  { name: "Sindhudurg", code: "SIN" },
  { name: "Solapur", code: "SOL" },
  { name: "Thane", code: "THA" },
  { name: "Wardha", code: "WAR" },
  { name: "Washim", code: "WAS" },
  { name: "Yavatmal", code: "YAV" }
];

// Function to generate sample talukas for a district
const generateTalukasForDistrict = (districtName, districtCode) => {
  const talukaCount = Math.floor(Math.random() * 4) + 2; // 2-5 talukas per district
  const talukas = [];
  
  for (let i = 1; i <= talukaCount; i++) {
    const villageCount = Math.floor(Math.random() * 6) + 3; // 3-8 villages per taluka
    const villages = [];
    
    for (let j = 1; j <= villageCount; j++) {
      villages.push({
        name: `${districtName} Taluka ${i} Village ${j}`,
        code: `${districtCode}_T${i}_V${j}`
      });
    }
    
    talukas.push({
      name: `${districtName} Taluka ${i}`,
      code: `${districtCode}_T${i}`,
      villages: villages
    });
  }
  
  return talukas;
};

// Function to update Maharashtra with all districts
const updateMaharashtraWithAllDistricts = async () => {
  try {
    console.log("Updating Maharashtra with all 36 districts...");
    
    // Find Maharashtra state
    const maharashtra = await State.findOne({ name: "Maharashtra" });
    
    if (!maharashtra) {
      console.error("Maharashtra state not found!");
      return;
    }
    
    console.log(`Current districts in Maharashtra: ${maharashtra.districts.length}`);
    
    // Create comprehensive districts data
    const comprehensiveDistricts = maharashtraDistricts.map(district => ({
      name: district.name,
      code: district.code,
      talukas: generateTalukasForDistrict(district.name, district.code)
    }));
    
    // Update Maharashtra with all districts
    maharashtra.districts = comprehensiveDistricts;
    await maharashtra.save();
    
    console.log(`✅ Updated Maharashtra with ${comprehensiveDistricts.length} districts`);
    
    // Calculate totals
    const totalTalukas = comprehensiveDistricts.reduce((acc, d) => acc + d.talukas.length, 0);
    const totalVillages = comprehensiveDistricts.reduce((acc, d) => acc + d.talukas.reduce((acc2, t) => acc2 + t.villages.length, 0), 0);
    
    console.log(`📊 Maharashtra Statistics:`);
    console.log(`- Districts: ${comprehensiveDistricts.length}`);
    console.log(`- Talukas: ${totalTalukas}`);
    console.log(`- Villages: ${totalVillages}`);
    
    // List all districts
    console.log(`\n📋 All Maharashtra Districts:`);
    comprehensiveDistricts.forEach((district, index) => {
      console.log(`${index + 1}. ${district.name} (${district.code}) - ${district.talukas.length} talukas`);
    });
    
  } catch (error) {
    console.error("Error updating Maharashtra:", error);
    throw error;
  }
};

// Function to test the updated data
const testUpdatedMaharashtra = async () => {
  try {
    console.log("\n🧪 Testing updated Maharashtra data...");
    
    const maharashtra = await State.findOne({ name: "Maharashtra" });
    
    if (maharashtra) {
      console.log(`Maharashtra now has ${maharashtra.districts.length} districts`);
      
      // Test a few sample districts
      const sampleDistricts = maharashtra.districts.slice(0, 5);
      console.log("\nSample districts:");
      sampleDistricts.forEach(district => {
        const talukasCount = district.talukas.length;
        const villagesCount = district.talukas.reduce((acc, t) => acc + t.villages.length, 0);
        console.log(`- ${district.name}: ${talukasCount} talukas, ${villagesCount} villages`);
      });
    }
    
  } catch (error) {
    console.error("Error testing data:", error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await updateMaharashtraWithAllDistricts();
    await testUpdatedMaharashtra();
    await mongoose.disconnect();
    console.log("\n✅ Maharashtra districts update completed successfully!");
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

export { updateMaharashtraWithAllDistricts };
