import { Schema, model } from "mongoose";

const departmentSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
    },
    /** "HH:mm" 24-hour shift start used by the attendance dashboard to flag late check-ins. */
    shiftStartTime: {
      type: String,
      default: "09:30",
      validate: {
        validator: (value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
        message: "shiftStartTime must be in HH:mm 24-hour format",
      },
    },
    /** Alias / preferred name for shiftStartTime (office opening). Falls back to shiftStartTime when unset. */
    officeStartTime: {
      type: String,
      default: null,
      validate: {
        validator: (value) => !value || /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
        message: "officeStartTime must be in HH:mm 24-hour format",
      },
    },
    /** Minutes of grace period after shiftStartTime before a check-in counts as late. */
    lateGraceMinutes: {
      type: Number,
      default: 10,
      min: 0,
    },
    /** "HH:mm" 24-hour shift end used for early-exit calculation. */
    shiftEndTime: {
      type: String,
      default: "18:00",
      validate: {
        validator: (value) => !value || /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
        message: "shiftEndTime must be in HH:mm 24-hour format",
      },
    },
    /** Alias / preferred name for shiftEndTime (office closing). Falls back to shiftEndTime when unset. */
    officeEndTime: {
      type: String,
      default: null,
      validate: {
        validator: (value) => !value || /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
        message: "officeEndTime must be in HH:mm 24-hour format",
      },
    },
    /** Minimum minutes between check-in and check-out. */
    minMinutesBetweenCheckInAndOut: {
      type: Number,
      default: 30,
      min: 0,
    },
    /** ISO weekday numbers (0=Sun .. 6=Sat) when attendance is not expected. */
    weeklyOffDays: {
      type: [Number],
      default: [],
      validate: {
        validator: (days) => days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: "weeklyOffDays must be integers 0-6",
      },
    },
    branch_id: {
      type: Schema.Types.ObjectId,
      ref: "NurserySite",
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

departmentSchema.index({ isActive: 1 });

const Department = model("Department", departmentSchema);

export default Department;
