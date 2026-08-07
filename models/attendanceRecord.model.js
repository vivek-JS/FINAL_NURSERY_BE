import { Schema, model } from "mongoose";

const attendanceRecordSchema = new Schema(
  {
    employee: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["CHECK_IN", "CHECK_OUT", "BREAK_START", "BREAK_END"],
      required: true,
    },
    /** Calendar date (IST) this event belongs to, stored as "YYYY-MM-DD" for cheap exact-match queries. */
    date: {
      type: String,
      required: true,
      index: true,
    },
    time: {
      type: Date,
      required: true,
    },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    device: {
      name: { type: String, default: null },
      id: { type: String, default: null },
      os: { type: String, default: null },
      /** Root/jailbreak/emulator/mock-location signal reported by the mobile app (best-effort, not verified server-side). */
      isCompromised: { type: Boolean, default: false },
    },
    faceMatchScore: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },
    livenessPassed: {
      type: Boolean,
      default: false,
    },
    livenessChallenge: {
      type: String,
      default: null,
    },
    /** Only populated when ENABLE_RAW_FACE_STORAGE=true. */
    selfieUrl: {
      type: String,
      default: null,
    },
    source: {
      type: String,
      enum: ["ONLINE", "OFFLINE_SYNCED", "KIOSK"],
      default: "ONLINE",
    },
    markedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    beardSelfieUrl: {
      type: String,
      default: null,
    },
    /** True if this event was flagged late relative to the employee's department shift start. */
    isLate: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

attendanceRecordSchema.index({ employee: 1, date: 1, createdAt: 1 });

const AttendanceRecord = model("AttendanceRecord", attendanceRecordSchema);

export default AttendanceRecord;
