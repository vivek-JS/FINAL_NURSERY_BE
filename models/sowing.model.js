import { Schema, model } from "mongoose";
import moment from "moment";

const sowingSchema = new Schema({
  plantId: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms",
    required: true,
    index: true,
  },
  plantName: {
    type: String,
    required: true,
  },
  subtypeId: {
    type: Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  subtypeName: {
    type: String,
    required: true,
  },
  slotId: {
    type: Schema.Types.ObjectId,
    ref: "PlantSlot",
    index: true,
  },
  // Original entry slot selected from UI (can differ from target slot used for updates)
  entrySlotId: {
    type: Schema.Types.ObjectId,
    ref: "PlantSlot",
    index: true,
  },
  // Target slot resolved by backend mapping rule
  targetSlotId: {
    type: Schema.Types.ObjectId,
    ref: "PlantSlot",
    index: true,
  },
  mappedByRule: {
    type: String,
    default: null,
  },
  // Sowing details
  sowingDate: {
    type: String, // Format: dd-mm-yyyy
    required: true,
    validate: {
      validator: function (value) {
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  },
  plantReadyDays: {
    type: Number,
    required: true,
    min: 0,
  },
  expectedReadyDate: {
    type: String, // Format: dd-mm-yyyy (calculated from sowingDate + plantReadyDays)
    required: true,
    validate: {
      validator: function (value) {
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  },
  // Quantity tracking
  totalQuantityRequired: {
    type: Number,
    required: true,
    min: 0,
  },
  officeSowed: {
    type: Number,
    default: 0,
    min: 0,
  },
  primarySowed: {
    type: Number,
    default: 0,
    min: 0,
  },
  totalSowed: {
    type: Number,
    default: 0,
    min: 0,
  },
  remainingToSow: {
    type: Number,
    default: function() {
      return this.totalQuantityRequired - this.totalSowed;
    },
  },
  // Status tracking
  status: {
    type: String,
    enum: ["PENDING", "PARTIALLY_SOWED", "FULLY_SOWED", "READY", "OVERDUE"],
    default: "PENDING",
  },
  // Reminder configuration
  reminderBeforeDays: {
    type: Number,
    default: 5,
    min: 0,
  },
  reminderDate: {
    type: String, // Format: dd-mm-yyyy (expectedReadyDate - reminderBeforeDays)
    validate: {
      validator: function (value) {
        if (!value) return true;
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  },
  // Related order information
  orderId: {
    type: Schema.Types.ObjectId,
    ref: "Order",
  },
  orderNumber: {
    type: String,
  },
  /** Links sowing rows to DispatchBatch.batchNumber for lab→primary countdowns */
  batchNumber: {
    type: String,
    trim: true,
    index: true,
  },
  /** When set, plant-ready countdowns can resolve sowing even if batchNumber text differs */
  dispatchBatchId: {
    type: Schema.Types.ObjectId,
    ref: "DispatchBatch",
    index: true,
  },
  // Notes and tracking
  notes: {
    type: String,
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {},
  },
  sowingLocation: {
    type: String,
    enum: ["OFFICE", "PRIMARY", "BOTH"],
    default: "OFFICE",
  },
  // User tracking
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  // Sowing history
  sowingHistory: [{
    date: {
      type: String,
      required: true,
    },
    location: {
      type: String,
      enum: ["OFFICE", "PRIMARY"],
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    notes: String,
    timestamp: {
      type: Date,
      default: Date.now,
    },
  }],
  // Actual harvest tracking
  harvestedQuantity: {
    type: Number,
    default: 0,
    min: 0,
  },
  harvestDate: {
    type: String,
    validate: {
      validator: function (value) {
        if (!value) return true;
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  },
  yieldPercentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
}, {
  timestamps: true,
});

// Indexes for better query performance
sowingSchema.index({ plantId: 1, subtypeId: 1, sowingDate: 1 });
sowingSchema.index({ status: 1, expectedReadyDate: 1 });
sowingSchema.index({ reminderDate: 1 });
sowingSchema.index({ batchNumber: 1, sowingDate: 1 });
sowingSchema.index({ dispatchBatchId: 1, sowingDate: 1 });

// Virtual field to check if sowing is overdue
sowingSchema.virtual('isOverdue').get(function() {
  const today = moment().format('DD-MM-YYYY');
  return moment(today, 'DD-MM-YYYY').isAfter(moment(this.sowingDate, 'DD-MM-YYYY')) && 
         this.totalSowed < this.totalQuantityRequired;
});

// Virtual field to check if reminder should be shown
sowingSchema.virtual('shouldShowReminder').get(function() {
  const today = moment().format('DD-MM-YYYY');
  return this.reminderDate && 
         moment(today, 'DD-MM-YYYY').isSameOrAfter(moment(this.reminderDate, 'DD-MM-YYYY')) &&
         this.status !== 'READY';
});

// Pre-save middleware to calculate fields
sowingSchema.pre('save', function(next) {
  if (this.isModified('sowingDate') || this.isModified('plantReadyDays')) {
    if (this.sowingDate) {
      const sowingMoment = moment(this.sowingDate, 'DD-MM-YYYY');
      if (sowingMoment.isValid()) {
        const readyDays = Number(this.plantReadyDays) || 0;
        this.expectedReadyDate = sowingMoment
          .clone()
          .add(readyDays, 'days')
          .format('DD-MM-YYYY');
      }
    }
  }

  // Calculate total sowed in the SAME unit as `totalQuantityRequired`
  // - OFFICE: `totalQuantityRequired` represents packet count, so `totalSowed` must be packet-based.
  // - PRIMARY: `totalQuantityRequired` represents plant count, so `totalSowed` must be primary-based.
  // - BOTH: treat as both counters being same unit, so sum.
  if (this.sowingLocation === "OFFICE") {
    this.totalSowed = this.officeSowed || 0;
  } else if (this.sowingLocation === "PRIMARY") {
    this.totalSowed = this.primarySowed || 0;
  } else {
    this.totalSowed = (this.officeSowed || 0) + (this.primarySowed || 0);
  }
  
  // Calculate remaining to sow
  this.remainingToSow = this.totalQuantityRequired - this.totalSowed;
  
  // Update status based on sowing progress
  if (this.totalSowed === 0) {
    this.status = 'PENDING';
  } else if (this.totalSowed < this.totalQuantityRequired) {
    this.status = 'PARTIALLY_SOWED';
  } else if (this.totalSowed >= this.totalQuantityRequired) {
    const today = moment().format('DD-MM-YYYY');
    if (moment(today, 'DD-MM-YYYY').isSameOrAfter(moment(this.expectedReadyDate, 'DD-MM-YYYY'))) {
      this.status = 'READY';
    } else {
      this.status = 'FULLY_SOWED';
    }
  }
  
  // Check if overdue
  const today = moment().format('DD-MM-YYYY');
  if (moment(today, 'DD-MM-YYYY').isAfter(moment(this.sowingDate, 'DD-MM-YYYY')) && 
      this.totalSowed < this.totalQuantityRequired) {
    this.status = 'OVERDUE';
  }
  
  // Calculate reminder date
  if (this.sowingDate && this.reminderBeforeDays) {
    const sowingMoment = moment(this.sowingDate, 'DD-MM-YYYY');
    const reminderMoment = sowingMoment.clone().subtract(this.reminderBeforeDays, 'days');
    this.reminderDate = reminderMoment.format('DD-MM-YYYY');
  }
  
  // Calculate yield percentage if harvested
  if (this.harvestedQuantity > 0 && this.totalSowed > 0) {
    this.yieldPercentage = (this.harvestedQuantity / this.totalSowed) * 100;
  }
  
  next();
});

// Enable virtuals in JSON
sowingSchema.set('toJSON', { virtuals: true });
sowingSchema.set('toObject', { virtuals: true });

const Sowing = model("Sowing", sowingSchema);

export default Sowing;








