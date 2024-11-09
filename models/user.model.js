import { Schema, model } from "mongoose";

const userSchema = new Schema({
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
  password: {
    type: String,
    require: true,
  },
  jobTitle: {
    type: String,
  },
  type: {
    type: String,
    enum: ["ADMIN", "SALES PERSON", "INVENTORY MANAGER"],
  },
});

const User = model("User", userSchema);

export default User;
