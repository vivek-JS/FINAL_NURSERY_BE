import { Schema, model } from "mongoose";

const notificationInboxSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    type: {
      type: String,
      default: "custom",
      trim: true,
    },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationInboxSchema.index({ user: 1, createdAt: -1 });

const NotificationInbox = model("NotificationInbox", notificationInboxSchema);

export default NotificationInbox;
