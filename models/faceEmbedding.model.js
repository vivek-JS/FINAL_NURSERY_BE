import { Schema, model } from "mongoose";

const faceEmbeddingSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** AES-256-GCM ciphertext of the 128-d face descriptor Float32Array, base64-encoded. */
    encryptedVector: {
      type: String,
      required: true,
    },
    iv: {
      type: String,
      required: true,
    },
    authTag: {
      type: String,
      required: true,
    },
    pose: {
      type: String,
      enum: ["FRONT", "LEFT", "RIGHT", "UP", "DOWN"],
      required: true,
    },
    qualityScore: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },
    /** Only populated when ENABLE_RAW_FACE_STORAGE=true; optional selfie kept for admin audit. */
    sourceImageUrl: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// One embedding per (user, pose) — re-registering a pose overwrites the prior one via upsert.
faceEmbeddingSchema.index({ user: 1, pose: 1 }, { unique: true });

const FaceEmbedding = model("FaceEmbedding", faceEmbeddingSchema);

export default FaceEmbedding;
