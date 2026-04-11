/**
 * Import "Gadi Number" fleet sheet into VehicleOwner + VehicleDriver + Vehicle.
 * Groups rows by (Driver Name + Contact): one owner, one default driver, N vehicles
 * (e.g. Dinesh Suryawanshi + 8999778787 → MH19CY6541 + MH04HS1332).
 *
 * Usage (from FINAL_NURSERY_BE, after .env is configured):
 *   node scripts/seed-gadi-fleet-from-xlsx.js --stage
 *   node scripts/seed-gadi-fleet-from-xlsx.js --prod
 *   node scripts/seed-gadi-fleet-from-xlsx.js --stage --dry-run
 *
 * Optional: --file=./scripts/data/other.xlsx
 *
 * DB URI: --stage → STAGE_MONGO_URL || MONGO_URL; --prod → PROD_MONGO_URL
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import XLSX from "xlsx";
import Vehicle from "../models/vehicleModel.model.js";
import VehicleOwner from "../models/vehicleOwner.model.js";
import VehicleDriver from "../models/vehicleDriver.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const SEED_NOTE = "Imported: Gadi Number list (seed:gadi-fleet)";
const DEFAULT_CAPACITY = 500;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePlate(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function trimStr(v) {
  return String(v ?? "").trim();
}

function pickUri(flags) {
  if (flags.prod) {
    const u = process.env.PROD_MONGO_URL;
    if (!u) {
      console.error("Missing PROD_MONGO_URL in .env for --prod");
      process.exit(1);
    }
    return u;
  }
  if (flags.stage) {
    const u = process.env.STAGE_MONGO_URL || process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!u) {
      console.error("Missing STAGE_MONGO_URL or MONGO_URL for --stage");
      process.exit(1);
    }
    return u;
  }
  const u = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!u) {
    console.error("Pass --stage or --prod, or set MONGO_URL / MONGODB_URI");
    process.exit(1);
  }
  return u;
}

function parseFlags(argv) {
  return {
    stage: argv.includes("--stage"),
    prod: argv.includes("--prod"),
    dryRun: argv.includes("--dry-run"),
    file:
      argv.find((a) => a.startsWith("--file="))?.slice("--file=".length) ||
      path.join(__dirname, "data", "gadi-number-list.xlsx"),
  };
}

function readRowsFromXlsx(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error("XLSX not found:", filePath);
    process.exit(1);
  }
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!matrix.length) return [];
  const header = matrix[0].map((h) => trimStr(h).toLowerCase());
  const idx = (label) => header.findIndex((h) => h.includes(label));
  const iPlate = idx("vehicle");
  const iDriver = idx("driver");
  const iContact = idx("contact");
  if (iPlate < 0 || iDriver < 0 || iContact < 0) {
    console.error("Expected columns: Vehicle No., Driver Name, Contact No.", header);
    process.exit(1);
  }
  const out = [];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    const plate = normalizePlate(row[iPlate]);
    const driver = trimStr(row[iDriver]);
    const contact = trimStr(row[iContact]);
    out.push({ plate, driver, contact, rowNum: r + 1 });
  }
  return out;
}

/** Group by contact + driver (case-insensitive) so one owner gets many vehicles. */
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const { plate, driver, contact, rowNum } = row;
    if (!driver || !contact) {
      console.warn(`Skip row ${rowNum}: missing driver or contact`);
      continue;
    }
    const key = `${contact.toLowerCase()}|${driver.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        driverDisplay: driver,
        contact,
        plates: [],
        ownerOnly: true,
      });
    }
    const g = groups.get(key);
    if (plate) {
      g.ownerOnly = false;
      if (!g.plates.includes(plate)) g.plates.push(plate);
    }
  }
  return groups;
}

async function ensureOwnerAndDriver(driverName, contact) {
  let owner = await VehicleOwner.findOne({
    mobile: contact,
    name: { $regex: new RegExp(`^${escapeRegex(driverName)}$`, "i") },
  });
  if (!owner) {
    owner = await VehicleOwner.create({
      name: driverName,
      mobile: contact,
      notes: SEED_NOTE,
      isActive: true,
    });
    console.log("  + owner", owner.name, owner.mobile);
  }
  let driver = await VehicleDriver.findOne({
    ownerId: owner._id,
    mobile: contact,
    name: { $regex: new RegExp(`^${escapeRegex(driverName)}$`, "i") },
  });
  if (!driver) {
    driver = await VehicleDriver.create({
      ownerId: owner._id,
      name: driverName,
      mobile: contact,
      isActive: true,
    });
    console.log("  + driver", driver.name, "→ owner", String(owner._id));
  }
  return { owner, driver };
}

async function upsertVehicle(plate, ownerId, defaultDriverId, driverName, contact) {
  const doc = await Vehicle.findOneAndUpdate(
    { number: plate },
    {
      $set: {
        ownerId,
        defaultDriverId,
        name: plate,
        number: plate,
        capacity: DEFAULT_CAPACITY,
        driverName,
        driverMobile: contact,
        vehicleType: "TRUCK",
        isActive: true,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
  );
  console.log(`  vehicle ${plate} →`, doc._id.toString());
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.stage && flags.prod) {
    console.error("Use only one of --stage or --prod");
    process.exit(1);
  }
  const uri = pickUri(flags);
  const rows = readRowsFromXlsx(flags.file);
  const groups = groupRows(rows);

  console.log(
    (flags.dryRun ? "DRY RUN — " : "") +
      `Target: ${flags.prod ? "PROD" : flags.stage ? "STAGE" : "default"}` +
      (flags.dryRun ? "" : " " + uri.replace(/:[^:@/]+@/, ":****@"))
  );
  console.log("XLSX:", flags.file);
  console.log("Groups:", groups.size);

  if (flags.dryRun) {
    for (const [, g] of groups) {
      console.log(
        `\n— ${g.driverDisplay} / ${g.contact} | plates: ${g.plates.join(", ") || "(none)"} | ownerOnly=${g.ownerOnly}`
      );
    }
    console.log("\nDry run: no database writes.");
    return;
  }

  await mongoose.connect(uri);
  try {
    for (const [, g] of groups) {
      console.log(
        `\n— ${g.driverDisplay} / ${g.contact} (${g.plates.length} vehicle(s), ownerOnly=${g.ownerOnly})`
      );
      const { owner, driver } = await ensureOwnerAndDriver(g.driverDisplay, g.contact);
      if (g.ownerOnly) {
        console.log("  owner-only (no vehicle number): owner + driver ensured above");
        continue;
      }
      for (const plate of g.plates) {
        await upsertVehicle(plate, owner._id, driver._id, g.driverDisplay, g.contact);
      }
    }
    console.log("\nDone.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
