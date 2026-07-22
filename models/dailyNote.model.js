import { Schema, model } from "mongoose";

const MOODS = ["great", "good", "okay", "low", "stressed"];

const dailyNoteSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** Calendar day in Asia/Kolkata as YYYY-MM-DD */
    noteDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    title: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 10000,
    },
    mood: {
      type: String,
      enum: MOODS,
      required: false,
      default: undefined,
    },
    tags: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
    strict: true,
  }
);

dailyNoteSchema.index({ user: 1, noteDate: 1 }, { unique: true });
dailyNoteSchema.index({ user: 1, createdAt: -1 });

export { MOODS };
const DailyNote = model("DailyNote", dailyNoteSchema);
export default DailyNote;
