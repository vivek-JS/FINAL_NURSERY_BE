import { Schema, model } from "mongoose";

const dateSchema = new Schema({
  date: {
    type: Date,
    default: Date.now(),
    required: true,
  },
  batchNumber: {
    type: Number,
    required: true,
  },
  numberOfBottleReceived: {
    type: Number,
    required: true,
  },
});

const plantationSchema = new Schema({
  usedBottles: {
    type: Number,
    required: true,
  },
  batchNumber: {
    type: Number,
    required: true,
  },
  numberOfTrays: {
    type: Number,
    required: true,
  },
  numberOfPlants: {
    type: Number,
    required: true,
  },
  dateToBeDispatched: {
    type: Date,
  },
});

const dispatchSchema = new Schema({
  date: {
    type: Date,
    default: Date.now(),
    required: true,
  },
  batchNumber: {
    type: Number,
    required: true,
  },
  numberOfTraysDispatched: {
    type: Number,
    required: true,
  },
  shadeNumber: {
    type: Number,
    required: true,
  },
});

const primaryHardeningSchema = new Schema(
  {
    initialData: [dateSchema],
    plantation: [plantationSchema],
    dispatch: [dispatchSchema],
  },
  { timestamps: true }
);

const PrimaryHardening = model("PrimaryHardening", primaryHardeningSchema);
export default PrimaryHardening;
