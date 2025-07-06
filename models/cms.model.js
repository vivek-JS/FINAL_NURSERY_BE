import { Schema, model } from "mongoose";

const cmsSchema = new Schema({
  data: {
    type: String,
  },
  type: {
    type: String,
    enum: [
      "village",
      "taluka",
      "district",
      "jobTitle",
      "crop",
      "variety",
      "vendor",
    ],
  },
});

const CMS = model("CMS", cmsSchema);

export default CMS;
