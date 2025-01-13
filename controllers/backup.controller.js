import catchAsync from "../utility/catchAsync.js";
import fs from "fs"; // Regular fs module for streams
import fsPromises from "fs/promises"; // Promise-based fs operations
import path from "path";
import os from "os";
import archiver from "archiver";
import unzipper from "unzipper";
import AppError from "../utility/appError.js";

// Fix for __dirname in ES Modules
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// importing all models
import Attendance from "../models/attendance.model.js";
import Chemical from "../models/chemical.model.js";
import CMS from "../models/cms.model.js";
import Dispatch from "../models/dispatch.model.js";
import District from "../models/District.model.js";
import Employee from "../models/employee.model.js";
import Farmer from "../models/farmer.model.js";
import {
  GodownStockInward,
  GodownStockOutward,
} from "../models/godown.model.js";
import Lab from "../models/lab.model.js";
import Order from "../models/order.model.js";
import PrimaryHardening from "../models/primayHardeing.model.js";
import ReportedFarmer from "../models/reporting.model.js";
import SecondaryHardening from "../models/secondaryHardening.model.js";
import { SeedInward, SeedOutward } from "../models/seed.model.js";
import Shade from "../models/shadeSchema.model.js";
import PlantSlot from "../models/slots.model.js";
import Tray from "../models/tray.model.js";
import User from "../models/user.model.js";
import Vegetable from "../models/vegetables.model.js";
import Vehicle from "../models/vehicleModel.model.js";
import Village from "../models/village.model.js";

const createBackup = catchAsync(async (req, res, next) => {
  const backupDir = path.join(os.tmpdir(), `backups_${Date.now()}`);
  await fsPromises.mkdir(backupDir, { recursive: true });

  const collections = {
    Attendance,
    Chemical,
    CMS,
    Dispatch,
    District,
    Employee,
    Farmer,
    Lab,
    Order,
    PrimaryHardening,
    ReportedFarmer,
    SecondaryHardening,
    SeedInward,
    SeedOutward,
    Shade,
    PlantSlot,
    Tray,
    User,
    Vegetable,
    Vehicle,
    Village,
  };

  try {
    // Export all collections asynchronously
    await Promise.all(
      Object.entries(collections).map(async ([name, model]) => {
        const data = await model.find();
        const filePath = path.join(backupDir, `${name}.json`);
        await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2));
      })
    );

    // Create ZIP file
    const zipPath = path.join(backupDir, "backup.zip");
    const output = fs.createWriteStream(zipPath); // Using regular fs module
    const archive = archiver("zip", { zlib: { level: 9 } });

    // Create a promise to handle the archiving process
    const archivePromise = new Promise((resolve, reject) => {
      output.on("close", () => resolve());
      archive.on("error", reject);
    });

    archive.pipe(output);
    archive.directory(backupDir, false);
    await archive.finalize();

    // Wait for the archive to be created
    await archivePromise;

    // Send the file
    res.download(zipPath, "backup.zip", async (err) => {
      if (err) {
        await fsPromises.rm(backupDir, { recursive: true, force: true });
        return next(err);
      }

      // Cleanup temporary files after successful download
      await fsPromises.rm(backupDir, { recursive: true, force: true });
    });
  } catch (err) {
    // Cleanup in case of error
    await fsPromises.rm(backupDir, { recursive: true, force: true });
    return next(err);
  }
});

const addBackup = catchAsync(async (req, res, next) => {
  // Check if file was uploaded
  if (!req.file || !req.file.path) {
    return next(new AppError("No backup file uploaded", 400));
  }

  // Validate file exists on disk
  if (!fs.existsSync(req.file.path)) {
    return next(new AppError("Uploaded file not found", 400));
  }

  // Create extraction directory within uploads folder
  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  const extractDir = path.join(uploadsDir, `extract_${Date.now()}`);

  try {
    // Ensure uploads directory exists
    await fsPromises.mkdir(uploadsDir, { recursive: true });
    await fsPromises.mkdir(extractDir, { recursive: true });

    // Extract the uploaded zip file
    await fs
      .createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    // Read all JSON files from the extracted directory
    const files = await fsPromises.readdir(extractDir);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    if (jsonFiles.length === 0) {
      throw new AppError("No JSON files found in backup", 400);
    }

    const collections = {
      Attendance,
      Chemical,
      CMS,
      Dispatch,
      District,
      Employee,
      Farmer,
      Lab,
      Order,
      PrimaryHardening,
      ReportedFarmer,
      SecondaryHardening,
      SeedInward,
      SeedOutward,
      Shade,
      PlantSlot,
      Tray,
      User,
      Vegetable,
      Vehicle,
      Village,
    };

    const results = {
      successful: [],
      failed: [],
    };

    // Process each JSON file
    for (const file of jsonFiles) {
      try {
        const collectionName = path.basename(file, ".json");
        const Model = collections[collectionName];

        if (!Model) {
          console.warn(`No model found for collection: ${collectionName}`);
          results.failed.push({
            collection: collectionName,
            error: "Model not found",
          });
          continue;
        }

        const jsonContent = await fsPromises.readFile(
          path.join(extractDir, file),
          "utf-8"
        );
        const documents = JSON.parse(jsonContent);

        if (documents.length > 0) {
          try {
            await Model.insertMany(documents, {
              ordered: false,
            });
            results.successful.push(collectionName);
          } catch (insertError) {
            // console.error(
            //   `Error inserting documents for ${collectionName}:`,
            //   insertError
            // );
            results.failed.push({
              collection: collectionName,
              error: insertError.message || "Insert failed",
            });
          }
        } else {
          results.successful.push(collectionName);
        }
      } catch (fileError) {
        // console.error(`Error processing file ${file}:`, fileError);
        results.failed.push({
          collection: path.basename(file, ".json"),
          error: fileError.message || "File processing failed",
        });
        continue;
      }
    }

    // Cleanup extracted files
    await fsPromises.rm(extractDir, { recursive: true, force: true });

    // Keep the backup file in uploads folder
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFileName = `backup-${timestamp}.zip`;
    const backupPath = path.join(uploadsDir, backupFileName);

    await fsPromises.rename(req.file.path, backupPath);

    res.status(200).json({
      status: results.failed.length === 0 ? "success" : "partial",
      message: "Backup import completed",
      results: {
        successful: results.successful,
        failed: results.failed,
        totalProcessed: jsonFiles.length,
        successCount: results.successful.length,
        failureCount: results.failed.length,
        backupFile: backupFileName,
      },
    });
  } catch (err) {
    // console.error("Import error:", err);

    // Cleanup on error
    try {
      if (fs.existsSync(extractDir)) {
        await fsPromises.rm(extractDir, { recursive: true, force: true });
      }
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        await fsPromises.unlink(req.file.path);
      }
    } catch (cleanupError) {
      // console.error("Cleanup error:", cleanupError);
    }

    next(err);
  }
});

export { createBackup, addBackup };
