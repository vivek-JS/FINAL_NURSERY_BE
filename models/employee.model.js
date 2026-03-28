import { Schema, model } from "mongoose";

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
});

employeeSchema.index({ employee_id: 1 });
employeeSchema.index({ name: 1 });
employeeSchema.index({ phoneNumber: 1 });

const Employee = model("Employee", employeeSchema);

export default Employee;
