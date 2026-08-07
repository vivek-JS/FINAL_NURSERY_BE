import { Schema, model } from "mongoose";

const hhmmValidator = {
  validator: (value) => !value || /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
  message: "Time must be in HH:mm 24-hour format",
};

/**
 * Office-hours group for attendance (e.g. Office Staff 9:30, Field Staff 7:00, Drivers 6:00).
 * Employees link via User.officeGroup; falls back to Department shift times if unset.
 */
const employeeOfficeGroupSchema = new Schema(
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
    /** Expected office / shift start — "HH:mm" IST. */
    officeStartTime: {
      type: String,
      required: true,
      default: "09:30",
      validate: hhmmValidator,
    },
    /** Expected office / shift end — "HH:mm" IST. */
    officeEndTime: {
      type: String,
      default: "18:00",
      validate: hhmmValidator,
    },
    lateGraceMinutes: {
      type: Number,
      default: 10,
      min: 0,
    },
    minMinutesBetweenCheckInAndOut: {
      type: Number,
      default: 30,
      min: 0,
    },
    /** ISO weekday 0=Sun .. 6=Sat when attendance is not expected. */
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
    description: {
      type: String,
      trim: true,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

employeeOfficeGroupSchema.index({ isActive: 1, code: 1 });

const EmployeeOfficeGroup = model("EmployeeOfficeGroup", employeeOfficeGroupSchema);

export default EmployeeOfficeGroup;
