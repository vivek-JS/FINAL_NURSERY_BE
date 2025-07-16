import mongoose from "mongoose";
import State from "../models/state.model.js";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";

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

// Comprehensive location data for major Indian states
const locationData = {
  "Andhra Pradesh": {
    districts: [
      {
        name: "Anantapur",
        talukas: [
          { name: "Anantapur", villages: ["Anantapur", "Kadiri", "Penukonda", "Gooty", "Dharmavaram"] },
          { name: "Kadiri", villages: ["Kadiri", "Madakasira", "Hindupur", "Gorantla", "Bukkapatnam"] },
          { name: "Penukonda", villages: ["Penukonda", "Puttaparthi", "Bukkapatnam", "Somandepalle", "Roddam"] }
        ]
      },
      {
        name: "Chittoor",
        talukas: [
          { name: "Chittoor", villages: ["Chittoor", "Palamaner", "Kuppam", "Bangarupalem", "Gangadhara Nellore"] },
          { name: "Tirupati", villages: ["Tirupati", "Chandragiri", "Srikalahasti", "Vadamalapeta", "Nagari"] }
        ]
      },
      {
        name: "East Godavari",
        talukas: [
          { name: "Kakinada", villages: ["Kakinada", "Peddapuram", "Samalkot", "Pithapuram", "Yeleswaram"] },
          { name: "Rajahmundry", villages: ["Rajahmundry", "Kovvur", "Gokavaram", "Rampachodavaram", "Addateegala"] }
        ]
      }
    ]
  },
  "Karnataka": {
    districts: [
      {
        name: "Bangalore Urban",
        talukas: [
          { name: "Bangalore North", villages: ["Hebbal", "Yelahanka", "Doddaballapur", "Devanahalli", "Hoskote"] },
          { name: "Bangalore South", villages: ["Anekal", "Bangalore South", "Bangalore East", "Bangalore North", "Bangalore Central"] }
        ]
      },
      {
        name: "Mysore",
        talukas: [
          { name: "Mysore", villages: ["Mysore", "Nanjangud", "T Narasipura", "Hunsur", "Krishnarajanagara"] },
          { name: "Hunsur", villages: ["Hunsur", "Periyapatna", "Krishnarajanagara", "Nanjangud", "T Narasipura"] }
        ]
      }
    ]
  },
  "Tamil Nadu": {
    districts: [
      {
        name: "Chennai",
        talukas: [
          { name: "Chennai", villages: ["Chennai", "Tambaram", "Sriperumbudur", "Kanchipuram", "Chengalpattu"] },
          { name: "Tambaram", villages: ["Tambaram", "Maduranthakam", "Uthiramerur", "Kanchipuram", "Sriperumbudur"] }
        ]
      },
      {
        name: "Coimbatore",
        talukas: [
          { name: "Coimbatore", villages: ["Coimbatore", "Pollachi", "Tiruppur", "Erode", "Salem"] },
          { name: "Pollachi", villages: ["Pollachi", "Valparai", "Udumalpet", "Dharapuram", "Palladam"] }
        ]
      }
    ]
  },
  "Kerala": {
    districts: [
      {
        name: "Thiruvananthapuram",
        talukas: [
          { name: "Thiruvananthapuram", villages: ["Thiruvananthapuram", "Neyyattinkara", "Nedumangad", "Chirayinkeezhu", "Varkala"] },
          { name: "Neyyattinkara", villages: ["Neyyattinkara", "Parassala", "Perumkadavila", "Amaravila", "Kulathoor"] }
        ]
      },
      {
        name: "Ernakulam",
        talukas: [
          { name: "Ernakulam", villages: ["Ernakulam", "Aluva", "Kothamangalam", "Muvattupuzha", "Perumbavoor"] },
          { name: "Aluva", villages: ["Aluva", "Paravur", "Kodungallur", "North Paravur", "Eloor"] }
        ]
      }
    ]
  },
  "Gujarat": {
    districts: [
      {
        name: "Ahmedabad",
        talukas: [
          { name: "Ahmedabad City", villages: ["Ahmedabad", "Gandhinagar", "Sanand", "Dholka", "Viramgam"] },
          { name: "Sanand", villages: ["Sanand", "Dholka", "Viramgam", "Detroj", "Bavla"] }
        ]
      },
      {
        name: "Surat",
        talukas: [
          { name: "Surat City", villages: ["Surat", "Bardoli", "Vyara", "Mangrol", "Umarpada"] },
          { name: "Bardoli", villages: ["Bardoli", "Mahuva", "Palsana", "Kamrej", "Olpad"] }
        ]
      }
    ]
  },
  "Rajasthan": {
    districts: [
      {
        name: "Jaipur",
        talukas: [
          { name: "Jaipur", villages: ["Jaipur", "Amber", "Sanganer", "Bassi", "Chaksu"] },
          { name: "Sanganer", villages: ["Sanganer", "Phagi", "Chaksu", "Bassi", "Amber"] }
        ]
      },
      {
        name: "Jodhpur",
        talukas: [
          { name: "Jodhpur", villages: ["Jodhpur", "Phalodi", "Osian", "Bilara", "Shergarh"] },
          { name: "Phalodi", villages: ["Phalodi", "Osian", "Bilara", "Shergarh", "Luni"] }
        ]
      }
    ]
  },
  "Uttar Pradesh": {
    districts: [
      {
        name: "Lucknow",
        talukas: [
          { name: "Lucknow", villages: ["Lucknow", "Malihabad", "Bakshi Ka Talab", "Mohaan", "Gosainganj"] },
          { name: "Malihabad", villages: ["Malihabad", "Bakshi Ka Talab", "Mohaan", "Gosainganj", "Itaunja"] }
        ]
      },
      {
        name: "Kanpur",
        talukas: [
          { name: "Kanpur", villages: ["Kanpur", "Bilhaur", "Ghatampur", "Akbarpur", "Derapur"] },
          { name: "Bilhaur", villages: ["Bilhaur", "Ghatampur", "Akbarpur", "Derapur", "Rasoolabad"] }
        ]
      }
    ]
  },
  "Madhya Pradesh": {
    districts: [
      {
        name: "Bhopal",
        talukas: [
          { name: "Bhopal", villages: ["Bhopal", "Huzur", "Berasia", "Phanda", "Vidisha"] },
          { name: "Berasia", villages: ["Berasia", "Phanda", "Vidisha", "Gairatganj", "Raisen"] }
        ]
      },
      {
        name: "Indore",
        talukas: [
          { name: "Indore", villages: ["Indore", "Depalpur", "Mhow", "Sanwer", "Hatod"] },
          { name: "Depalpur", villages: ["Depalpur", "Mhow", "Sanwer", "Hatod", "Betma"] }
        ]
      }
    ]
  },
  "West Bengal": {
    districts: [
      {
        name: "Kolkata",
        talukas: [
          { name: "Kolkata", villages: ["Kolkata", "Howrah", "Hooghly", "North 24 Parganas", "South 24 Parganas"] },
          { name: "Howrah", villages: ["Howrah", "Uluberia", "Amta", "Domjur", "Jagatballavpur"] }
        ]
      },
      {
        name: "North 24 Parganas",
        talukas: [
          { name: "Barasat", villages: ["Barasat", "Basirhat", "Bangaon", "Habra", "Baduria"] },
          { name: "Basirhat", villages: ["Basirhat", "Bangaon", "Habra", "Baduria", "Hingalganj"] }
        ]
      }
    ]
  },
  "Telangana": {
    districts: [
      {
        name: "Hyderabad",
        talukas: [
          { name: "Hyderabad", villages: ["Hyderabad", "Secunderabad", "Rangareddy", "Medak", "Sangareddy"] },
          { name: "Rangareddy", villages: ["Rangareddy", "Medak", "Sangareddy", "Siddipet", "Narayankhed"] }
        ]
      },
      {
        name: "Warangal",
        talukas: [
          { name: "Warangal", villages: ["Warangal", "Hanamkonda", "Jangaon", "Mulugu", "Bhupalpalle"] },
          { name: "Hanamkonda", villages: ["Hanamkonda", "Jangaon", "Mulugu", "Bhupalpalle", "Narsampet"] }
        ]
      }
    ]
  }
};

