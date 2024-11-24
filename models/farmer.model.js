import mongoose, { Schema, model } from "mongoose";

const farmerSchema = new Schema({
  name: {
    type: String,
    required: [true, "Farmer name requried"],
  },
  village: {
    type: String,
    required: [true, "Village name requried"],
  },
  
  taluka: {
    type: String,
    required: [true, "Taluka name requried"],
  },
  district: {
    type: String,
    required: [true, "District name requried"],
  },
  mobileNumber: {
    type: Number,
    required: [true, "Mobile number requried"],
    unique: true,
  },
});

const Farmer = model("Farmer", farmerSchema);
export default Farmer;
