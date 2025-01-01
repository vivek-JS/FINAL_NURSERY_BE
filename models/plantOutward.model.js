import { Schema, model } from "mongoose";

const labSchema = new Schema({
 outwardDate: {
   type: Date,
   required: true,
   default: Date.now
 },
 size: {
   type: String,
   required: true,
   enum: ['R1', 'R2', 'R3']
},
 bottles: {
   type: Number,
   required: true,
   min: 1
 }, 
 plants: {
   type: Number,
   required: true,
   min: 1
 },
 rootingDate: {
   type: Date,
   required: true
 }
});

const outwardSchema = new Schema({
 labs: [labSchema]
});

const plantOutwardSchema = new Schema({
    batchId: {
        type: Schema.Types.ObjectId,
        ref: 'Batch',
        required: true
      },
 dateAdded: {
   type: Date,
   required: true,
   default: Date.now
 },
 outward: [outwardSchema],
 isActive: {
   type: Boolean,
   default: true
 }
}, {
 timestamps: true
});

const PlantOutward = model("PlantOutward", plantOutwardSchema);

export default PlantOutward;