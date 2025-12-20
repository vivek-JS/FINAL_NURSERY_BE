import { Schema, model } from "mongoose";

const followUpCommentSchema = new Schema({
  employeeId: {
    type: Schema.Types.ObjectId,
    ref: "Employee",
    required: true,
    index: true,
  },
  followUpId: {
    type: Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
  },
  comment: {
    type: String,
    required: true,
  },
  statusUpdate: {
    type: String,
    enum: ["pending", "completed", "incomplete", "not_done"],
  },
  ip: {
    type: String,
  },
  userAgent: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

followUpCommentSchema.index({ employeeId: 1, followUpId: 1 });
followUpCommentSchema.index({ createdAt: -1 });

const FollowUpComment = model("FollowUpComment", followUpCommentSchema);

export default FollowUpComment;