// Function to update state with location data
const updateStateWithLocationData = async (stateName, locationData) => {
  try {
    const state = await State.findOne({ name: stateName });
    if (!state) {
      console.log(`State ${stateName} not found`);
      return;
    }

    // Update state with districts data
    state.districts = locationData.districts.map(district => ({
      name: district.name,
      code: district.name.toUpperCase().replace(/\s+/g, '_'),
      talukas: district.talukas.map(taluka => ({
        name: taluka.name,
        code: taluka.name.toUpperCase().replace(/\s+/g, '_'),
        villages: taluka.villages.map(village => ({
          name: village,
          code: village.toUpperCase().replace(/\s+/g, '_')
        }))
      }))
    }));

    await state.save();
    console.log(`✅ Updated ${stateName} with ${locationData.districts.length} districts`);
  } catch (error) {
    console.error(`❌ Error updating ${stateName}:`, error);
  }
};

// Function to scrape data from government APIs (placeholder for future implementation)
const scrapeFromGovernmentAPI = async (stateName) => {
  try {
    // This is a placeholder for actual government API integration
    // You can implement actual API calls here based on available government data sources
    console.log(`Would scrape data for ${stateName} from government API`);
    return null;
  } catch (error) {
    console.error(`Error scraping data for ${stateName}:`, error);
    return null;
  }
};

// Main function to update all states with location data
const updateAllStatesWithLocationData = async () => {
  try {
    console.log("Starting to update states with location data...");

    // Update states with predefined data
    for (const [stateName, data] of Object.entries(locationData)) {
      await updateStateWithLocationData(stateName, data);
    }

    // For states not in predefined data, you can implement web scraping
    const allStates = await State.find({});
    const statesWithoutData = allStates.filter(state => 
      !locationData[state.name] && state.districts.length === 0
    );

    console.log(`\nStates without location data: ${statesWithoutData.length}`);
    statesWithoutData.forEach(state => {
      console.log(`- ${state.name}`);
    });

    console.log("\n✅ Location data update completed!");
    console.log("Note: For states without data, you can:");
    console.log("1. Add data manually through the admin panel");
    console.log("2. Implement web scraping from government sources");
    console.log("3. Use census data or other reliable sources");

  } catch (error) {
    console.error("❌ Error updating location data:", error);
  }
};

// Function to export current data to JSON file
const exportLocationData = async () => {
  try {
    const states = await State.find({}).lean();
    const exportData = states.map(state => ({
      name: state.name,
      code: state.code,
      districtsCount: state.districts.length,
      totalTalukas: state.districts.reduce((sum, district) => sum + district.talukas.length, 0),
      totalVillages: state.districts.reduce((sum, district) => 
        sum + district.talukas.reduce((talukaSum, taluka) => talukaSum + taluka.villages.length, 0), 0
      )
    }));

    fs.writeFileSync('location-data-summary.json', JSON.stringify(exportData, null, 2));
    console.log("✅ Location data summary exported to location-data-summary.json");
  } catch (error) {
    console.error("❌ Error exporting data:", error);
  }
};

const main = async () => {
  await connectDB();
  await updateAllStatesWithLocationData();
  await exportLocationData();
  process.exit(0);
};

main(); 