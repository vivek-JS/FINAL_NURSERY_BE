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
    default: "12345678",
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
    ],
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
});

// Middleware to handle DealerBooking creation for new dealers

const User = model("User", userSchema);

export default User;
