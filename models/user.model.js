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
      "DISPATCH_MANAGER",
      "RAM_AGRI_SALES",
      "RAM_AGRI_SALES_MANAGER",
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
}, { timestamps: true });

// Middleware to handle DealerBooking creation for new dealers

const User = model("User", userSchema);

export default User;
