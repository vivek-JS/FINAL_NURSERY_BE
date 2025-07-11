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
  // Virtual field to calculate available plants (can be negative for overflow)
  availablePlants: {
    type: Number,
    default: function() {
      return this.totalPlants;
    }
  },
  // Flag to indicate if this slot is in overflow state
  isOverflow: {
    type: Boolean,
    default: false,
  },
  orders: {
    type: [Schema.Types.ObjectId], // Array of references to an Order model
    default: [],
  },
  // Array to store salesman IDs who can access this slot (empty = all can access)
  allowedSalesmen: {
    type: [Schema.Types.ObjectId],
    ref: "User", // Reference to User model
    default: [],
  },
  // Flag to enable/disable salesman restrictions
  restrictToSalesmen: {
    type: Boolean,
    default: false,
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
  isManual: {
    type: Boolean,
    default: false,
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
