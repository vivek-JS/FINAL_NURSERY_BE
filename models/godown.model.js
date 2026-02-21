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

// Enable timestamps on the cloned schemas instead of passing an options object
// as the third parameter to `model()` (third param is interpreted as collection name).
godownStockInwardSchema.set("timestamps", true);
godownStockOutwardSchema.set("timestamps", true);

const GodownStockInward = model("GodownStockInward", godownStockInwardSchema);
const GodownStockOutward = model("GodownStockOutward", godownStockOutwardSchema);

export { GodownStockInward, GodownStockOutward };
