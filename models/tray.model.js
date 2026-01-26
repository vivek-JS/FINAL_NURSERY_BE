import { Schema, model } from "mongoose";

const traySchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    cavity: {
      type: Number,
      required: true,
    },
    numberPerCrate: {
      type: Number,
      required: true,
      min: 1,
    },
    aliases: {
      type: [String],
      default: [],
      // Alternative names that map to this tray (e.g., "Elli" for 10 cavity tray)
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

const Tray = model("Tray", traySchema);

export default Tray;
