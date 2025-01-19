import { Schema, model } from "mongoose";
import mongoose from "mongoose";
import Batch from "./batch.model.js";

// Lab Schema for outward entries
const labSchema = new Schema({
  outwardDate: {
    type: Date,
    required: true,
    default: Date.now,
  },
  size: {
    type: String,
    required: true,
    enum: ["R1", "R2", "R3"],
  },
  bottles: {
    type: Number,
    required: true,
    min: 1,
  },
  plants: {
    type: Number,
    required: true,
    min: 1,
  },
  rootingDate: {
    type: Date,
    required: true,
  },
  transferStatus: {
    type: String,
    enum: ["available", "partially_transferred", "fully_transferred"],
    default: "available",
  },
  transferHistory: [
    {
      transferDate: Date,
      bottlesTransferred: Number,
      plantsTransferred: Number,
      destinationId: Schema.Types.ObjectId,
      remarks: String,
    },
  ],
  availableBottles: {
    type: Number,
    min: 0,
  },
  availablePlants: {
    type: Number,
    min: 0,
  },
});

// Primary Inward Schema
const primaryInwardSchema = new Schema({
  primaryInwardDate: {
    type: Date,
    required: true,
  },
  primaryOutwardExpectedDate: {
    type: Date,
  },
  numberOfBottles: {
    type: Number,
    required: true,
    min: 1,
  },
  size: {
    type: String,
    required: true,
    enum: ["R1", "R2", "R3"],
  },
  cavity: {
    type: Number,
    required: true,
    min: 1,
  },
  numberOfTrays: {
    type: Number,
    required: true,
    min: 1,
  },
  totalQuantity: {
    type: Number,
    required: true,
    min: 1,
  },
  availableQuantity: {
    type: Number,
    min: 0,
  },
  pollyhouse: {
    type: String,
    required: true,
  },
  laboursEngaged: {
    type: Number,
    required: true,
    min: 1,
  },
  transferStatus: {
    type: String,
    enum: ["available", "partially_transferred", "fully_transferred"],
    default: "available",
  },
  transferHistory: [
    {
      transferDate: Date,
      quantityTransferred: Number,
      destinationId: Schema.Types.ObjectId,
      remarks: String,
    },
  ],
});

// Primary Outward Schema
const primaryOutwardSchema = new Schema({
  primaryOutwardDate: {
    type: Date,
    required: true,
  },
  numberOfBottles: {
    type: Number,
    required: true,
    min: 1,
  },
  size: {
    type: String,
    required: true,
    enum: ["R1", "R2", "R3"],
  },
  cavity: {
    type: Number,
    required: true,
    min: 1,
  },
  numberOfTrays: {
    type: Number,
    required: true,
    min: 1,
  },
  totalQuantity: {
    type: Number,
    required: true,
    min: 1,
  },
  availableQuantity: {
    type: Number,
    min: 0,
  },
  pollyhouse: {
    type: String,
    required: true,
  },
  laboursEngaged: {
    type: Number,
    required: true,
    min: 1,
  },
  transferStatus: {
    type: String,
    enum: ["available", "partially_transferred", "fully_transferred"],
    default: "available",
  },
  transferHistory: [
    {
      transferDate: Date,
      quantityTransferred: Number,
      destinationId: Schema.Types.ObjectId,
      remarks: String,
    },
  ],
});

// Secondary Inward Schema
const secondaryInwardSchema = new Schema({
  secondaryInwardDate: {
    type: Date,
    required: true,
  },
  secondaryOutwardExpectedDate: {
    type: Date,
  },
  numberOfBottles: {
    type: Number,
    required: true,
    min: 1,
  },
  size: {
    type: String,
    required: true,
    enum: ["R1", "R2", "R3"],
  },
  cavity: {
    type: Number,
    required: true,
    min: 1,
  },
  numberOfTrays: {
    type: Number,
    required: true,
    min: 1,
  },
  totalQuantity: {
    type: Number,
    required: true,
    min: 1,
  },
  availableQuantity: {
    type: Number,
    min: 0,
  },
  pollyhouse: {
    type: String,
    required: true,
  },
  laboursEngaged: {
    type: Number,
    required: true,
    min: 1,
  },
  transferStatus: {
    type: String,
    enum: ["available", "partially_transferred", "fully_transferred"],
    default: "available",
  },
  transferHistory: [
    {
      transferDate: Date,
      quantityTransferred: Number,
      destinationId: Schema.Types.ObjectId,
      remarks: String,
    },
  ],
});

