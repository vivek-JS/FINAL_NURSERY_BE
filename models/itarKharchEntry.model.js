import { Schema, model } from "mongoose";

const itarKharchEntrySchema = new Schema(
  {
    category: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    note: {
      type: String,
      trim: true,
      default: "",
    },
    entryDate: {
      type: Date,
      default: Date.now,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

const ItarKharchEntry = model("ItarKharchEntry", itarKharchEntrySchema);

export default ItarKharchEntry;
