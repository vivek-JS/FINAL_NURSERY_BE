import { Schema, model } from "mongoose";

const attendanceAttemptSchema = new Schema(
  {
    employee_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    attendance_type: {
      type: String,
      enum: ["CHECK_IN", "CHECK_OUT", "BREAK_START", "BREAK_END"],
      default: null,
    },
    attempted_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
    verification_status: {
      type: String,
      enum: ["SUCCESS", "FAILED"],
      required: true,
    },
    failure_reason: {
      type: String,
      default: null,
    },
    error_code: {
      type: String,
      default: null,
    },
    face_match_score: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },
    face_quality_score: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },
    liveness_passed: {
      type: Boolean,
      default: false,
    },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    gps_accuracy: { type: Number, default: null },
    device_id: { type: String, default: null },
    ip_address: { type: String, default: null },
    audit_image_url: { type: String, default: null },
    beard_image_url: { type: String, default: null },
    /** MOBILE | KIOSK | MANUAL */
    source: { type: String, default: "MOBILE" },
    marked_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

attendanceAttemptSchema.index({ employee_id: 1, attempted_at: -1 });
attendanceAttemptSchema.index({ verification_status: 1, attempted_at: -1 });

const AttendanceAttempt = model("AttendanceAttempt", attendanceAttemptSchema);

export default AttendanceAttempt;
