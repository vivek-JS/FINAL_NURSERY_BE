import { Schema, model } from "mongoose";
import moment from "moment"; // Optional: Use moment.js or other libraries for date validation/formatting

// Define the schema for slots
const slotSchema = new Schema({
  startDay: {
    type: String, // Store date in "dd-mm-yyyy" format
    required: true,
    validate: {
      validator: function (value) {
        // Regular expression to validate "dd-mm-yyyy" format
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  },
  endDay: {
    type: String, // Store date in "dd-mm-yyyy" format
    required: true,
    validate: {
      validator: function (value) {
        // Regular expression to validate "dd-mm-yyyy" format
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
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
