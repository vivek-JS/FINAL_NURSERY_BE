import { Schema, model } from "mongoose";

const punchSchema = new Schema(
  {
    timestamp: { type: Date, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    gps_accuracy: { type: Number, default: null },
    device_id: { type: String, default: null },
    face_match_score: { type: Number, min: 0, max: 1, default: null },
    face_quality_score: { type: Number, min: 0, max: 1, default: null },
    liveness_passed: { type: Boolean, default: false },
    audit_image_url: { type: String, default: null },
    beard_image_url: { type: String, default: null },
    location_verified: { type: Boolean, default: null },
    /** MOBILE | KIOSK | MANUAL */
    source: { type: String, default: "MOBILE" },
    marked_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    employee_name: { type: String, default: null },
  },
  { _id: false }
);

const attendanceDailySchema = new Schema(
  {
    employee_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    employee_code: {
      type: String,
      default: null,
    },
    /** IST calendar date "YYYY-MM-DD". */
    attendance_date: {
      type: String,
      required: true,
      index: true,
    },
    shift_id: {
      type: Schema.Types.ObjectId,
      ref: "Department",
      default: null,
    },
    branch_id: {
      type: Schema.Types.ObjectId,
      ref: "NurserySite",
      default: null,
    },
    /** Office-hours group used for this day's attendance (snapshot at punch time). */
    office_group_id: {
      type: Schema.Types.ObjectId,
      ref: "EmployeeOfficeGroup",
      default: null,
    },
    /** Effective office start/end at punch time — "HH:mm" IST snapshot. */
    office_start_time: { type: String, default: null },
    office_end_time: { type: String, default: null },
    check_in: punchSchema,
    check_out: punchSchema,
    attendance_status: {
      type: String,
      enum: ["PRESENT", "ABSENT", "HALF_DAY", "LATE", "ON_LEAVE", "WEEKLY_OFF", "HOLIDAY"],
      default: "ABSENT",
    },
    total_working_minutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    late_by_minutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    early_exit_minutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    verification_method: {
      type: String,
      default: "FACE",
    },
    status: {
      type: String,
      enum: ["ACTIVE", "CORRECTED", "VOID"],
      default: "ACTIVE",
    },
    correction_reason: {
      type: String,
      default: null,
    },
    corrected_by: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

attendanceDailySchema.index({ employee_id: 1, attendance_date: 1 }, { unique: true });

const AttendanceDaily = model("AttendanceDaily", attendanceDailySchema);

export default AttendanceDaily;
