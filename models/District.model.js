import mongoose, { Schema, model } from "mongoose";

// Define schema for districts
const districtSchema = new Schema(
  {
    stateName: {
      type: String,
      required: true,
      unique: true,
    },
    districts: [
      {
        district: {
          type: String,
          required: true,
        },
        subDistricts: [
          {
            subDistrict: {
              type: String,
              required: true,
            },
            villages: [
              {
                type: String,
              },
            ],
          },
        ],
      },
    ],
  },
  { timestamps: true }
);

const District = model("District", districtSchema);
export default District;
