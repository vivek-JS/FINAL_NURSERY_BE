import fs from "fs";
import mongoose from "mongoose";
import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";

function getMongoUrl() {
  if (process.env.MONGO_URL) return process.env.MONGO_URL;
  const paths = [
    "./.env",
    "./.env.backup.20251225_112705",
    "../.env.backup.20251225_112705",
    "../.env",
  ];
  for (const p of paths) {
    try {
      const content = fs.readFileSync(p, "utf8");
      const m = content.match(/^\s*MONGO_URL\s*=\s*(.*)$/m);
      if (m && m[1]) return m[1].trim();
    } catch (e) {
      // ignore
    }
  }
  return null;
}

(async () => {
  const mongoUrl = getMongoUrl();
  if (!mongoUrl) {
    console.error("MONGO_URL not found in environment or .env files");
    process.exit(2);
  }

  try {
    await mongoose.connect(mongoUrl, { dbName: process.env.DB_NAME || undefined });
    const farmers = await Farmer.countDocuments({ opt_in: true });
    const farmerLeads = await FarmerLead.countDocuments({ opt_in: true });
    console.log(JSON.stringify({ farmers, farmerLeads }));
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("ERROR", err && err.message ? err.message : err);
    process.exit(1);
  }
})();

