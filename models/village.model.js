import mongoose, { Schema, model } from "mongoose";

const villageSchema = new Schema({
  village: {
    type: String,
    required: true,
  },
  taluka: {
    type: String,
    required: true,
  },
  district: {
    type: String,
    required: true,
  },
});

const Village = model("Village", villageSchema);
export default Village;
