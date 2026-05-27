import mongoose, { Schema } from "mongoose";

const iciciRegistrationSchema = new Schema(
  {
    registrationId: { type: String, required: true, unique: true },
    status: { type: String, enum: ["ACTIVE", "REVOKED", "EXPIRED"], default: "ACTIVE" },
    environment: { type: String, default: "UAT" },
    publicCertFingerprint: { type: String, index: true },
    registeredAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    response: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

const IciciRegistration =
  mongoose.models.IciciRegistration ||
  mongoose.model("IciciRegistration", iciciRegistrationSchema);

export default IciciRegistration;
