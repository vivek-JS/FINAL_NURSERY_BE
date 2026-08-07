import { Schema, model } from "mongoose";

const employeeFaceProfileSchema = new Schema(
  {
    employee_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** AES-256-GCM ciphertext of the InsightFace embedding Float32Array, base64-encoded. */
    face_embedding_enc: {
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
    model_name: {
      type: String,
      default: "InsightFace",
    },
    model_version: {
      type: String,
      default: "buffalo_l",
    },
    embedding_dim: {
      type: Number,
      default: 512,
    },
    quality_score: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },
    reference_image_url: {
      type: String,
      default: null,
    },
    /** True when employee has facial hair — kiosk requires extra beard/chin capture at punch time. */
    has_beard: {
      type: Boolean,
      default: false,
    },
    beard_reference_image_url: {
      type: String,
      default: null,
    },
    face_registered: {
      type: Boolean,
      default: true,
    },
    registration_device_id: {
      type: String,
      default: null,
    },
    registered_by: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    registered_at: {
      type: Date,
      default: Date.now,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

employeeFaceProfileSchema.index(
  { employee_id: 1 },
  { unique: true, partialFilterExpression: { is_active: true } }
);

const EmployeeFaceProfile = model("EmployeeFaceProfile", employeeFaceProfileSchema);

export default EmployeeFaceProfile;
