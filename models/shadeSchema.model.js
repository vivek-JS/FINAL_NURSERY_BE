import { Schema, model } from "mongoose";

const shadeSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  number: {
    type: String,
    required: true,
    unique: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  }
}, {
  timestamps: true
});

const Shade = model("Shade", shadeSchema);

export default Shade;