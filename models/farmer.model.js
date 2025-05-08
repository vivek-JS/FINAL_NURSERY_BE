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
    required: [true, "Mobile number requried"],
    unique: true,
  },
  alternateNumber: {
    type: Number,
    required: false,
  }
});

const Farmer = model("Farmer", farmerSchema);
export default Farmer;