import { Schema, model } from "mongoose";

const chemicalSchema = new Schema({
  date: {
    type: Date,
    default: Date.now(),
    require: true,
  },
  nameOfChemical: {
    type: String,
    require: true,
  },
  packing: {
    type: String,
    require: true,
  },
  qty: {
    type: Number,
    require: true,
  },
  rate: {
    type: Number,
    require: true,
  },
});

const Chemical = model("Chemical", chemicalSchema);

export default Chemical;
