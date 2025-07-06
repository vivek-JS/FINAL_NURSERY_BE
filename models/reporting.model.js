import mongoose, { Schema, model } from "mongoose";

const reportedFarmerSchema = new Schema({
  farmer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Farmer",
    required: true,
  },
  nameOfPlant: {
    type: String,
  },
  totalPlants: {
    type: Number,
  },
  timeOfPlantation: {
    type: Date,
  },
  reportedBy: {
    type: mongoose.Types.ObjectId,
    ref: "user",
    required: true,
  },
});

const ReportedFarmer = model("ReportedFarmer", reportedFarmerSchema);
export default ReportedFarmer;
