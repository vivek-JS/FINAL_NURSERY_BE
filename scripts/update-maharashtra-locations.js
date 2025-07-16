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

// Function to generate code from name
const generateCode = (name) => {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
};

// Function to process Maharashtra data
const processMaharashtraData = async () => {
  try {
    // Read the Maharashtra.json file
    const filePath = path.join(process.cwd(), 'deployment', 'Maharashtra.json');
    const rawData = fs.readFileSync(filePath, 'utf8');
    const maharashtraData = JSON.parse(rawData);

    console.log("📖 Reading Maharashtra location data...");
    console.log(`Found ${maharashtraData.districts.length} districts`);

    // Transform the data to match our schema
    const transformedData = {
      name: "Maharashtra",
      code: "MH",
      districts: []
    };

    let totalTalukas = 0;
    let totalVillages = 0;

    for (const districtData of maharashtraData.districts) {
      const district = {
        name: districtData.district,
        code: generateCode(districtData.district),
        talukas: []
      };

      if (districtData.subDistricts && Array.isArray(districtData.subDistricts)) {
        for (const talukaData of districtData.subDistricts) {
          const taluka = {
            name: talukaData.subDistrict,
            code: generateCode(talukaData.subDistrict),
            villages: []
          };

          if (talukaData.villages && Array.isArray(talukaData.villages)) {
            for (const villageName of talukaData.villages) {
              taluka.villages.push({
                name: villageName,
                code: generateCode(villageName)
              });
            }
            totalVillages += talukaData.villages.length;
          }

          district.talukas.push(taluka);
          totalTalukas++;
        }
      }

      transformedData.districts.push(district);
    }

    console.log(`📊 Processed data summary:`);
    console.log(`   - Districts: ${transformedData.districts.length}`);
    console.log(`   - Talukas: ${totalTalukas}`);
    console.log(`   - Villages: ${totalVillages}`);

    // Check if Maharashtra state already exists
    let maharashtraState = await State.findOne({ name: "Maharashtra" });

    if (maharashtraState) {
      // Update existing state
      console.log("🔄 Updating existing Maharashtra state...");
      maharashtraState.districts = transformedData.districts;
      await maharashtraState.save();
      console.log("✅ Maharashtra state updated successfully!");
    } else {
      // Create new state
      console.log("🆕 Creating new Maharashtra state...");
      maharashtraState = new State(transformedData);
      await maharashtraState.save();
      console.log("✅ Maharashtra state created successfully!");
    }

    // Log detailed summary
    console.log("\n📋 Detailed Summary:");
    for (const district of transformedData.districts) {
      const districtTalukas = district.talukas.length;
      const districtVillages = district.talukas.reduce((sum, taluka) => sum + taluka.villages.length, 0);
      console.log(`   ${district.name}: ${districtTalukas} talukas, ${districtVillages} villages`);
    }

    console.log("\n🎉 Maharashtra location data update completed successfully!");
    return transformedData;

  } catch (error) {
    console.error("❌ Error processing Maharashtra data:", error);
    throw error;
  }
};

// Function to validate the data
const validateData = (data) => {
  console.log("🔍 Validating data...");
  
  let isValid = true;
  let issues = [];

  for (const district of data.districts) {
    if (!district.name || !district.code) {
      issues.push(`District missing name or code: ${JSON.stringify(district)}`);
      isValid = false;
    }

    for (const taluka of district.talukas) {
      if (!taluka.name || !taluka.code) {
        issues.push(`Taluka missing name or code in district ${district.name}: ${JSON.stringify(taluka)}`);
        isValid = false;
      }

      for (const village of taluka.villages) {
        if (!village.name || !village.code) {
          issues.push(`Village missing name or code in taluka ${taluka.name}, district ${district.name}: ${JSON.stringify(village)}`);
          isValid = false;
        }
      }
    }
  }

  if (!isValid) {
    console.error("❌ Data validation failed:");
    issues.forEach(issue => console.error(`   - ${issue}`));
  } else {
    console.log("✅ Data validation passed!");
  }

  return isValid;
};

const main = async () => {
  try {
    await connectDB();
    
    console.log("🚀 Starting Maharashtra location data update...");
    
    const processedData = await processMaharashtraData();
    
    // Validate the processed data
    if (!validateData(processedData)) {
      console.error("❌ Data validation failed. Exiting...");
      process.exit(1);
    }

    console.log("\n🎯 Update completed successfully!");
    console.log("📈 Database now contains complete Maharashtra location data");
    
    process.exit(0);
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
};

// Run the script
main(); 