// Secondary Outward Schema
const secondaryOutwardSchema = new Schema({
  secondaryOutwardDate: {
    type: Date,
    required: true,
  },
  numberOfBottles: {
    type: Number,
    required: true,
    min: 1,
  },
  size: {
    type: String,
    required: true,
    enum: ["R1", "R2", "R3"],
  },
  cavity: {
    type: Number,
    required: true,
    min: 1,
  },
  numberOfTrays: {
    type: Number,
    required: true,
    min: 1,
  },
  totalQuantity: {
    type: Number,
    required: true,
    min: 1,
  },
  availableQuantity: {
    type: Number,
    min: 0,
  },
  pollyhouse: {
    type: String,
    required: true,
  },
  laboursEngaged: {
    type: Number,
    required: true,
    min: 1,
  },
  transferStatus: {
    type: String,
    enum: ["available", "partially_transferred", "fully_transferred"],
    default: "available",
  },
  transferHistory: [
    {
      transferDate: Date,
      quantityTransferred: Number,
      remarks: String,
    },
  ],
});

// Update summary schema to include all stages
const stageSummarySchema = new Schema(
  {
    totalBottles: { type: Number, default: 0 },
    availableBottles: { type: Number, default: 0 },
    totalPlants: { type: Number, default: 0 },
    availablePlants: { type: Number, default: 0 },
    primaryInwardBottles: { type: Number, default: 0 },
    primaryInwardPlants: { type: Number, default: 0 },
    primaryOutwardBottles: { type: Number, default: 0 },
    primaryOutwardPlants: { type: Number, default: 0 },
    secondaryInwardBottles: { type: Number, default: 0 },
    secondaryInwardPlants: { type: Number, default: 0 },
    secondaryOutwardBottles: { type: Number, default: 0 },
    secondaryOutwardPlants: { type: Number, default: 0 },
  },
  { _id: false }
);

const summarySchema = new Schema(
  {
    R1: { type: stageSummarySchema },
    R2: { type: stageSummarySchema },
    R3: { type: stageSummarySchema },
    total: { type: stageSummarySchema },
  },
  { _id: false }
);

