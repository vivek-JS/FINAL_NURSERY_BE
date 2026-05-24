import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import archiver from "archiver";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BACKUP_DIR = path.join(__dirname, "..", "backups");
const BACKUP_PREFIX = "nursery_backup_";
const MANIFEST_FILE = "_backup_manifest.json";
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);

export function resolveBackupDir() {
  const configured = process.env.BACKUP_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_BACKUP_DIR;
}

function resolveMongoUrl() {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    return (
      process.env.PROD_MONGO_URL ||
      process.env.MONGO_URL ||
      process.env.MONGODB_URI ||
      ""
    );
  }
  return (
    process.env.MONGO_URL ||
    process.env.STAGE_MONGO_URL ||
    process.env.MONGODB_URI ||
    ""
  );
}

function ensureBackupDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function formatTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function isSafeBackupFilename(name) {
  if (!name || typeof name !== "string") return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  return (
    name.startsWith(BACKUP_PREFIX) &&
    (name.endsWith(".tar.gz") || name.endsWith(".zip"))
  );
}

async function compressDirectory(sourceDir, outputPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("tar", { gzip: true, gzipOptions: { level: 6 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function mongodumpAvailable() {
  try {
    await execFileAsync("mongodump", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function createMongodumpBackup(mongoUrl, dumpDir) {
  await execFileAsync("mongodump", ["--uri", mongoUrl, "--out", dumpDir], {
    timeout: 30 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function createJsonBackup(dumpDir) {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB is not connected");
  }

  const collections = await db.listCollections().toArray();
  fs.mkdirSync(dumpDir, { recursive: true });

  const meta = {
    createdAt: new Date().toISOString(),
    method: "json-export",
    database: db.databaseName,
    collections: [],
  };

  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;

    const docs = await db.collection(name).find({}).toArray();
    const filePath = path.join(dumpDir, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(docs));
    meta.collections.push({ name, count: docs.length });
  }

  fs.writeFileSync(path.join(dumpDir, "_backup_meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

function cleanupOldBackups(backupDir) {
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) return;

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(backupDir);

  for (const file of files) {
    if (!file.startsWith(BACKUP_PREFIX)) continue;
    const fullPath = path.join(backupDir, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function readManifest(backupDir) {
  const manifestPath = path.join(backupDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function writeManifestEntry(backupDir, entry) {
  const manifest = readManifest(backupDir);
  manifest[entry.filename] = entry;
  fs.writeFileSync(
    path.join(backupDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2)
  );
}

export async function createCompleteBackup({ createdBy } = {}) {
  const backupDir = resolveBackupDir();
  ensureBackupDir(backupDir);

  const mongoUrl = resolveMongoUrl();
  if (!mongoUrl) {
    throw new Error("MongoDB URL is not configured");
  }

  const stamp = formatTimestamp();
  const baseName = `${BACKUP_PREFIX}${stamp}`;
  const tempDir = path.join(backupDir, `${baseName}_tmp`);
  const archiveName = `${baseName}.tar.gz`;
  const archivePath = path.join(backupDir, archiveName);

  let method = "mongodump";

  try {
    if (await mongodumpAvailable()) {
      await createMongodumpBackup(mongoUrl, tempDir);
    } else {
      method = "json-export";
      await createJsonBackup(tempDir);
    }

    await compressDirectory(tempDir, archivePath);
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  cleanupOldBackups(backupDir);

  const stat = fs.statSync(archivePath);
  const databaseName = mongoose.connection?.db?.databaseName || null;

  const record = {
    filename: archiveName,
    fullPath: archivePath,
    size: stat.size,
    sizeFormatted: formatBytes(stat.size),
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    method,
    database: databaseName,
    createdBy: createdBy || null,
  };

  writeManifestEntry(backupDir, record);

  return {
    ...record,
    path: archivePath,
    backupDir,
  };
}

export function listLocalBackups() {
  const backupDir = resolveBackupDir();
  ensureBackupDir(backupDir);
  const manifest = readManifest(backupDir);

  const files = fs
    .readdirSync(backupDir)
    .filter(
      (f) =>
        f.startsWith(BACKUP_PREFIX) &&
        (f.endsWith(".tar.gz") || f.endsWith(".zip"))
    )
    .map((filename) => {
      const fullPath = path.join(backupDir, filename);
      const stat = fs.statSync(fullPath);
      const meta = manifest[filename] || {};
      return {
        filename,
        fullPath: meta.fullPath || fullPath,
        size: stat.size,
        sizeFormatted: formatBytes(stat.size),
        createdAt: meta.createdAt || stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        method: meta.method || "legacy",
        database: meta.database || null,
        createdBy: meta.createdBy || null,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

  return {
    backupDir,
    files,
    count: files.length,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    retentionDays: RETENTION_DAYS,
  };
}

export function resolveBackupFile(filename) {
  if (!isSafeBackupFilename(filename)) {
    throw new Error("Invalid backup filename");
  }

  const backupDir = resolveBackupDir();
  const fullPath = path.join(backupDir, filename);

  if (!fs.existsSync(fullPath)) {
    throw new Error("Backup file not found");
  }

  const resolved = path.resolve(fullPath);
  const resolvedDir = path.resolve(backupDir);
  if (!resolved.startsWith(resolvedDir + path.sep)) {
    throw new Error("Invalid backup path");
  }

  return fullPath;
}
