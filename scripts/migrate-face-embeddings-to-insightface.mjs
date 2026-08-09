/**
 * Migrates legacy face-api FaceEmbedding records to InsightFace EmployeeFaceProfile.
 *
 * Run AFTER deploying the face-service and BEFORE employees re-register:
 *   node scripts/migrate-face-embeddings-to-insightface.mjs
 *
 * Actions:
 * 1. Archives all FaceEmbedding docs to FaceEmbeddingArchive
 * 2. Deactivates any EmployeeFaceProfile rows
 * 3. Sets all users with REGISTERED face status to NOT_REGISTERED (re-registration required)
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const MONGO_URL =
  process.env.MONGO_URL || process.env.MONGODB_URI || "mongodb://localhost:27017/nursery";

async function main() {
  await mongoose.connect(MONGO_URL);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  const faceEmbeddings = db.collection("faceembeddings");

  const archiveName = "faceembeddingarchives";
  const existing = await faceEmbeddings.countDocuments();
  if (existing > 0) {
    const docs = await faceEmbeddings.find({}).toArray();
    if (docs.length) {
      await db.collection(archiveName).insertMany(
        docs.map((d) => ({ ...d, archived_at: new Date(), reason: "insightface_migration" }))
      );
      console.log(`Archived ${docs.length} FaceEmbedding documents`);
    }
  }

  await faceEmbeddings.deleteMany({});
  console.log("Cleared FaceEmbedding collection");

  const profiles = db.collection("employeefaceprofiles");
  const deactivated = await profiles.updateMany({}, { $set: { is_active: false, face_registered: false } });
  console.log(`Deactivated ${deactivated.modifiedCount} EmployeeFaceProfile rows`);

  const users = db.collection("users");
  const reset = await users.updateMany(
    { faceRegistrationStatus: { $in: ["REGISTERED", "IN_PROGRESS"] } },
    { $set: { faceRegistrationStatus: "NOT_REGISTERED" } }
  );
  console.log(`Reset face registration status for ${reset.modifiedCount} users`);

  console.log("\nMigration complete. Employees must re-register faces via the mobile app.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
