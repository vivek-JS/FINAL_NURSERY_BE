import mongoose, { Schema, model } from "mongoose";

const inoculationSchema = new Schema(
  {
    operator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    nameOfOperator: {
      type: String,
    },
    in: {
      type: Number,
    },
    out: {
      type: Number,
    },
  },
  { _id: false, timestamps: true }
);

const contaminationSchema = new Schema(
  {
    numberOfBottles: {
      type: Number,
    },
    percentageOfContamination: {
      type: Number,
    },
    in: {
      type: Number,
    },
    out: {
      type: Number,
    },
  },
  { _id: false, timestamps: true }
);

const mediaRoomSchema = new Schema(
  {
    numberOfBottles: {
      type: Number,
    },
    numberOfLitersCreated: {
      type: Number,
    },
    numberOfEmployeeEngaged: {
      type: Number,
    },
    listOfEmployeeEngaged: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    in: {
      type: Number,
    },
    out: {
      type: Number,
    },
  },
  { _id: false, timestamps: true }
);

const washingSchema = new Schema(
  {
    numberOfBottles: {
      type: Number,
    },
    numberOfEmployeeEngaged: {
      type: Number,
    },
    listOfEmployeeEngaged: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    in: {
      type: Number,
    },
    out: {
      type: Number,
    },
  },
  { _id: false, timestamps: true }
);

const platesSchema = new Schema(
  {
    numberOfPlates: {
      type: Number,
    },
    numberOfEmployeeEngaged: {
      type: Number,
    },
    listOfEmployeeEngaged: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    in: {
      type: Number,
    },
    out: {
      type: Number,
    },
  },
  { _id: false, timestamps: true }
);

const growthRoomSchema = new Schema(
  {
    numberOfEmployeeEngaged: {
      type: Number,
    },
    listOfEmployeeEngaged: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    in: {
      type: Number,
    },
    out: {
      type: Number,
    },
  },
  { _id: false, timestamps: true }
);

const shootingSchema = new Schema(
  {
    in: {
      type: Number,
    },
    out: {
      type: Number,
    },
  },
  { _id: false, timestamps: true }
);

const rootingOutSchema = new Schema(
  {
    numberOfTrays: {
      type: Number,
    },
    numberOfBottles: {
      type: Number,
    },
    in: {
      type: Number,
    },
    out: {
      type: Number,
    },
  },
  { _id: false, timestamps: true }
);

const labSchema = new Schema({
  batchNumber: {
    type: String,
    required: true,
  },
  startingDate: {
    type: Date,
    default: Date.now(),
    required: true,
  },
  endingDate: {
    type: Date,
  },
  currentProcess: {},
  dateOfDispatch: {
    type: Date,
  },
  shadeNumber: {
    type: Number,
  },
  inoculation: inoculationSchema,
  contamination: contaminationSchema,
  mediaRoom: mediaRoomSchema,
  washing: washingSchema,
  plate: platesSchema,
  growthRoom: growthRoomSchema,
  shooting: shootingSchema,
  rootingOut: rootingOutSchema,
});

const Lab = model("Lab", labSchema);
export default Lab;
