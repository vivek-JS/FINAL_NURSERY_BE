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

// Function to create backup
const createBackup = async () => {
  try {
    console.log("📦 Creating backup of current location data...");
    
    const states = await State.find({}).lean();
    
    if (states.length === 0) {
      console.log("⚠️  No states found in database");
      return null;
    }

    const backupDir = path.join(process.cwd(), 'deployment', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `locations-backup-${timestamp}.json`);

    fs.writeFileSync(backupPath, JSON.stringify(states, null, 2));
    
    console.log(`✅ Backup created at: ${backupPath}`);
    return backupPath;
  } catch (error) {
    console.error("❌ Error creating backup:", error);
    throw error;
  }
};

// Function to process Maharashtra data
const processMaharashtraData = async () => {
  try {
    const filePath = path.join(process.cwd(), 'deployment', 'Maharashtra.json');
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Maharashtra.json file not found at: ${filePath}`);
    }
    
    const rawData = fs.readFileSync(filePath, 'utf8');
    const maharashtraData = JSON.parse(rawData);

    console.log("📖 Reading Maharashtra location data...");
    console.log(`Found ${maharashtraData.districts.length} districts`);

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

    return transformedData;
  } catch (error) {
    console.error("❌ Error processing Maharashtra data:", error);
    throw error;
  }
};

// Function to update Maharashtra in database
const updateMaharashtraInDB = async (transformedData) => {
  try {
    let maharashtraState = await State.findOne({ name: "Maharashtra" });

    if (maharashtraState) {
      console.log("🔄 Updating existing Maharashtra state...");
      maharashtraState.districts = transformedData.districts;
      await maharashtraState.save();
      console.log("✅ Maharashtra state updated successfully!");
    } else {
      console.log("🆕 Creating new Maharashtra state...");
      maharashtraState = new State(transformedData);
      await maharashtraState.save();
      console.log("✅ Maharashtra state created successfully!");
    }

    return maharashtraState;
  } catch (error) {
    console.error("❌ Error updating Maharashtra in database:", error);
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

// Function to verify the update
const verifyUpdate = async () => {
  try {
    console.log("🔍 Verifying the update...");
    
    const maharashtraState = await State.findOne({ name: "Maharashtra" });
    
    if (!maharashtraState) {
      console.error("❌ Maharashtra state not found after update!");
      return false;
    }

    console.log(`✅ Maharashtra state found with ${maharashtraState.districts.length} districts`);
    
    let totalTalukas = 0;
    let totalVillages = 0;
    
    for (const district of maharashtraState.districts) {
      totalTalukas += district.talukas.length;
      for (const taluka of district.talukas) {
        totalVillages += taluka.villages.length;
      }
    }
    
    console.log(`📊 Verification Summary:`);
    console.log(`   - Districts: ${maharashtraState.districts.length}`);
    console.log(`   - Talukas: ${totalTalukas}`);
    console.log(`   - Villages: ${totalVillages}`);
    
    return true;
  } catch (error) {
    console.error("❌ Error during verification:", error);
    return false;
  }
};

// Function to log detailed summary
const logDetailedSummary = (data) => {
  console.log("\n📋 Detailed Summary:");
  for (const district of data.districts) {
    const districtTalukas = district.talukas.length;
    const districtVillages = district.talukas.reduce((sum, taluka) => sum + taluka.villages.length, 0);
    console.log(`   ${district.name}: ${districtTalukas} talukas, ${districtVillages} villages`);
  }
};

const main = async () => {
  try {
    console.log("🚀 Starting comprehensive location data update process...");
    
    await connectDB();
    
    // Step 1: Create backup
    const backupPath = await createBackup();
    
    // Step 2: Process Maharashtra data
    const processedData = await processMaharashtraData();
    
    // Step 3: Validate data
    if (!validateData(processedData)) {
      console.error("❌ Data validation failed. Exiting...");
      process.exit(1);
    }
    
    // Step 4: Update database
    await updateMaharashtraInDB(processedData);
    
    // Step 5: Verify update
    const verificationSuccess = await verifyUpdate();
    
    if (!verificationSuccess) {
      console.error("❌ Verification failed. Update may not have been successful.");
      process.exit(1);
    }
    
    // Step 6: Log detailed summary
    logDetailedSummary(processedData);
    
    console.log("\n🎉 Complete location data update process finished successfully!");
    console.log("📈 Database now contains complete Maharashtra location data");
    
    if (backupPath) {
      console.log(`💾 Backup available at: ${backupPath}`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
};

// Run the script
main(); 