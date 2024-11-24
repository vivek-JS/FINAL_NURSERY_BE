import { Schema, model } from "mongoose";

// Define the schema for slots
const slotSchema = new Schema({
  startDay: {
    type: Number,
    required: true,
  },
  endDay: {
    type: Number,
    required: true,
  },
  totalPlants: {
    type: Number,
    default: 0,
  },
  totalBookedPlants: {
    type: Number,
    default: 0,
  },
  orders: {
    type: [Schema.Types.ObjectId], // Array of references to an Order model
    default: [],
  },
  overflow: {
    type: Boolean,
    default: false,
  },
  status: {
    type: Boolean,
    default: false,
  },
  month: {
    type: String, // Field to store the name of the month
    required: true,
    enum: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ], // Restricting values to valid month names
  },
});

const subtypeSlotSchema = new Schema({
  subtypeId: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms.subtypes", // Reference to the subtype of the PlantCms model
    required: true,
  },
  slots: {
    type: [slotSchema], // Array of slot schemas
    default: [],
  },
});

const plantSlotSchema = new Schema({
  plantId: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms", // Reference to the main plant in the PlantCms model
    required: true,
    index: true,
  },
  year: {
    type: Number, // Field to store the year
    required: true,
    index: true,
  },
  subtypeSlots: {
    type: [subtypeSlotSchema], // Array of subtype slot schemas
    default: [],
    index: true,
  },
});

const PlantSlot = model("PlantSlot", plantSlotSchema);

export default PlantSlot;
