import { Schema, model } from "mongoose";

const broadcastGroupSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: String,
    members: [
      {
        type: Schema.Types.ObjectId,
        ref: "Farmer",
        required: true,
      },
    ],
  },
  { timestamps: true }
);

const BroadcastGroup = model("BroadcastGroup", broadcastGroupSchema);

export default BroadcastGroup;
