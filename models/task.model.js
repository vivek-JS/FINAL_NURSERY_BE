import { Schema, model } from "mongoose";

const taskCommentSchema = new Schema({
  employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  comment: { type: String, required: true },
  statusUpdate: { type: String, enum: ["pending", "in_progress", "completed", "cancelled"] },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const taskSchema = new Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    default: "",
  },
  dueDate: {
    type: String,
    required: true,
  },
  dueTime: {
    type: String,
    default: "",
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high", "urgent"],
    default: "medium",
  },
  status: {
    type: String,
    enum: ["pending", "in_progress", "completed", "cancelled"],
    default: "pending",
  },
  assignedEmployees: [{
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  }],
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  comments: {
    type: [taskCommentSchema],
    default: [],
  },
  completedBy: [{
    employeeId: { type: Schema.Types.ObjectId, ref: "User" },
    completedAt: { type: Date, default: Date.now },
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  completedAt: {
    type: Date,
  },
});

taskSchema.index({ assignedEmployees: 1 });
taskSchema.index({ createdBy: 1 });
taskSchema.index({ status: 1 });
taskSchema.index({ dueDate: 1 });
taskSchema.index({ createdAt: -1 });

const Task = model("Task", taskSchema);

export default Task;



