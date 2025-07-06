import { Schema, model } from "mongoose";

const vegetableSchema = new Schema({
  date: {
    type: Date,
    default: Date.now(),
    require: true,
  },
  crop: {
    type: String,
    require: true,
  },
  variety: {
    type: String,
    require: true,
  },
  batchNumber: {
    type: String,
    require: true,
  },
  expiry: {
    type: String,
    require: true,
  },
  cavity: {
    type: String,
    require: true,
  },
  numberOfTrays: {
    type: Number,
    require: true,
  },
  numberOfPlants: {
    type: Number,
    require: true,
  },
  mortality: {
    type: String,
    require: true,
  },
  deliveryDate: {
    type: Date,
  },
});

const Vegetable = model("Vegetable", vegetableSchema);

export default Vegetable;
