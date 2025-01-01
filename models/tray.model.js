import { Schema, model } from "mongoose";

const traySchema = new Schema({
 name: {
   type: String,
   required: true,
 },
 cavity: {
   type: Number, 
   required: true,
 },
 numberPerCrate: {
   type: Number,
   required: true,
   min: 1,

 },
 isActive: {
   type: Boolean,
   default: true,
 }
}, {
 timestamps: true
});

const Tray = model("Tray", traySchema);

export default Tray;