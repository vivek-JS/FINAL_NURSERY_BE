import { Schema, model } from "mongoose";

const batchSchema = new Schema({
 batchNumber: {
   type: String,
   required: true,
   unique: true
 },
 dateAdded: {
   type: Date,
   required: true,
   default: Date.now
 },
 isActive: {
   type: Boolean,  
   default: true
 }
}, {
 timestamps: true
});

const Batch = model("Batch", batchSchema);

export default Batch;