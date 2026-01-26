import { Schema, model } from "mongoose";
import DealerBooking from "./dealerBooking.model.js";

const followUpSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: "",
  },
  followUpDate: {
    type: String,
    required: true,
  },
  dueTime: {
    type: String,
    default: "",
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high", "urgent"],
    default: "medium",
  },
  status: {
    type: String,
    enum: ["pending", "completed", "incomplete", "not_done"],
    default: "pending",
  },
  publicToken: {
    type: String,
    required: true,
    unique: true,
    sparse: true,
    index: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  completedAt: {
    type: Date,
  },
}, { _id: true });

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
      "DISPATCH_MANAGER",
      "RAM_AGRI_SALES",
      "RAM_AGRI_SALES_MANAGER",
      "AGRI_INPUT_DEALER",
      "SUPER_ADMIN",
    ],
  },
  role: {
    type: String,
    enum: ["SUPER_ADMIN", "ADMIN", "SALES", "DEALER", "FARMER", "ACCOUNTANT", "OFFICE_ADMIN", "DISPATCH_MANAGER"],
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
  followUps: {
    type: [followUpSchema],
    default: [],
  },
});

// Middleware to handle DealerBooking creation for new dealers

const User = model("User", userSchema);

export default User;
