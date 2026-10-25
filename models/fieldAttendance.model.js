import { Schema, model } from "mongoose";

const pointSchema = new Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number },
    area: { type: String, default: "" },
  },
  { _id: false }
);

const punchSchema = new Schema(
  {
    at: { type: Date, required: true },
    lat: Number,
    lng: Number,
    accuracy: Number,
    area: { type: String, default: "" },
  },
  { _id: false }
);

const fieldAttendanceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true },
    clockInAt: { type: Date, required: true },
    clockIn: { type: pointSchema, required: true },
    clockOutAt: { type: Date },
    clockOut: { type: pointSchema },
    autoClockOut: { type: Boolean, default: false },
    punches: { type: [punchSchema], default: [] },
  },
  { timestamps: true }
);

fieldAttendanceSchema.index({ userId: 1, date: 1 }, { unique: true });

const FieldAttendance = model("FieldAttendance", fieldAttendanceSchema);
export default FieldAttendance;
