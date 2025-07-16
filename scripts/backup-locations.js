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

const backupLocations = async () => {
  try {
    console.log("📦 Creating backup of current location data...");
    
    // Get all states with their location data
    const states = await State.find({}).lean();
    
    if (states.length === 0) {
      console.log("⚠️  No states found in database");
      return;
    }

    // Create backup directory if it doesn't exist
    const backupDir = path.join(process.cwd(), 'deployment', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Create timestamp for backup filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `locations-backup-${timestamp}.json`);

    // Save backup
    fs.writeFileSync(backupPath, JSON.stringify(states, null, 2));
    
    console.log(`✅ Backup created successfully at: ${backupPath}`);
    console.log(`📊 Backup contains ${states.length} states`);
    
    // Log summary of what's in the backup
    let totalDistricts = 0;
    let totalTalukas = 0;
    let totalVillages = 0;
    
    for (const state of states) {
      const stateDistricts = state.districts?.length || 0;
      totalDistricts += stateDistricts;
      
      for (const district of state.districts || []) {
        const districtTalukas = district.talukas?.length || 0;
        totalTalukas += districtTalukas;
        
        for (const taluka of district.talukas || []) {
          const talukaVillages = taluka.villages?.length || 0;
          totalVillages += talukaVillages;
        }
      }
    }
    
    console.log(`📋 Backup Summary:`);
    console.log(`   - States: ${states.length}`);
    console.log(`   - Districts: ${totalDistricts}`);
    console.log(`   - Talukas: ${totalTalukas}`);
    console.log(`   - Villages: ${totalVillages}`);
    
    return backupPath;
  } catch (error) {
    console.error("❌ Error creating backup:", error);
    throw error;
  }
};

const main = async () => {
  try {
    await connectDB();
    await backupLocations();
    console.log("🎉 Backup process completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
};

main(); 