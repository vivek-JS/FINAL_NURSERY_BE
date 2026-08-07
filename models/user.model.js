import { Schema, model } from "mongoose";
import DealerBooking from "./dealerBooking.model.js";

const userSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  phoneNumber: {
    type: Number,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
    default: "1234",
  },
  isPasswordSet: {
    type: Boolean,
    default: false,
  },
    jobTitle: {
    type: String,
    enum: [
      "Manager",
      "HR",
      "SALES",
      "PRIMARY",
      "OFFICE_STAFF",
      "DRIVER",
      "LABORATORY_MANAGER",
      "DEALER",
      "OFFICE_ADMIN",
      "ACCOUNTANT",
      "CASHIER",
      "DISPATCH_MANAGER",
      "RAM_AGRI_SALES",
      "RAM_AGRI_SALES_MANAGER",
      "RAM_AGRI_SALES_OFFICE_MANAGER",
      "RAM_AGRI_MASTER",
      "RAM_AGRI_INPUT_ADMIN",
      "AGRI_INPUT_DEALER",
      "SUPER_ADMIN",
    ],
  },
  role: {
    type: String,
    enum: [
      "SUPER_ADMIN",
      "ADMIN",
      "SALES",
      "DEALER",
      "FARMER",
      "ACCOUNTANT",
      "CASHIER",
      "OFFICE_ADMIN",
      "DISPATCH_MANAGER",
      "Manager",
      "HR",
      "PRIMARY",
      "OFFICE_STAFF",
      "DRIVER",
      "LABORATORY_MANAGER",
      "RAM_AGRI_SALES",
      "RAM_AGRI_SALES_MANAGER",
      "RAM_AGRI_SALES_OFFICE_MANAGER",
      "RAM_AGRI_MASTER",
      "RAM_AGRI_INPUT_ADMIN",
      "AGRI_INPUT_DEALER",
    ],
    default: "FARMER"
  },
  isDisabled: {
    type: Boolean,
    default: false,
  },
  defaultState: {
    type: String,
  },
  defaultDistrict: {
    type: String,
  },
  defaultTaluka: {
    type: String,
  },
  defaultVillage: {
    type: String,
  },
  isOnboarded: {
    type: Boolean,
    default: false,
  },
  birthDate: {
    type: Date,
  },
  expoPushToken: {
    type: String,
    default: null,
  },
  /** Ram Agri: max allowed sales outstanding (₹); null/omit → use global default from RamAgriSalesConfig */
  ramAgriOutstandingLimitRupees: {
    type: Number,
    default: null,
    min: 0,
  },

  // ---- Face Recognition Attendance app fields (additive; unrelated flows are unaffected) ----
  /** Human-friendly employee code shown in the attendance app + admin panel (e.g. "RB-0042"). */
  employeeCode: {
    type: String,
    trim: true,
    default: null,
  },
  department: {
    type: Schema.Types.ObjectId,
    ref: "Department",
    default: null,
  },
  /**
   * Office-hours group when timing differs from department default
   * (e.g. Field Staff 07:00, Office Staff 09:30, Drivers 06:00).
   */
  officeGroup: {
    type: Schema.Types.ObjectId,
    ref: "EmployeeOfficeGroup",
    default: null,
  },
  /** Per-employee override — used only when this employee's hours differ from their group. */
  officeStartTimeOverride: {
    type: String,
    default: null,
    validate: {
      validator: (value) => !value || /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
      message: "officeStartTimeOverride must be in HH:mm 24-hour format",
    },
  },
  officeEndTimeOverride: {
    type: String,
    default: null,
    validate: {
      validator: (value) => !value || /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
      message: "officeEndTimeOverride must be in HH:mm 24-hour format",
    },
  },
  faceRegistrationStatus: {
    type: String,
    enum: ["NOT_REGISTERED", "IN_PROGRESS", "REGISTERED"],
    default: "NOT_REGISTERED",
  },
  nurserySite: {
    type: Schema.Types.ObjectId,
    ref: "NurserySite",
    default: null,
  },
  /** Timestamp when the employee consented to face data collection for attendance. */
  faceConsentAt: {
    type: Date,
    default: null,
  },
  /** SHA-256 hash of the current forgot-password OTP; never store the raw OTP. */
  passwordResetOtpHash: {
    type: String,
    default: null,
    select: false,
  },
  passwordResetOtpExpiresAt: {
    type: Date,
    default: null,
    select: false,
  },
  passwordResetOtpAttempts: {
    type: Number,
    default: 0,
    select: false,
  },
}, { timestamps: true });

// Middleware to handle DealerBooking creation for new dealers

const User = model("User", userSchema);

export default User;
