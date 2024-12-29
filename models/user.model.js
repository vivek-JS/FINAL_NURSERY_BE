import { Schema, model } from "mongoose";

const userSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  phoneNumber: {
    type: Number,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
   default:'12345678'
    
  },
  jobTitle: {
    type: String,
    enum: ["Manager", "HR", "SALES", "PRIMARY","OFFEICE_STAFF"],

  },

  isDisabled: {
    type: Boolean,
    default: false,
  },
  defaultState: {
    type: String,
  },
  defaultDistrict: {
    type: String,
  },
  defaultTaluka: {
    type: String,
  },
  defaultVillage: {
    type: String,
  },
  isOnboarded: {
    type: Boolean,
    default:false
  },
});

const User = model("User", userSchema);

export default User;
