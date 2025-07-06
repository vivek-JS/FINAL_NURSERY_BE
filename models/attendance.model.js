import mongoose, { Schema, model } from "mongoose";

const attendanceSchema = new Schema({
  employee: {
    type: mongoose.Types.ObjectId,
    ref: "employee",
    require: true,
  },
  date: {
    type: Date,
    default: Date.now(),
  },
  status: {
    type: String,
    enum: ["PRESENT", "HALF-DAY", "ABSENT"],
    required: true,
  },
});

const Attendance = model("Attendance", attendanceSchema);

export default Attendance;
