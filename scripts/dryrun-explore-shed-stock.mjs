/**
 * READ-ONLY. Connects to PROD_MONGO_URL and prints the system's shed -> batch -> lagwad-line stock.
 * Writes nothing.
 */
import "dotenv/config";
import mongoose from "mongoose";
import "../models/farmer.model.js";
import { loadShedStockPayload } from "../services/capacityShedStock.service.js";

const url = process.env.PROD_MONGO_URL;
if (!url) throw new Error("PROD_MONGO_URL missing");

await mongoose.connect(url, { serverSelectionTimeoutMS: 15000, readPreference: "secondaryPreferred" });
console.log("connected db:", mongoose.connection.name, "host:", mongoose.connection.host.replace(/^[^.]+/, "…"));

const payload = await loadShedStockPayload();
console.log("TOTALS", JSON.stringify(payload.totals));
for (const shed of payload.sheds) {
  console.log(
    `\nSHED ${JSON.stringify(shed.shed)} sowed=${shed.sowed} remaining=${shed.remaining} ready=${shed.readyRemaining} batches=${shed.batches.length}`
  );
  for (const b of shed.batches) {
    if (!b.remaining) continue;
    console.log(
      `  BATCH ${b.batchNumber} | ${b.plantName} | ${b.subtypeName} | sowed=${b.sowed} rem=${b.remaining} readyRem=${b.readyRemaining}`
    );
    for (const l of b.lines) {
      if (!l.remaining) continue;
      console.log(
        `     line ${String(l.inwardId).slice(-6)} size=${l.size} cav=${l.cavity} lagwad=${l.lagwadDate ? new Date(l.lagwadDate).toISOString().slice(0, 10) : "-"} ready=${l.readyDate ? new Date(l.readyDate).toISOString().slice(0, 10) : "-"} isReady=${l.ready} rem=${l.remaining}/${l.sowed} status=${l.transferStatus}`
      );
    }
  }
}
await mongoose.disconnect();
