import fs from "fs";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import {
  createCompleteBackup,
  listLocalBackups,
  resolveBackupFile,
} from "../services/backup.service.js";

export const createBackup = catchAsync(async (req, res) => {
  const createdBy = req.user?.name || req.user?.email || req.user?._id?.toString();
  const result = await createCompleteBackup({ createdBy });

  return res.status(201).json(
    generateResponse("Success", "Complete database backup created", {
      filename: result.filename,
      fullPath: result.fullPath,
      size: result.size,
      sizeFormatted: result.sizeFormatted,
      createdAt: result.createdAt,
      modifiedAt: result.modifiedAt,
      method: result.method,
      database: result.database,
      createdBy: result.createdBy,
      backupDir: result.backupDir,
    })
  );
});

export const getBackupList = catchAsync(async (req, res) => {
  const summary = listLocalBackups();

  return res.status(200).json(
    generateResponse("Success", "Backup list fetched", summary)
  );
});

export const downloadBackup = catchAsync(async (req, res) => {
  const { filename } = req.params;
  const filePath = resolveBackupFile(filename);
  const stat = fs.statSync(filePath);

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", stat.size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});
