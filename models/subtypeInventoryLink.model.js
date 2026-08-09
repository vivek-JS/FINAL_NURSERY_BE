import mongoose from "mongoose";

/**
 * Explicit 1:N sowing inventory links: one CMS plant+subtype may map to
 * many Biotech warehouse products and many Ram Agri Input varieties.
 */
const subtypeInventoryLinkSchema = new mongoose.Schema(
  {
    plantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
      index: true,
    },
    subtypeId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ["BIOTECH", "RAM_AGRI"],
      required: true,
    },
    /** Biotech / classic inventory Product (when source = BIOTECH). */
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    /** Ram Agri Inputs crop + variety (when source = RAM_AGRI). */
    ramAgriCropId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RamAgriInputsProduct",
      default: null,
    },
    ramAgriVarietyId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    label: {
      type: String,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

subtypeInventoryLinkSchema.index(
  { plantId: 1, subtypeId: 1, source: 1, productId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: "BIOTECH",
      productId: { $type: "objectId" },
      isActive: true,
    },
  }
);

subtypeInventoryLinkSchema.index(
  { plantId: 1, subtypeId: 1, source: 1, ramAgriVarietyId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: "RAM_AGRI",
      ramAgriVarietyId: { $type: "objectId" },
      isActive: true,
    },
  }
);

subtypeInventoryLinkSchema.index({ plantId: 1, subtypeId: 1, isActive: 1 });

const SubtypeInventoryLink = mongoose.model(
  "SubtypeInventoryLink",
  subtypeInventoryLinkSchema
);

export default SubtypeInventoryLink;
