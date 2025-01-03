import { Schema, model } from "mongoose";

const pollyHouseSchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

const PollyHouse = model("PollyHouse", pollyHouseSchema);
export default PollyHouse;