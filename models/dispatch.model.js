import { Schema, model } from "mongoose";

const pickupDetailSchema = new Schema({
  shade: {
    type: String,
    required: true,
  },
  shadeName: {
    type: String,
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
  },
  // Added cavity reference to pickupDetails
  cavity: {
    type: Schema.Types.ObjectId,
    ref: "Tray",
    required: true,
  },
  cavityName: {
    type: String,
    required: true,
  }
});

const crateSchema = new Schema({
  cavity: {
    type: Schema.Types.ObjectId,
    ref: "Tray",
    required: true,
  },
  cavityName: {
    type: String,
    required: true,
  },
  crateCount: {
    type: Number,
    required: true,
  },
  plantCount: {
    type: Number,
    required: true,
  },
  crateDetails: [
    {
      crateCount: Number,
      plantCount: Number,
    },
  ],
});

const plantDetailSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  id: {
    type: String,
    required: true,
  },
  plantId: {
    type: Schema.Types.ObjectId,
    ref: "Plant",
    required: true,
  },
  subTypeId: {
    type: Schema.Types.ObjectId,
    ref: "SubType",
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
  },
  totalPlants: {
    type: Number,
    required: true,
  },
  pickupDetails: {
    type: [pickupDetailSchema],
    validate: {
      validator: function (array) {
        return array.length >= 1;
      },
      message: "At least one pickup detail is required per plant",
    },
    required: true,
  },
  crates: {
    type: [crateSchema],
    validate: {
      validator: function (array) {
        return array.length >= 1;
      },
      message: "At least one crate is required per plant",
    },
    required: true,
  },
});

const dispatchSchema = new Schema(
  {
    name: {
      type: String,
    },
    transportId: {
      type: String,
      required: true,
      unique: true,
    },
    // Added transportStatus field with enum values and default
    transportStatus: {
      type: String,
      enum: ["PENDING", "DELIVERED", "IN_TRANSIT", "CANCELLED"],
      default: "PENDING",
    },
    orderIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "Order",
        },
      ],
      validate: {
        validator: function (array) {
          return array.length >= 1;
        },
        message: "At least one order ID is required",
      },
      required: true,
    },
    // New field added here
    afterDispatchedOrderIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "Order",
        },
      ],
      default: [], // Default to empty array as it may not be required initially
    },
    // Field to track partial/split dispatch quantities per order
    orderDispatchDetails: {
      type: [
        {
          orderId: {
            type: Schema.Types.ObjectId,
            ref: "Order",
            required: true,
          },
          dispatchQuantity: {
            type: Number,
            required: true,
          },
          remainingAfterDispatch: {
            type: Number,
            required: true,
          },
          isPartialDispatch: {
            type: Boolean,
            default: false,
          },
        },
      ],
      default: [], // Optional for backward compatibility
    },
    driverName: {
      type: String,
      required: true,
    },
    vehicleName: {
      type: String,
      required: true,
    },
    isDeleted: {
      type: Boolean,
      default: false, // This ensures new documents start as not deleted
    },
    // Add returnedPlants field to track total returns for the dispatch
    returnedPlants: {
      type: Number,
      default: 0,
    },
    plantsDetails: {
      type: [plantDetailSchema],
      validate: {
        validator: function (array) {
          return array.length >= 1;
        },
        message: "At least one plant detail is required",
      },
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Add index for transportStatus for faster queries
dispatchSchema.index({ transportStatus: 1 });
// Note: transportId already has unique index from field definition
// Add compound index for query optimization
dispatchSchema.index({ transportStatus: 1, createdAt: -1 });

const Dispatch = model("Dispatch", dispatchSchema);

export default Dispatch;