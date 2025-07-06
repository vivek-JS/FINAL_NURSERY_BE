import { Schema, model } from "mongoose";

const employeeSchema = new Schema({
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
  jobTitle: {
    type: String,
  },
});

const Employee = model("Employee", employeeSchema);

export default Employee;
