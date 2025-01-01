import { Schema, model } from "mongoose";

const pickupDetailSchema = new Schema({
  shade: {
    type: String,
    required: true
  },
  shadeName: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true
  }
});

const crateSchema = new Schema({
  cavity: {
    type: String,
    required: true
  },
  cavityName: {
    type: String,
    required: true
  },
  crateCount: {
    type: Number,
    required: true
  },
  plantCount: {
    type: Number, 
    required: true
  },
  crateDetails: [{
    crateCount: Number,
    plantCount: Number
  }]
});

const plantDetailSchema = new Schema({
  name: {
    type: String,
    required: true
  },
  id: {
    type: String,
    required: true
  },
  plantId: {
    type: Schema.Types.ObjectId,
    ref: 'Plant',
    required: true
  },
  subTypeId: {
    type: Schema.Types.ObjectId,
    ref: 'SubType',
    required: true
  },
  quantity: {
    type: Number,
    required: true
  },
  totalPlants: {
    type: Number,
    required: true
  },
  pickupDetails: {
    type: [pickupDetailSchema],
    validate: {
      validator: function(array) {
        return array.length >= 1;
      },
      message: 'At least one pickup detail is required per plant'
    },
    required: true
  },
  crates: {
    type: [crateSchema],
    validate: {
      validator: function(array) {
        return array.length >= 1;
      },
      message: 'At least one crate is required per plant'
    },
    required: true
  }
});

const dispatchSchema = new Schema({
  name: {
    type: String
  },
  transportId: {
    type: String,
    required: true,
    unique: true
  },
  orderIds: {
    type: [{
      type: Schema.Types.ObjectId,
      ref: 'Order'
    }],
    validate: {
      validator: function(array) {
        return array.length >= 1;
      },
      message: 'At least one order ID is required'
    },
    required: true
  },
  driverName: {
    type: String,
    required: true
  },
  vehicleName: {
    type: String,
    required: true
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  returnedPlants: {
    type: Number,
    default: 0  // Default to 0 returned plants
  },
  transportStatus: {
    type: String,
    enum: ["PENDING", "IN_TRANSIT", "DELIVERED", "CANCELLED"],
    default: "PENDING"
  },
  plantsDetails: {
    type: [plantDetailSchema],
    validate: {
      validator: function(array) {
        return array.length >= 1;
      },
      message: 'At least one plant detail is required'
    },
    required: true
  }
}, {
  timestamps: true
});

const Dispatch = model("Dispatch", dispatchSchema);

export default Dispatch;