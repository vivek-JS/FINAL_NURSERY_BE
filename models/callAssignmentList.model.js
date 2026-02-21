import { Schema, model } from "mongoose";

const callLogSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    timestamp: { type: Date, default: Date.now },
    remark: { type: String, default: "" },
    result: {
      type: String,
      enum: ["connected", "no_answer", "not_interested", "done", "callback", "other"],
      default: "other",
    },
    durationSeconds: { type: Number, default: null },
  },
  { _id: true }
);

const entrySchema = new Schema(
  {
    source: { type: String, enum: ["farmer", "lead"], required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    phone: { type: String, required: true },
    name: { type: String, required: true },
    village: { type: String, default: "" },
    district: { type: String, default: "" },
    taluka: { type: String, default: "" },
    stateName: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "done"],
      default: "pending",
    },
    callLogs: { type: [callLogSchema], default: [] },
  },
  { _id: true }
);

const callAssignmentListSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    entries: { type: [entrySchema], default: [] },
    completedEntries: { type: [entrySchema], default: [] },
    isActive: { type: Boolean, default: true },
    publicToken: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
    },
    linkExpiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 18 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

callAssignmentListSchema.index({ assignedTo: 1 });
callAssignmentListSchema.index({ isActive: 1 });
callAssignmentListSchema.index({ "entries.sourceId": 1, "entries.source": 1 });

const CallAssignmentList = model("CallAssignmentList", callAssignmentListSchema);
export default CallAssignmentList;
