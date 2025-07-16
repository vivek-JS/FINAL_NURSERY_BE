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

// List of all Indian states and union territories
const allStates = [
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
  { name: "Maharashtra", code: "MH" }, // Will be replaced with full data below
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

// Full Maharashtra data (as before)
const maharashtraData = {
  name: "Maharashtra",
  code: "MH",
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
        },
        {
          name: "Mulshi",
          code: "MULSHI",
          villages: [
            { name: "Paud", code: "PAUD" },
            { name: "Pirangut", code: "PIR" },
            { name: "Lavasa", code: "LAVASA" },
            { name: "Tamhini", code: "TAMH" },
            { name: "Kamshet", code: "KAMS" }
          ]
        }
      ]
    },
    {
      name: "Nashik",
      code: "NAS",
      talukas: [
        {
          name: "Nashik City",
          code: "NAS_CITY",
          villages: [
            { name: "Panchavati", code: "PANCH" },
            { name: "Gangapur", code: "GANG" },
            { name: "Nashik Road", code: "NAS_RD" },
            { name: "Deolali", code: "DEO" },
            { name: "Igatpuri", code: "IGAT" }
          ]
        },
        {
          name: "Sinnar",
          code: "SINNAR",
          villages: [
            { name: "Sinnar", code: "SIN" },
            { name: "Pimpalgaon", code: "PIMP" },
            { name: "Yeola", code: "YEO" },
            { name: "Niphad", code: "NIP" },
            { name: "Dindori", code: "DIN" }
          ]
        }
      ]
    },
    {
      name: "Aurangabad",
      code: "AUR",
      talukas: [
        {
          name: "Aurangabad City",
          code: "AUR_CITY",
          villages: [
            { name: "Aurangabad", code: "AUR" },
            { name: "Khuldabad", code: "KHUL" },
            { name: "Paithan", code: "PAIT" },
            { name: "Gangapur", code: "GANG_AUR" },
            { name: "Vaijapur", code: "VAIJ" }
          ]
        },
        {
          name: "Jalna",
          code: "JALNA",
          villages: [
            { name: "Jalna", code: "JAL" },
            { name: "Bhokardan", code: "BHOK" },
            { name: "Ambad", code: "AMB" },
            { name: "Partur", code: "PART" },
            { name: "Mantha", code: "MANTHA" }
          ]
        }
      ]
    },
    {
      name: "Kolhapur",
      code: "KOL",
      talukas: [
        {
          name: "Kolhapur City",
          code: "KOL_CITY",
          villages: [
            { name: "Kolhapur", code: "KOL" },
            { name: "Kagal", code: "KAG" },
            { name: "Gadhinglaj", code: "GADH" },
            { name: "Radhanagari", code: "RADH" },
            { name: "Shahuwadi", code: "SHAH" }
          ]
        },
        {
          name: "Karveer",
          code: "KARVEER",
          villages: [
            { name: "Karveer", code: "KAR" },
            { name: "Hatkanangale", code: "HATK" },
            { name: "Shirol", code: "SHIR" },
            { name: "Panhala", code: "PANH" },
            { name: "Gaganbawada", code: "GAG" }
          ]
        }
      ]
    },
    {
      name: "Sangli",
      code: "SAN",
      talukas: [
        {
          name: "Sangli City",
          code: "SAN_CITY",
          villages: [
            { name: "Sangli", code: "SAN" },
            { name: "Miraj", code: "MIR" },
            { name: "Kupwad", code: "KUP" },
            { name: "Tasgaon", code: "TAS" },
            { name: "Kavathe Mahankal", code: "KAV" }
          ]
        },
        {
          name: "Jath",
          code: "JATH",
          villages: [
            { name: "Jath", code: "JAT" },
            { name: "Khanapur", code: "KHAN" },
            { name: "Atpadi", code: "ATP" },
            { name: "Kadegaon", code: "KAD" },
            { name: "Walwa", code: "WAL" }
          ]
        }
      ]
    }
  ]
};

const seedStates = async () => {
  try {
    // Clear existing states
    await State.deleteMany({});
    console.log("Cleared existing states");

    // Insert all states (empty districts except Maharashtra)
    const statesToInsert = allStates.map((state) => {
      if (state.code === "MH") {
        return maharashtraData;
      }
      return { ...state, districts: [] };
    });

    await State.insertMany(statesToInsert);
    console.log(`Inserted ${statesToInsert.length} states (Maharashtra with full data)`);
    console.log("✅ All Indian states seeded successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding states:", error);
    process.exit(1);
  }
};

const main = async () => {
  await connectDB();
  await seedStates();
};

main(); 