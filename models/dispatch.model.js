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
  },
  /** Optional — nursery batch / secondary inward line picked when shade was chosen (farmer dispatch traceability). */
  batchId: {
    type: Schema.Types.ObjectId,
    ref: "DispatchBatch",
  },
  batchNumber: { type: String, default: "" },
  plantOutwardId: {
    type: Schema.Types.ObjectId,
    ref: "PlantOutward",
  },
  secondaryInwardId: { type: Schema.Types.ObjectId },
  secondaryInwardDate: { type: Date },
  pollyhouseMatched: { type: String, default: "" },
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
  // Driver information for this plant detail
  driverName: {
    type: String,
    default: "",
  },
  driverMobile: {
    type: String,
    default: "",
  },
  // Vehicle information for this plant detail
  vehicleName: {
    type: String,
    default: "",
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
      enum: ["PENDING", "DELIVERED", "IN_TRANSIT", "LOADED", "CANCELLED"],
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
          additionalPlants: {
            type: Number,
            default: 0,
            min: 0,
          },
          totalPlantsAfterAdjustments: {
            type: Number,
            default: 0,
            min: 0,
          },
          isPartialDispatch: {
            type: Boolean,
            default: false,
          },
          // Driver information
          driverName: {
            type: String,
            default: "",
          },
          driverMobile: {
            type: String,
            default: "",
          },
          // Vehicle information
          vehicleName: {
            type: String,
            default: "",
          },
          // Crate details for this order
          crates: {
            type: [
              {
                cavity: {
                  type: String,
                },
                cavityName: {
                  type: String,
                },
                crateCount: {
                  type: Number,
                },
                plantCount: {
                  type: Number,
                },
                crateDetails: [
                  {
                    crateCount: Number,
                    plantCount: Number,
                  },
                ],
              },
            ],
            default: [],
          },
          shedLoadedQuantity: {
            type: Number,
            default: 0,
            min: 0,
          },
          shedLoadedAt: {
            type: Date,
          },
          shedLoadedFromSecondary: {
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
    // CMS references — optional for backward-compat, filled when dispatch is created from the map planner
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleDriver",
      default: null,
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
      default: null,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "VehicleOwner",
      default: null,
    },
    driverRemark: {
      type: String,
      default: "",
    },
    vehicleRemark: {
      type: String,
      default: "",
    },
    driverMobile: {
      type: String,
      default: "",
    },
    vehicleNumber: {
      type: String,
      default: "",
    },
    // Route-planner metadata (set when dispatch is created from OrderMapView)
    routeId: {
      type: String,
      default: "",
    },
    routeNotes: {
      type: String,
      default: "",
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
    damagedPlants: {
      type: Number,
      default: 0,
      min: 0,
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
    /** Single Trip document created when completing this dispatch. */
    tripId: { type: Schema.Types.ObjectId, ref: "Trip", default: null },
    /** Public URL of server-generated delivery challan PDF (DigitalOcean Spaces or mock). */
    deliveryChallanPdfUrl: { type: String, default: "" },
    deliveryChallanPdfGeneratedAt: { type: Date, default: null },
    /** Archived previous delivery challan PDFs (kept on regenerate; S3 not deleted). */
    deliveryChallanPdfHistory: [
      {
        url: { type: String, trim: true },
        generatedAt: { type: Date, default: null },
        replacedAt: { type: Date, default: null },
        generatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      },
    ],
    /** Public URL of server-generated complete invoice PDF (only meaningful when DELIVERED). */
    completeInvoicePdfUrl: { type: String, default: "" },
    completeInvoicePdfGeneratedAt: { type: Date, default: null },
    completeInvoicePdfHistory: [
      {
        url: { type: String, trim: true },
        generatedAt: { type: Date, default: null },
        replacedAt: { type: Date, default: null },
        generatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      },
    ],
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