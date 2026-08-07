import { Schema, model } from "mongoose";

const employeeDeviceSchema = new Schema(
  {
    employee_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    device_id: {
      type: String,
      required: true,
    },
    device_name: {
      type: String,
      default: null,
    },
    platform: {
      type: String,
      default: null,
    },
    app_version: {
      type: String,
      default: null,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    registered_at: {
      type: Date,
      default: Date.now,
    },
    last_used_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

employeeDeviceSchema.index({ employee_id: 1, is_active: 1 });
employeeDeviceSchema.index({ employee_id: 1, device_id: 1 });

const EmployeeDevice = model("EmployeeDevice", employeeDeviceSchema);

export default EmployeeDevice;
