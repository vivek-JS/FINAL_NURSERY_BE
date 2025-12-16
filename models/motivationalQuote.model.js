import { Schema, model } from "mongoose";

const motivationalQuoteSchema = new Schema(
  {
    id: {
      type: Number,
      required: true,
      unique: true,
    },
    line1: {
      type: String,
      required: true,
    },
    line2: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index for faster queries
motivationalQuoteSchema.index({ id: 1 });
motivationalQuoteSchema.index({ isActive: 1 });

const MotivationalQuote = model("MotivationalQuote", motivationalQuoteSchema);

export default MotivationalQuote;

