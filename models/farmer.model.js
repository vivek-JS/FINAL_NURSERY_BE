import mongoose, { Schema, model } from "mongoose";

const farmerSchema = new Schema({
  name: {
    type: String,
    required: [true, "Farmer name requried"],
  },
  village: {
    type: String,
    required: [true, "Village ID requried"],
  },
  taluka: {
    type: String,
    required: [true, "Taluka ID requried"],
  },
  district: {
    type: String,
    required: [true, "District ID requried"],
  },
  stateName: {
    type: String,
    required: [true, "State name requried"],
  },
  talukaName: {
    type: String,
    required: [true, "Taluka name requried"],
  },
  districtName: {
    type: String,
    required: [true, "District name requried"],
  },
  state: {
    type: String,
    required: [true, "State name requried"],
  },
  mobileNumber: {
    type: Number,
    required: false, // Allow null for invalid numbers
    // Note: Database has sparse unique index - allows multiple nulls, but valid numbers must be unique
  },
  alternateNumber: {
    type: Number,
    required: false,
  },
  isInvalidPhone: {
    type: Boolean,
    default: false,
  },
  originalPhoneNumber: {
    type: String,
    default: null,
  },
  opt_in: {
    type: Boolean,
    default: false,
  },
  // Array field to store all farmers referred by this farmer
  referredTo: [
    {
      farmerId: {
        type: Schema.Types.ObjectId,
        ref: "Farmer",
        required: true,
      },
      referredAt: {
        type: Date,
        default: Date.now,
      },
      orderId: {
        type: Schema.Types.ObjectId,
        ref: "Order",
      },
    },
  ],
});

// Add compound index for faster lookups by name and location
farmerSchema.index({ name: 1, village: 1, taluka: 1, district: 1 });

// Add index for phone number lookups
farmerSchema.index({ mobileNumber: 1 });
farmerSchema.index({ alternateNumber: 1 });
// Add index for opt_in status lookups
farmerSchema.index({ opt_in: 1 });

const Farmer = model("Farmer", farmerSchema);
export default Farmer;