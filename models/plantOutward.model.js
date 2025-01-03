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

// New primaryInward schema
const primaryInwardSchema = new Schema({
  primaryInwardDate: {
    type: Date,
    required: true
  },
  numberOfBottles: {
    type: Number,
    required: true,
    min: 1
  },
  size: {
    type: String,
    required: true,
    enum: ['R1', 'R2', 'R3']
  },
  cavity: {
    type: Number,
    required: true,
    min: 1
  },
  numberOfTrays: {
    type: Number,
    required: true,
    min: 1
  },
  totalQuantity: {
    type: Number,
    required: true,
    min: 1
  },
  pollyhouse: {
    type: String,
    required: true
  },
  laboursEngaged: {
    type: Number,
    required: true,
    min: 1
  }
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
  // Added primaryInward array field
  primaryInward: [primaryInwardSchema],
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