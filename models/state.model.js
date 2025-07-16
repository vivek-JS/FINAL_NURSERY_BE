import mongoose, { Schema, model } from "mongoose";

const stateSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    districts: [
      {
        name: {
          type: String,
          required: true,
          trim: true,
        },
        code: {
          type: String,
          required: true,
          trim: true,
          uppercase: true,
        },
        talukas: [
          {
            name: {
              type: String,
              required: true,
              trim: true,
            },
            code: {
              type: String,
              required: true,
              trim: true,
              uppercase: true,
            },
            villages: [
              {
                name: {
                  type: String,
                  required: true,
                  trim: true,
                },
                code: {
                  type: String,
                  required: true,
                  trim: true,
                  uppercase: true,
                },
              },
            ],
          },
        ],
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Optimized indexes for better query performance
stateSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
stateSchema.index({ code: 1 }, { unique: true });
stateSchema.index({ "districts.name": 1 });
stateSchema.index({ "districts.talukas.name": 1 });
stateSchema.index({ "districts.talukas.villages.name": 1 });

// Compound indexes for better performance on nested queries
stateSchema.index({ name: 1, "districts.name": 1 });
stateSchema.index({ name: 1, "districts.name": 1, "districts.talukas.name": 1 });

// Text index for search functionality
stateSchema.index({ name: "text", "districts.name": "text", "districts.talukas.name": "text", "districts.talukas.villages.name": "text" });

const State = model("State", stateSchema);
export default State; 