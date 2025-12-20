import { Schema, model } from "mongoose";

const followUpSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: "",
  },
  followUpDate: {
    type: String,
    required: true,
  },
  dueTime: {
    type: String,
    default: "",
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high"],
    default: "medium",
  },
  status: {
    type: String,
    enum: ["pending", "completed", "incomplete", "not_done"],
    default: "pending",
  },
  publicToken: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  completedAt: {
    type: Date,
  },
}, { _id: true });

const employeeSchema = new Schema({
  employee_id: {
    type: String,
    unique: true,
    sparse: true,
  },
  name: {
    type: String,
    require: true,
  },
  email: {
    type: String,
    require: true,
    unique: true,
  },
  phoneNumber: {
    type: Number,
    require: true,
    unique: true,
  },
  mobile: {
    type: String,
  },
  department: {
    type: String,
  },
  jobTitle: {
    type: String,
  },
  followUps: {
    type: [followUpSchema],
    default: [],
  },
});

employeeSchema.index({ employee_id: 1 });
employeeSchema.index({ name: 1 });
employeeSchema.index({ phoneNumber: 1 });

const Employee = model("Employee", employeeSchema);

export default Employee;
