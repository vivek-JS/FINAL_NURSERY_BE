import { Schema, model, Types } from "mongoose";

const stockSchema = new Schema({
  date: {
    type: Date,
    default: Date.now(),
  },
  itemName: {
    type: String,
    required: true,
  },
});

const godownStockInwardSchema = stockSchema.clone();
godownStockInwardSchema.add({
  qty: {
    type: Number,
    required: true,
  },
  inwardBy: {
    type: Types.ObjectId,
    ref: "employee",
    required: true,
  },
});

const godownStockOutwardSchema = stockSchema.clone();

godownStockOutwardSchema.add({
  outwardTo: {
    type: String,
    required: true,
  },
  reasonOfOutward: {
    type: String,
    required: true,
  },
  batchNumber: {
    type: Number,
    required: true,
  },
});

const options = { timestamps: true };

const GodownStockInward = model(
  "GodownStockInward",
  godownStockInwardSchema,
  options
);
const GodownStockOutward = model(
  "GodownStockOutward",
  godownStockOutwardSchema,
  options
);

export { GodownStockInward, GodownStockOutward };
