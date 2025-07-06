import { Schema, model } from "mongoose";

const seedSchema = new Schema({
  date: {
    type: Date,
    default: Date.now(),
  },
  crop: {
    type: String,
    required: true,
  },
  variety: {
    type: String,
    required: true,
  },
  expiry: {
    type: String,
    required: true,
  },
  batchNumber: {
    type: Number,
    required: true,
  },
  packing: {
    type: Number,
    required: true,
  },
  qty: {
    type: Number,
    required: true,
  },
  vendor: {
    type: String,
    required: true,
  },
});

const seedInwardSchema = seedSchema.clone();
seedInwardSchema.add({
  whoBrought: {
    type: Schema.Types.ObjectId,
    ref: "employee",
    required: true,
  },
});

const seedOutwardSchema = seedSchema.clone();
seedOutwardSchema.add({
  whoTook: {
    type: Schema.Types.ObjectId,
    ref: "employee",
    required: true,
  },
});

const SeedInward = model("SeedInward", seedInwardSchema);
const SeedOutward = model("SeedOutward", seedOutwardSchema);

export { SeedInward, SeedOutward };
