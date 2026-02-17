import mongoose from "mongoose";
const { Schema, model } = mongoose;

const contactSchema = new Schema(
  {
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
    },
    name: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false }
);

const whatsappContactListSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "List name is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    source: {
      type: String,
      enum: ["excel", "manual"],
      default: "excel",
    },
    contacts: [contactSchema],
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
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

whatsappContactListSchema.index({ name: 1 });
whatsappContactListSchema.index({ createdBy: 1 });
whatsappContactListSchema.index({ isActive: 1 });

const WhatsAppContactList = model("WhatsAppContactList", whatsappContactListSchema);
export default WhatsAppContactList;