// Main Plant Outward Schema
const plantOutwardSchema = new Schema(
  {
    batchId: {
      type: Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
    },
    dateAdded: {
      type: Date,
      required: true,
      default: Date.now,
    },
    outward: [labSchema],
    primaryInward: [primaryInwardSchema],
    primaryOutward: [primaryOutwardSchema],
    secondaryInward: [secondaryInwardSchema],
    secondaryOutward: [secondaryOutwardSchema],
    summary: {
      type: summarySchema,
      default: () => ({
        R1: {},
        R2: {},
        R3: {},
        total: {},
      }),
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Helper function to calculate outward summary
function calculateOutwardSummary(outwardArray) {
  return outwardArray.reduce(
    (summary, lab) => {
      summary[lab.size].totalBottles += lab.bottles;
      summary[lab.size].availableBottles += lab.bottles;
      summary[lab.size].totalPlants += lab.plants;
      summary[lab.size].availablePlants += lab.plants; // Initialize available plants

      summary.total.bottles += lab.bottles;
      summary.total.availableBottles += lab.bottles;
      summary.total.plants += lab.plants;
      summary.total.availablePlants += lab.plants; // Initialize available plants

      return summary;
    },
    {
      R1: {
        totalBottles: 0,
        availableBottles: 0,
        totalPlants: 0,
        availablePlants: 0,
      },
      R2: {
        totalBottles: 0,
        availableBottles: 0,
        totalPlants: 0,
        availablePlants: 0,
      },
      R3: {
        totalBottles: 0,
        availableBottles: 0,
        totalPlants: 0,
        availablePlants: 0,
      },
      total: { bottles: 0, availableBottles: 0, plants: 0, availablePlants: 0 },
    }
  );
}

// Helper function to calculate primary inward summary
function calculatePrimaryInwardSummary(primaryInwardArray) {
  return primaryInwardArray.reduce(
    (summary, item) => {
      const totalPlants = item.cavity * item.numberOfTrays;

      // Add to primary inward counts
      summary[item.size].primaryInwardBottles += item.numberOfBottles;
      summary[item.size].primaryInwardPlants += totalPlants;
      summary[item.size].availableBottles -= item.numberOfBottles;
      summary[item.size].availablePlants -= totalPlants; // Decrease available plants

      // Update totals
      summary.total.primaryInwardBottles += item.numberOfBottles;
      summary.total.primaryInwardPlants += totalPlants;
      summary.total.availableBottles -= item.numberOfBottles;
      summary.total.availablePlants -= totalPlants; // Decrease available plants

      return summary;
    },
    {
      R1: {
        primaryInwardBottles: 0,
        primaryInwardPlants: 0,
        availableBottles: 0,
        availablePlants: 0,
      },
      R2: {
        primaryInwardBottles: 0,
        primaryInwardPlants: 0,
        availableBottles: 0,
        availablePlants: 0,
      },
      R3: {
        primaryInwardBottles: 0,
        primaryInwardPlants: 0,
        availableBottles: 0,
        availablePlants: 0,
      },
      total: {
        primaryInwardBottles: 0,
        primaryInwardPlants: 0,
        availableBottles: 0,
        availablePlants: 0,
      },
    }
  );
}

function calculateSecondaryInwardSummary(secondaryInwardArray) {
  return secondaryInwardArray.reduce(
    (summary, item) => {
      const totalPlants = item.cavity * item.numberOfTrays;

      // Add to secondary inward counts
      summary[item.size].secondaryInwardBottles += item.numberOfBottles;
      summary[item.size].secondaryInwardPlants += totalPlants;
      summary[item.size].primaryOutwardBottles -= item.numberOfBottles;
      summary[item.size].primaryOutwardPlants -= totalPlants; // Decrease from primary outward

      // Update totals
      summary.total.secondaryInwardBottles += item.numberOfBottles;
      summary.total.secondaryInwardPlants += totalPlants;
      summary.total.primaryOutwardBottles -= item.numberOfBottles;
      summary.total.primaryOutwardPlants -= totalPlants;

      return summary;
    },
    {
      R1: {
        secondaryInwardBottles: 0,
        secondaryInwardPlants: 0,
        primaryOutwardBottles: 0,
        primaryOutwardPlants: 0,
      },
      R2: {
        secondaryInwardBottles: 0,
        secondaryInwardPlants: 0,
        primaryOutwardBottles: 0,
        primaryOutwardPlants: 0,
      },
      R3: {
        secondaryInwardBottles: 0,
        secondaryInwardPlants: 0,
        primaryOutwardBottles: 0,
        primaryOutwardPlants: 0,
      },
      total: {
        secondaryInwardBottles: 0,
        secondaryInwardPlants: 0,
        primaryOutwardBottles: 0,
        primaryOutwardPlants: 0,
      },
    }
  );
}

function calculateSecondaryOutwardSummary(secondaryOutwardArray) {
  return secondaryOutwardArray.reduce(
    (summary, item) => {
      const totalPlants = item.cavity * item.numberOfTrays;

      // Add to secondary outward counts
      summary[item.size].secondaryOutwardBottles += item.numberOfBottles;
      summary[item.size].secondaryOutwardPlants += totalPlants;
      summary[item.size].secondaryInwardBottles -= item.numberOfBottles;
      summary[item.size].secondaryInwardPlants -= totalPlants; // Decrease from secondary inward

      // Update totals
      summary.total.secondaryOutwardBottles += item.numberOfBottles;
      summary.total.secondaryOutwardPlants += totalPlants;
      summary.total.secondaryInwardBottles -= item.numberOfBottles;
      summary.total.secondaryInwardPlants -= totalPlants;

      return summary;
    },
    {
      R1: {
        secondaryOutwardBottles: 0,
        secondaryOutwardPlants: 0,
        secondaryInwardBottles: 0,
        secondaryInwardPlants: 0,
      },
      R2: {
        secondaryOutwardBottles: 0,
        secondaryOutwardPlants: 0,
        secondaryInwardBottles: 0,
        secondaryInwardPlants: 0,
      },
      R3: {
        secondaryOutwardBottles: 0,
        secondaryOutwardPlants: 0,
        secondaryInwardBottles: 0,
        secondaryInwardPlants: 0,
      },
      total: {
        secondaryOutwardBottles: 0,
        secondaryOutwardPlants: 0,
        secondaryInwardBottles: 0,
        secondaryInwardPlants: 0,
      },
    }
  );
}

// Helper function to combine summaries
function combineSummaries(outwardSummary, primaryInwardSummary) {
  const sizes = ["R1", "R2", "R3", "total"];
  const combined = {};

  sizes.forEach((size) => {
    const totalBottles = outwardSummary[size].totalBottles || 0;
    const totalPlants = outwardSummary[size].totalPlants || 0;
    const primaryInwardBottles =
      primaryInwardSummary[size].primaryInwardBottles || 0;
    const primaryInwardPlants =
      primaryInwardSummary[size].primaryInwardPlants || 0;

    const availableBottles = Math.max(0, totalBottles - primaryInwardBottles);
    const availablePlants = Math.max(0, totalPlants - primaryInwardPlants);

    combined[size] = {
      totalBottles: totalBottles,
      availableBottles: availableBottles,
      totalPlants: totalPlants,
      availablePlants: availablePlants,
      primaryInwardBottles: primaryInwardBottles,
      primaryInwardPlants: primaryInwardPlants,
    };
  });

  return combined;
}

// Pre-save middleware to calculate availableQuantity
plantOutwardSchema.pre("save", function (next) {
  if (
    this.isModified("outward") ||
    this.isModified("primaryInward") ||
    this.isModified("primaryOutward") ||
    this.isModified("secondaryInward") ||
    this.isModified("secondaryOutward")
  ) {
    // Calculate available quantities
    this.outward.forEach((lab) => {
      const transferredBottles = lab.transferHistory.reduce(
        (sum, t) => sum + t.bottlesTransferred,
        0
      );
      const transferredPlants = lab.transferHistory.reduce(
        (sum, t) => sum + t.plantsTransferred,
        0
      );
      lab.availableBottles = lab.bottles - transferredBottles;
      lab.availablePlants = lab.plants - transferredPlants;
    });

    [
      "primaryInward",
      "primaryOutward",
      "secondaryInward",
      "secondaryOutward",
    ].forEach((stage) => {
      this[stage].forEach((entry) => {
        const transferredQuantity = entry.transferHistory.reduce(
          (sum, t) => sum + t.quantityTransferred,
          0
        );
        entry.availableQuantity = entry.totalQuantity - transferredQuantity;
      });
    });

    // Calculate summaries for all stages
    const outwardSummary = calculateOutwardSummary(this.outward || []);
    const primaryInwardSummary = calculatePrimaryInwardSummary(
      this.primaryInward || []
    );
    const primaryOutwardSummary = calculatePrimaryOutwardSummary(
      this.primaryOutward || []
    );
    const secondaryInwardSummary = calculateSecondaryInwardSummary(
      this.secondaryInward || []
    );
    const secondaryOutwardSummary = calculateSecondaryOutwardSummary(
      this.secondaryOutward || []
    );

    this.summary = combineAllStageSummaries(
      outwardSummary,
      primaryInwardSummary,
      primaryOutwardSummary,
      secondaryInwardSummary,
      secondaryOutwardSummary
    );
  }
  next();
});

// Add the transaction support method back
plantOutwardSchema.statics.updateWithTransaction = async function (
  filter,
  update,
  options = {}
) {
  const session = await this.db.startSession();
  session.startTransaction();

  try {
    const result = await this.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
      session,
      ...options,
    });

    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// Add validateTransfer method
plantOutwardSchema.methods.validateTransfer = function (
  fromStage,
  fromId,
  quantity
) {
  const sourceEntry = this[fromStage].id(fromId);
  if (!sourceEntry) {
    throw new Error("Source entry not found");
  }

  const availableQty =
    fromStage === "outward"
      ? sourceEntry.availablePlants
      : sourceEntry.availableQuantity;

  if (quantity > availableQty) {
    throw new Error(
      `Insufficient quantity available. Required: ${quantity}, Available: ${availableQty}`
    );
  }

  return true;
};

const PlantOutward = model("PlantOutward", plantOutwardSchema);

export default PlantOutward;
