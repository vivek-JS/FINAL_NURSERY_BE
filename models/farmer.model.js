import mongoose, { Schema, model } from "mongoose";

const farmerSchema = new Schema({
  name: {
    type: String,
    required: [true, "Farmer name required"],
  },
  village: {
    type: String,
    required: [true, "Village name required"],
  },
  villageID: {
    type: Schema.Types.ObjectId, // MongoDB ObjectId
    required: [true, "Village ID required"],
  },
  taluka: {
    type: String,
    required: [true, "Taluka name required"],
  },
  district: {
    type: String,
    required: [true, "District name required"],
  },
  mobileNumber: {
    type: Number,
    required: [true, "Mobile number required"],
    unique: true,
  },
});

const Farmer = model("Farmer", farmerSchema);
export default Farmer;
