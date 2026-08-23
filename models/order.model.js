import mongoose, { Schema, model } from "mongoose";
import {
  patchPaymentUpdateOperation,
  sanitizePaymentArrayForOrder,
} from "../utils/paymentTiming.js";
import {
  allocateNextOrderId,
  ORDER_ID_MIN,
  ORDER_ID_MAX,
} from "../services/orderIdAllocation.service.js";

// Define a schema for delivery change history
const deliveryChangeSchema = new Schema(
  {
    previousDeliveryDate: {
      startDay: String,
      endDay: String,
      month: String,
      year: Number,
    },
    newDeliveryDate: {
      startDay: String,
      endDay: String,
      month: String,
      year: Number,
    },
    previousSlot: {
      type: Schema.Types.ObjectId,
      // Note: This references a subdocument within PlantSlot, cannot use .populate()
      // Use aggregation or manual lookup instead
    },
    newSlot: {
      type: Schema.Types.ObjectId,
      // Note: This references a subdocument within PlantSlot, cannot use .populate()
      // Use aggregation or manual lookup instead
    },
    reasonForChange: {
      type: String,
      required: true,
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      //  required: true,
    },
  },
  { timestamps: true }
);

// Define a schema for status change history
const statusChangeSchema = new Schema(
  {
    previousStatus: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "COMPLETED",
        "CANCELLED",
        "DISPATCHED",
        "ACCEPTED",
        "REJECTED",
        "FARM_READY",
        "READY_FOR_DISPATCH",
        "DISPATCH_PROCESS",
        "PARTIALLY_COMPLETED",
        "TEMPORARY_CANCELLED",
      ],
      required: true,
    },
    newStatus: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "COMPLETED",
        "CANCELLED",
        "DISPATCHED",
        "ACCEPTED",
        "REJECTED",
        "FARM_READY",
        "READY_FOR_DISPATCH",
        "DISPATCH_PROCESS",
        "PARTIALLY_COMPLETED",
        "TEMPORARY_CANCELLED",
      ],
      required: true,
    },
    reason: {
      type: String,
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    notes: {
      type: String,
    },
  },
  { timestamps: true }
);

// Define a schema for farm ready date change history
const farmReadyDateChangeSchema = new Schema(
  {
    previousDate: {
      type: Date,
    },
    newDate: {
      type: Date,
      required: true,
    },
    reason: {
      type: String,
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    notes: {
      type: String,
    },
  },
  { timestamps: true }
);

// Define a schema for general order edit history
const orderEditHistorySchema = new Schema(
  {
    field: {
      type: String,
      required: true,
      // Field that was changed (e.g., 'rate', 'numberOfPlants', 'deliveryDate')
    },
    previousValue: {
      type: Schema.Types.Mixed,
      // Store the old value (can be any type)
    },
    newValue: {
      type: Schema.Types.Mixed,
      required: true,
      // Store the new value (can be any type)
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    notes: {
      type: String,
    },
  },
  { timestamps: true }
);

const whatsappFarmReadyActivityLogSchema = new Schema(
  {
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
    },
    text: {
      type: String,
      trim: true,
      default: "",
    },
    whatsappMessageId: {
      type: String,
      trim: true,
      default: null,
    },
    waId: {
      type: String,
      trim: true,
      default: null,
    },
    /** e.g. farm_ready_confirmed, slot_choice, bot_reply, template_sent */
    action: {
      type: String,
      trim: true,
      default: null,
    },
    sessionStep: {
      type: String,
      trim: true,
      default: null,
    },
    meta: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

const additionalPlantsHistorySchema = new Schema(
  {
    previousTotal: {
      type: Number,
      required: true,
    },
    newTotal: {
      type: Number,
      required: true,
    },
    changeInPlants: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
    },
    notes: {
      type: String,
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

const paymentSchema = new Schema(
  {
    paidAmount: {
      type: Number,
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["COLLECTED", "REJECTED", "PENDING", "BANK_VERIFIED"],
      default: "PENDING",
    },
    paymentDate: {
      type: Date,
      required: true,
    },
    bankName: {
      type: String,
    },
    receiptPhoto: [
      {
        type: String, // Store Cloudinary URLs (strings) for uploaded files
      },
    ],
    modeOfPayment: {
      type: String,
      required: function() {
        return !this.isWalletPayment; // Only required if not a wallet payment
      },
    },
    remark: {
      type: String,
    },
    chequeNumber: {
      type: String,
    },
    transactionId: {
      type: String,
      trim: true,
    },
    isWalletPayment: {
      type: Boolean,
      default: false,
    },
    /** True when this row is a concession, not cash/bank. Accountant still approves it. */
    isDiscount: {
      type: Boolean,
      default: false,
    },
    mainPaymentId: {
      type: Schema.Types.ObjectId,
      ref: "BulkPayment",
      default: null,
    },
    qrReferenceId: { type: String, trim: true },
    qrExpiresAt: { type: Date },
    qrImage: { type: String },
    qrPayload: { type: String },
    /** Customer name copy on payment row (ERP / reconciliation reports). */
    customerName: { type: String, trim: true },
    /** UTR for UPI/NEFT — often same as transactionId; stored explicitly for bank matching. */
    utrNumber: { type: String, trim: true },
    /** ICICI EazyPay QR merchant transaction id */
    merchantTranId: { type: String, trim: true },
    /** ICICI provider transaction id after payment */
    providerTxnId: { type: String, trim: true },
    bankVerificationStatus: {
      type: String,
      enum: ["PENDING", "BANK_VERIFIED", "VERIFY_FAILED", "NOT_REQUIRED"],
      default: "PENDING",
    },
    bankVerificationSource: {
      type: String,
      enum: ["STATEMENT_API", "TXN_STATUS_API", "MANUAL", null],
      default: null,
    },
    bankVerificationMatchedBy: {
      type: String,
      enum: ["UTR", "CHEQUE", "TXN_ID", "AMOUNT_DATE", null],
      default: null,
    },
    bankReferenceNumber: { type: String, trim: true },
    bankNarration: { type: String, trim: true },
    bankAmount: { type: Number },
    bankEntryDate: { type: Date },
    bankRawResponse: { type: Schema.Types.Mixed },
    /** True when more than one bank line matched — do not auto-verify */
    bankReconciliationConflict: { type: Boolean, default: false },
    /** Set when this payment row was created by transferFarmerPlantOrderPayment (audit / UI). */
    transferredFromOrderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    transferredFromPaymentId: { type: Schema.Types.ObjectId, default: null },
    /** Shared id linking source + target rows for direct order payment transfer. */
    orderPaymentTransferId: { type: Schema.Types.ObjectId, default: null },
    /** Links a PENDING payment row to FarmerOrderTransferRequest (approval via payment dashboard). */
    transferRequestId: { type: Schema.Types.ObjectId, ref: "FarmerOrderTransferRequest", default: null },
    /** advance = before first dispatch; balance = on/after first dispatch */
    paymentTiming: {
      type: String,
      enum: ["advance", "balance"],
    },
    /** User who first recorded this payment row. */
    paymentRecordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /** User who last changed payment status (collect / reject / verify). */
    paymentUpdatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Track split history on both the parent and child orders
const splitHistorySchema = new Schema(
  {
    action: {
      type: String,
      enum: ["SPLIT_SOURCE", "SPLIT_CREATED"],
      required: true,
    },
    relatedOrderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
    },
    relatedOrderCode: {
      type: String,
    },
    relatedOrderNumber: {
      type: Number,
      // Human-readable sequential orderId of the related order (parent for SPLIT_CREATED, child for SPLIT_SOURCE)
    },
    originalQuantity: {
      type: Number,
    },
    quantityAfterSplit: {
      type: Number,
    },
    splitQuantity: {
      type: Number,
    },
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    /** Display name of user who performed the split (snapshot at split time). */
    performedByName: {
      type: String,
      trim: true,
    },
    /** Parent order attribution at split time. */
    originalSalesPerson: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    originalSalesPersonName: {
      type: String,
      trim: true,
    },
    originalDealer: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    originalDealerName: {
      type: String,
      trim: true,
    },
    originalDealerOrder: {
      type: Boolean,
    },
    /** Child order attribution assigned at split time. */
    childSalesPerson: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    childSalesPersonName: {
      type: String,
      trim: true,
    },
    childDealer: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    childDealerName: {
      type: String,
      trim: true,
    },
    childDealerOrder: {
      type: Boolean,
    },
    notes: {
      type: String,
    },
  },
  { timestamps: true }
);

/** One plant/subtype line on an instant multi-plant order. */
const plantLineItemSchema = new Schema(
  {
    plantName: {
      type: Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
    },
    plantSubtype: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    /** Denormalized labels for invoice / list UI without deep populate. */
    plantNameSnapshot: {
      type: String,
      trim: true,
      default: "",
    },
    plantSubtypeSnapshot: {
      type: String,
      trim: true,
      default: "",
    },
    /**
     * Snapshot of PlantCms subtype.isBillable at booking time.
     * Missing / undefined ⇒ treat as billable (legacy rows).
     */
    isBillable: {
      type: Boolean,
      default: true,
    },
    bookingSlot: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    numberOfPlants: {
      type: Number,
      required: true,
      min: 1,
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    cavity: {
      type: Schema.Types.ObjectId,
      ref: "Tray",
    },
    deliveryDate: {
      type: Date,
    },
    sortOrder: {
      type: Number,
      default: 0,
      min: 0,
    },
    quotaUsed: {
      type: Number,
      default: 0,
    },
    quotaSource: {
      type: String,
      enum: ["dealer", "company", "none"],
      default: "none",
    },
    walletEntryId: {
      type: Schema.Types.ObjectId,
    },
  },
  { _id: true }
);

export function hasPlantLineItems(doc) {
  return Array.isArray(doc?.plantLineItems) && doc.plantLineItems.length > 0;
}

/**
 * Sync root plant/qty/rate/slot from plantLineItems for legacy readers.
 * Root plant/subtype/slot/rate ← first line; numberOfPlants ← sum of line qtys.
 */
export function rollupPlantLineItemsToRoot(doc) {
  const lines = doc?.plantLineItems;
  if (!Array.isArray(lines) || lines.length === 0) return;

  lines.forEach((line, idx) => {
    if (line && (line.sortOrder == null || line.sortOrder === undefined)) {
      line.sortOrder = idx;
    }
  });

  const first = lines[0];
  let qtySum = 0;
  for (const line of lines) {
    qtySum += Number(line?.numberOfPlants) || 0;
  }

  doc.plantName = first.plantName;
  doc.plantSubtype = first.plantSubtype;
  doc.bookingSlot = first.bookingSlot;
  doc.rate = Number(first.rate) || 0;
  doc.numberOfPlants = qtySum;
  if (first.cavity != null) doc.cavity = first.cavity;
  if (first.deliveryDate != null) doc.deliveryDate = first.deliveryDate;

  const additional = Number(doc.additionalPlants) || 0;
  doc.totalPlants = qtySum + additional;
  if (doc.isNew || doc.remainingPlants == null) {
    doc.remainingPlants = qtySum + additional;
  }
}

const orderSchema = new Schema(
  {
    orderId: {
      type: Number,
      unique: true,
      required: true,
      validate: {
        validator(value) {
          if (!this.isNew) return true;
          return (
            Number.isFinite(value) &&
            value >= ORDER_ID_MIN &&
            value <= ORDER_ID_MAX
          );
        },
        message: `orderId must be between ${ORDER_ID_MIN} and ${ORDER_ID_MAX} for new orders`,
      },
    },
    is_excel: {
      type: Boolean,
      default: false,
    },
    /** 4-digit unique code for WhatsApp templates (farmer-facing order id). */
    publicOrderCode: {
      type: String,
      trim: true,
      match: /^\d{4}$/,
    },
    whatsappAcceptedSentAt: {
      type: Date,
      default: null,
    },
    /** WATI `local_message_id` after accept template send (audit / support). */
    whatsappAcceptedMessageKey: {
      type: String,
      trim: true,
      default: null,
    },
    whatsappPlacedSentAt: {
      type: Date,
      default: null,
    },
    whatsappPlacedMessageKey: {
      type: String,
      trim: true,
      default: null,
    },
    whatsappDispatchSentAt: {
      type: Date,
      default: null,
    },
    /** WATI `local_message_id` after dispatch template send. */
    whatsappDispatchMessageKey: {
      type: String,
      trim: true,
      default: null,
    },
    whatsappFarmReadySentAt: {
      type: Date,
      default: null,
    },
    /** WATI `local_message_id` after order_ready (farm ready) template send. */
    whatsappFarmReadyMessageKey: {
      type: String,
      trim: true,
      default: null,
    },
    /** Farmer tapped "शेत तयार आहे" on WATI farm-ready template. */
    farmReadyWhatsappConfirmedAt: {
      type: Date,
      default: null,
    },
    /** Farmer-initiated delivery reschedule via WATI (after confirmation). */
    farmerWhatsappDeliveryReschedule: {
      rescheduledBy: {
        type: String,
        enum: ["FARMER", null],
        default: null,
      },
      rescheduledAt: {
        type: Date,
        default: null,
      },
      oldDeliveryDate: {
        type: Date,
        default: null,
      },
      whatsappMessageId: {
        type: String,
        trim: true,
        default: null,
      },
    },
    /** Inbound/outbound WATI farm-ready conversation (farmer + bot). */
    whatsappFarmReadyActivityLog: {
      type: [whatsappFarmReadyActivityLogSchema],
      default: [],
    },
    /** Last delivery_final_second cron trigger: past_due | due_in_7_days | farm_ready_status */
    whatsappDeliveryFinalSecondTrigger: {
      type: String,
      trim: true,
      default: null,
    },
    whatsappCancelSentAt: {
      type: Date,
      default: null,
    },
    whatsappCancelMessageKey: {
      type: String,
      trim: true,
      default: null,
    },
    /** Farmer tapped ऑर्डर कन्फर्म आहे after cancel template — order revived to PENDING. */
    revivedViaFarmerWhatsappAt: {
      type: Date,
      default: null,
    },
    revivedViaFarmerWhatsappFromStatus: {
      type: String,
      trim: true,
      default: null,
    },
    revivedViaFarmerWhatsappMessageId: {
      type: String,
      trim: true,
      default: null,
    },
    whatsappCancelActivityLog: {
      type: [whatsappFarmReadyActivityLogSchema],
      default: [],
    },
    dealerOrder: {
      type: Boolean,
      default: false,
    },
    farmer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Farmer",
      required: function () {
        return !this.dealerOrder; // Required only if not a dealer order
      },
    },
    dealer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return this.dealerOrder; // Required only if it is a dealer order
      },
    },
    salesPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    /** True when the authenticated user who created the order was internal staff (not farmer self-service). See isInternalStaffPlacingOrder in factory.controller. */
    placedByOfficeAdmin: {
      type: Boolean,
      default: false,
    },
    /** User who actually submitted the create request (for usage / audit); salesPerson remains the attributed rep. */
    orderSubmittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Quota management fields for dealer orders
    quotaUsed: {
      type: Number,
      default: 0,
      // Number of plants used from dealer quota
    },
    quotaRestored: {
      type: Boolean,
      default: false,
      // Track if quota was restored when order was rejected
    },
    quotaSource: {
      type: String,
      enum: ["dealer", "company", "none"],
      default: "none",
      // Track where the quota came from
    },
    originalQuotaAllocation: {
      fromWallet: { type: Number, default: 0 },
      fromSlot: { type: Number, default: 0 },
      // Store original quota allocation for restoration
    },
    walletEntryId: {
      type: Schema.Types.ObjectId,
      // Reference to the DealerWallet entry this order uses
      // Used to link orders to specific quota allocations
    },
    numberOfPlants: {
      type: Number,
      required: true,
    },
    additionalPlants: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalPlants: {
      type: Number,
      default: function () {
        return (this.numberOfPlants || 0) + (this.additionalPlants || 0);
      },
    },
    // Field to track remaining plants (initially equals totalPlants)
    remainingPlants: {
      type: Number,
      default: function () {
        const basePlants = (this.numberOfPlants || 0) + (this.additionalPlants || 0);
        return basePlants;
      },
    },
    // Reference to current dispatch (latest dispatch ID)
    currentDispatchId: {
      type: Schema.Types.ObjectId,
      ref: "Dispatch",
    },
    /**
     * True when this order was created on the field during a refused-delivery
     * reassignment (plants already physically on the vehicle). These orders must
     * NOT decrement booking slots — the slot was already consumed by the original
     * refused order. Used as the "Field order" tag in the UI.
     */
    isFieldReassignment: {
      type: Boolean,
      default: false,
    },
    /** Dispatch the reassigned plants came off of (audit link for field orders). */
    reassignedFromDispatchId: {
      type: Schema.Types.ObjectId,
      ref: "Dispatch",
    },
    /** Original refused order(s) whose plants were handed to this farmer. */
    reassignedFromOrderIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Order",
      },
    ],
    plantName: {
      type: Schema.Types.ObjectId,
      ref: "PlantCms",
      required: true,
    },
    plantSubtype: {
      type: Schema.Types.ObjectId,
      // Note: This references a subdocument within PlantCms, cannot use .populate()
      // Use aggregation or manual lookup instead
      required: true,
    },
    /**
     * Instant multi-plant lines. When present (length >= 1), root plantName /
     * plantSubtype / bookingSlot / rate come from line 0; numberOfPlants is the sum.
     * Legacy single-plant orders leave this undefined/empty.
     */
    plantLineItems: {
      type: [plantLineItemSchema],
      default: undefined,
    },
    /** Locked dealer commission rate per plant at order placement (null = legacy, use live rate). */
    commissionRatePerPlant: {
      type: Number,
      min: 0,
      default: null,
    },
    bookingSlot: {
      type: Schema.Types.ObjectId,
      // Note: This references a subdocument within PlantSlot, cannot use .populate()
      // Use aggregation or manual lookup instead
      required: true,
    },
    /** Seed plan for sowing-allowed plants (company / customer raising / mixed). */
    sowingPlan: {
      seedSource: {
        type: String,
        enum: ["COMPANY", "RAISING", "MIXED"],
        default: "COMPANY",
      },
      companySeedPackets: {
        type: Number,
        default: 0,
        min: 0,
      },
      raisingSeedPackets: {
        type: Number,
        default: 0,
        min: 0,
      },
      sowingNotes: {
        type: String,
        default: "",
      },
      /** One raising collect per order — set when intake is saved */
      raisingIntakeCollected: {
        type: Boolean,
        default: false,
      },
      raisingIntakeId: {
        type: Schema.Types.ObjectId,
        ref: "RaisingSeedIntake",
      },
      /** Snapshot for order detail UI (kept in sync on create/edit) */
      raisingIntake: {
        intakeNumber: { type: String, default: "" },
        packetsReceived: { type: Number, default: 0 },
        packetsRemaining: { type: Number, default: 0 },
        batchNumber: { type: String, default: "" },
        expiryDate: { type: Date },
        batches: [
          {
            batchNumber: { type: String, default: "" },
            packets: { type: Number, default: 0 },
            expiryDate: { type: Date },
          },
        ],
        farmerName: { type: String, default: "" },
        notes: { type: String, default: "" },
        collectedAt: { type: Date },
        updatedAt: { type: Date },
      },
    },
    /** Seed sowing against a SowingRequest completed for this order */
    sowingDone: {
      type: Boolean,
      default: false,
    },
    sowingDoneAt: {
      type: Date,
    },
    sowingDoneRequestId: {
      type: Schema.Types.ObjectId,
      ref: "SowingRequest",
    },
    cavity: {
      type: Schema.Types.ObjectId,
      ref: "Tray",
      // required: true,
    },
    rate: {
      type: Number,
      required: true,
    },
    /** Per-order freight / transport charges added at delivery complete (₹).
     *  Legacy mirror of `freight.farmerShareAmount` — do not use for new writes. */
    freightCharges: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Split freight: only farmerShareAmount is billed to the farmer. */
    freight: {
      totalAmount: { type: Number, default: 0, min: 0 },
      farmerShareAmount: { type: Number, default: 0, min: 0 },
      companyShareAmount: { type: Number, default: 0, min: 0 },
      farmerSharePercent: { type: Number, default: 100, min: 0, max: 100 },
      paidBy: {
        type: String,
        enum: ["FARMER", "COMPANY", "TRANSPORTER", "DEALER"],
        default: "FARMER",
      },
      transporterName: { type: String, trim: true },
      vehicleNumber: { type: String, trim: true },
      remark: { type: String, trim: true },
      recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
      recordedAt: { type: Date },
    },
    orderPaymentStatus: {
      type: String,
      enum: ["PENDING", "COMPLETED"],
      default: "PENDING",
    },
    payment: [paymentSchema],
    notes: {
      type: String,
    },
    // Changed to array of strings for order remarks
    orderRemarks: [String],
    // Screenshots uploaded with the order (Cloudinary URLs)
    screenshots: [String], // Array of Cloudinary image URLs
    // Ready plants product fields - for products from other nurseries
    productName: {
      type: String,
      // Reference name for plant products (e.g., "Ghatude") - independent of actual product
    },
    productMappingId: {
      type: Schema.Types.ObjectId,
      ref: 'PlantProductMapping',
      // Reference to PlantProductMapping for ready plants products
    },
    // Snapshot of product order details at order time - for future reference (not linked)
    productOrderSnapshot: {
      productName: { type: String },
      productMappingId: { type: Schema.Types.ObjectId },
      displayTitle: { type: String },
      productId: { type: Schema.Types.ObjectId },
      dateRange: {
        startDate: { type: String },
        endDate: { type: String },
      },
    },
    /** How the order was placed (ERP web/app vs WhatsApp bot). */
    orderSource: {
      type: String,
      enum: ["ERP", "WHATSAPP", "IMPORT", "EXCEL"],
      default: "ERP",
    },
    bookedViaWhatsApp: {
      type: Boolean,
      default: false,
    },
    /** 10-digit mobile used on WhatsApp booking (chat or entered). */
    whatsappBookingMobile: {
      type: String,
      trim: true,
      default: "",
    },
    orderStatus: {
      type: String,
      enum: [
        "PENDING",
        "PROCESSING",
        "COMPLETED",
        "CANCELLED",
        "DISPATCHED",
        "ACCEPTED",
        "REJECTED",
        "FARM_READY",
        "READY_FOR_DISPATCH",
        "DISPATCH_PROCESS",
        "PARTIALLY_COMPLETED",
        "TEMPORARY_CANCELLED",
      ],
      default: "PENDING",
    },
    // Field to track status change history
    statusChanges: [statusChangeSchema],
    paymentCompleted: {
      type: Boolean,
      default: false,
    },
    orderBookingDate: {
      type: Date,
    },
    deliveryDate: {
      type: Date,
      required: false, // Optional to allow undated orders (assigned to dummy slot)
      // The specific date selected by user for plant delivery
      // null for undated orders that are assigned to dummy slot
    },
    farmReadyDate: {
      type: Date,
    },
    dispatchDayKey: {
      type: String,
      enum: ["TODAY", "TOMORROW", "DAY_AFTER"],
    },
    dispatchTargetDate: {
      type: Date,
    },
    // Field to track farm ready date changes history
    farmReadyDateChanges: [farmReadyDateChangeSchema],
    additionalPlantsHistory: [additionalPlantsHistorySchema],
    returnedPlants: {
      type: Number,
      default: 0,
    },
    damagedPlants: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Cumulative plants returned to dealer plant quota (dispatch returns with add-to-inventory on dealer-quota orders). */
    dealerQuotaReturnedPlants: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Cumulative plants returned to nursery slot inventory (hybrid dealer + slot allocation). */
    nurserySlotReturnedPlants: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Cumulative rupees credited back to dealer cash wallet for dispatch returns (wallet-funded COLLECTED payments). */
    walletReturnCreditApplied: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnReason: {
      type: String,
    },
    // Field to track delivery changes history
    deliveryChanges: [deliveryChangeSchema],
    // Field to track general order edits (rate, quantity, deliveryDate, etc.)
    orderEditHistory: [orderEditHistorySchema],
    // Field to track return history
    returnHistory: [
      {
        date: {
          type: Date,
          default: Date.now,
        },
        quantity: {
          type: Number,
          required: true,
        },
        reason: {
          type: String,
        },
        dispatchId: {
          type: Schema.Types.ObjectId,
          ref: "Dispatch",
        },
        processedBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
      },
    ],
    // Field to track dispatch history for partial/split orders
    dispatchHistory: [
      {
        date: {
          type: Date,
          default: Date.now,
        },
        quantity: {
          type: Number,
          required: true,
        },
        dispatchId: {
          type: Schema.Types.ObjectId,
          ref: "Dispatch",
        },
        remainingAfterDispatch: {
          type: Number,
          required: true,
        },
        processedBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
        driverName: {
          type: String,
        },
        vehicleName: {
          type: String,
        },
        source: {
          type: String,
          enum: ["VEHICLE", "SECONDARY_SHED"],
        },
        secondaryOutwardId: {
          type: Schema.Types.ObjectId,
        },
        plantOutwardId: {
          type: Schema.Types.ObjectId,
          ref: "PlantOutward",
        },
        dispatchBatchId: {
          type: Schema.Types.ObjectId,
          ref: "DispatchBatch",
        },
        /** Immutable formatted invoice id for this dispatch leg (e.g. R640). Issued at dispatch time. */
        invoiceNumber: {
          type: String,
          trim: true,
        },
        productSnapshot: {
          type: Schema.Types.Mixed,
        },
      },
    ],
    // Book-for-someone-else: beneficiary identity + optional mobile + structured location
    orderFor: {
      name: {
        type: String,
        trim: true,
      },
      address: {
        type: String,
        trim: true,
      },
      mobileNumber: {
        type: Number,
        default: undefined,
      },
      village: { type: String, trim: true },
      taluka: { type: String, trim: true },
      district: { type: String, trim: true },
      state: { type: String, trim: true },
      stateName: { type: String, trim: true },
      talukaName: { type: String, trim: true },
      districtName: { type: String, trim: true },
    },
    // Expected nursery field - for tracking expected nursery source
    expectedNursery: {
      type: String,
    },
    /** Lot / batch reference captured at delivery completion (complete dispatch form). */
    batchNumber: {
      type: String,
      trim: true,
    },
    /**
     * Delivery challan invoice label reserved at instant sale (order created as DISPATCHED)
     * or reused when the order is first loaded on a vehicle dispatch.
     */
    deliveryChallanInvoiceNumber: {
      type: String,
      trim: true,
    },
    /**
     * Immutable system DC for billable plant lines (plant-scoped billable sequence).
     * Set once when the order first reaches fully DISPATCHED. Not user-editable.
     */
    officialDeliveryChallanNumber: {
      type: String,
      trim: true,
    },
    /**
     * Immutable system DC for non-billable plant lines (separate plant sequence).
     * Issued alongside officialDeliveryChallanNumber when the order has both buckets.
     */
    officialNonBillableDeliveryChallanNumber: {
      type: String,
      trim: true,
    },
    /**
     * Immutable system tax-invoice number for billable plant lines (plant-scoped invoice sequence).
     * Set once on first complete-invoice PDF generate. Not the DC number.
     */
    officialInvoiceNumber: {
      type: String,
      trim: true,
    },
    /**
     * Immutable system tax-invoice number for non-billable plant lines (separate invoice sequence).
     */
    officialNonBillableInvoiceNumber: {
      type: String,
      trim: true,
    },
    /**
     * Manual / duplicate override for billable invoice label (does not consume sequence).
     */
    manualInvoiceNumber: {
      type: String,
      trim: true,
    },
    /**
     * Manual / duplicate override for non-billable invoice label.
     */
    manualNonBillableInvoiceNumber: {
      type: String,
      trim: true,
    },
    /** Current server-generated per-order delivery challan PDF (S3). */
    deliveryChallanPdfUrl: {
      type: String,
      default: "",
      trim: true,
    },
    deliveryChallanPdfGeneratedAt: {
      type: Date,
      default: null,
    },
    /** Previous current PDFs kept on regenerate (S3 objects are not deleted). */
    deliveryChallanPdfHistory: [
      {
        url: { type: String, trim: true },
        generatedAt: { type: Date, default: null },
        replacedAt: { type: Date, default: null },
        generatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      },
    ],
    // Reference field - reference to user/employee
    reference: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    // Old delivery date - for tracking delivery date changes
    oldDeliveryDate: {
      type: Date,
    },
    /** Booking slot before cross-slot early / overdue dispatch (READY_FOR_DISPATCH). */
    originalBookingSlot: {
      type: Schema.Types.ObjectId,
    },
    /** Order was moved to dispatch-day slot; show old + current delivery in UI. */
    dispatchedFromAnotherSlot: {
      type: Boolean,
      default: false,
    },
    /** Auto-moved from expired booking slot to next slot (daily past-due rollover). */
    pastDueSlotRollover: {
      type: Boolean,
      default: false,
    },
    pastDueSlotRolloverAt: {
      type: Date,
      default: null,
    },
    // Field to track call history for dispatch managers
    callHistory: [
      {
        date: {
          type: Date,
          default: Date.now,
        },
        calledBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
        note: {
          type: String,
          default: "",
        },
      },
    ],
    // Driver assignment for dispatch routes
    assignedDriver: {
      type: Schema.Types.ObjectId,
      ref: "User",
      // Reference to the driver assigned to deliver this order
    },
    assignedVehicle: {
      type: String,
      // Vehicle number or identifier
    },
    routeId: {
      type: String,
      // Route identifier to group orders in the same delivery route
    },
    routeSequence: {
      type: Number,
      // Sequence number in the route (1, 2, 3, etc.)
    },
    assignedAt: {
      type: Date,
      // When the order was assigned to a route
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      // User who assigned the order to the route
    },
    readyDispatchGroupId: {
      type: Schema.Types.ObjectId,
      ref: "ReadyDispatchGroup",
      default: null,
    },
    driverRemark: {
      type: String,
      trim: true,
      default: "",
    },
    vehicleRemark: {
      type: String,
      trim: true,
      default: "",
    },

    // --- Order Split tracking ---
    /** Set on child orders created by a split. Points to the original parent order. */
    parentOrderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    /** Set on the parent order. Lists all child orders produced by splits of this order. */
    splitOrderIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Order",
      },
    ],
    /** True when this order was produced by splitting another order. */
    isSplit: {
      type: Boolean,
      default: false,
    },
    /** Full audit trail of every split action that touched this order. */
    splitHistory: [splitHistorySchema],

    /** If an office admin has requested a rate change pending SUPER_ADMIN approval, ref is stored here. Cleared on approve/reject. */
    pendingRateChangeRequestId: {
      type: Schema.Types.ObjectId,
      ref: "RateChangeRequest",
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes
orderSchema.index({ farmer: 1 });
orderSchema.index({ dealer: 1 });
orderSchema.index({ salesPerson: 1 });
orderSchema.index({ orderSubmittedBy: 1, createdAt: -1 });
orderSchema.index({ placedByOfficeAdmin: 1 });
orderSchema.index({ plantName: 1 });
orderSchema.index({ "plantLineItems.plantName": 1 });
orderSchema.index({ "plantLineItems.bookingSlot": 1 });
orderSchema.index({ bookingSlot: 1 });
orderSchema.index({ bookingSlot: 1, "sowingPlan.seedSource": 1 });
orderSchema.index({ sowingDone: 1, sowingDoneAt: -1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ orderStatus: 1, deliveryDate: 1 });
// Ascending delivery sorts (dispatch queue / mobile list)
orderSchema.index({ deliveryDate: 1, orderStatus: 1 });
orderSchema.index({ createdAt: 1 });
orderSchema.index({ orderPaymentStatus: 1 });
orderSchema.index({ createdAt: 1, orderStatus: 1 });
// Compound indexes for optimized slot queries
orderSchema.index({ bookingSlot: 1, orderStatus: 1 }); // For filtering orders by slot and status
orderSchema.index({ bookingSlot: 1, orderStatus: 1, quotaSource: 1 }); // For populateSlotsWithOrders query
orderSchema.index({ cavity: 1 }); // Added index for cavity field
orderSchema.index({ returnedPlants: 1 }); // Added index for returnedPlants
orderSchema.index({ remainingPlants: 1 }); // Added index for remainingPlants
orderSchema.index({ additionalPlants: 1 }); // Added index for additionalPlants
orderSchema.index({ totalPlants: 1 }); // Added index for totalPlants
orderSchema.index({ publicOrderCode: 1 }, { unique: true, sparse: true });
orderSchema.index(
  { officialDeliveryChallanNumber: 1 },
  { unique: true, sparse: true }
);
// List/getOrders: date filters + sort (early pagination uses these fields heavily)
orderSchema.index({ orderBookingDate: -1 });
orderSchema.index({ deliveryDate: -1 });
orderSchema.index({ deliveryDate: 1, orderStatus: 1, quotaSource: 1 });
orderSchema.index({ salesPerson: 1, orderBookingDate: -1 });
orderSchema.index({ whatsappFarmReadyMessageKey: 1 }, { sparse: true });
orderSchema.index({ dealer: 1, orderBookingDate: -1 });
// Daily pipeline / transition reports filter on statusChanges timestamps
orderSchema.index({ "statusChanges.createdAt": 1 }, { sparse: true });

orderSchema.statics.ensurePublicOrderCode = async function ensurePublicOrderCode(doc) {
  if (doc.publicOrderCode && /^\d{4}$/.test(doc.publicOrderCode)) return doc;
  const OrderModel = this;
  const excludeId = doc._id ? { _id: { $ne: doc._id } } : {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await OrderModel.exists({ publicOrderCode: code, ...excludeId });
    if (!exists) {
      doc.publicOrderCode = code;
      return doc;
    }
  }
  for (let n = 1000; n <= 9999; n += 1) {
    const code = String(n);
    const exists = await OrderModel.exists({ publicOrderCode: code, ...excludeId });
    if (!exists) {
      doc.publicOrderCode = code;
      return doc;
    }
  }
  throw new Error("Could not allocate a unique publicOrderCode");
};

orderSchema.methods.setAdditionalPlantsChangeMeta = function (meta = {}) {
  this._additionalPlantsChangeMeta = {
    reason: meta?.reason,
    notes: meta?.notes,
    changedBy: meta?.changedBy,
  };
  return this;
};

// Pre-save: unique 4-digit orderId (1000–9999), then 5-digit when tier 1 is full
orderSchema.pre("save", async function (next) {
  if (!this.isNew || this.orderId) return next();

  try {
    this.orderId = await allocateNextOrderId(this.constructor, {
      session: this.$session(),
    });
    next();
  } catch (err) {
    next(err);
  }
});

// Pre-save: assign unique 4-digit publicOrderCode for WhatsApp
orderSchema.pre("save", async function (next) {
  if (this.publicOrderCode && /^\d{4}$/.test(this.publicOrderCode)) return next();
  try {
    await this.constructor.ensurePublicOrderCode(this);
    next();
  } catch (err) {
    next(err);
  }
});

// Pre-save: keep freightCharges mirrored to the farmer share, then recompute payment status.
orderSchema.pre("save", function (next) {
  if (this.freight && typeof this.freight === "object") {
    const farmerShare = Math.max(0, Number(this.freight.farmerShareAmount) || 0);
    this.freightCharges = farmerShare;
  }

  const totalCollected = this.payment
    .filter((p) => p.paymentStatus === "COLLECTED")
    .reduce((sum, p) => sum + (p.paidAmount || 0), 0);

  const totalOrderedPlants =
    (this.numberOfPlants || 0) + (this.additionalPlants || 0);
  const farmerFreight = Math.max(0, Number(this.freightCharges) || 0);
  const totalAmount = (this.rate || 0) * totalOrderedPlants + farmerFreight;

  this.orderPaymentStatus =
    totalCollected >= totalAmount ? "COMPLETED" : "PENDING";
  this.paymentCompleted = totalCollected >= totalAmount;

  next();
});

// Pre-save middleware to update remainingPlants when returnedPlants changes
orderSchema.pre("save", function (next) {
  const totalOrderedPlants =
    (this.numberOfPlants || 0) + (this.additionalPlants || 0);

  this.totalPlants = totalOrderedPlants;

  // remainingPlants = plants not yet dispatched from nursery (not order total − returns).
  const returnedOnlyChange =
    this.isModified("returnedPlants") &&
    !this.isModified("numberOfPlants") &&
    !this.isModified("additionalPlants");

  const qtyChanged =
    this.isModified("numberOfPlants") || this.isModified("additionalPlants");

  if (!returnedOnlyChange) {
    if (typeof this.remainingPlants === "undefined") {
      this.remainingPlants = totalOrderedPlants;
    } else if (qtyChanged) {
      const prevNum =
        typeof this._oldNumberOfPlants === "number"
          ? this._oldNumberOfPlants
          : this.numberOfPlants || 0;
      const prevAdd =
        typeof this._oldAdditionalPlants === "number"
          ? this._oldAdditionalPlants
          : this._originalAdditionalPlants ?? 0;
      const deltaNum = (this.numberOfPlants || 0) - prevNum;
      const deltaAdd = (this.additionalPlants || 0) - prevAdd;
      if (deltaNum !== 0 || deltaAdd !== 0) {
        this.remainingPlants = Math.max(
          0,
          (this.remainingPlants || 0) + deltaNum + deltaAdd
        );
      }
    }
  }

  if (!this.isNew && this.isModified("additionalPlants")) {
    const previousTotal =
      typeof this._oldAdditionalPlants === "number"
        ? this._oldAdditionalPlants
        : this._originalAdditionalPlants ?? 0;
    const newTotal = this.additionalPlants || 0;

    if (previousTotal !== newTotal) {
      if (!this.additionalPlantsHistory) {
        this.additionalPlantsHistory = [];
      }

      const changeMeta =
        this._additionalPlantsChangeMeta || {
          reason: this.additionalPlantsChangeReason,
          notes: this.additionalPlantsChangeNotes,
          changedBy: this.additionalPlantsChangedBy,
        };

      const historyEntry = {
        previousTotal,
        newTotal,
        changeInPlants: newTotal - previousTotal,
      };

      if (changeMeta?.reason) {
        historyEntry.reason = changeMeta.reason;
      }
      if (changeMeta?.notes) {
        historyEntry.notes = changeMeta.notes;
      }
      if (changeMeta?.changedBy) {
        historyEntry.changedBy = changeMeta.changedBy;
      }

      this.additionalPlantsHistory.push(historyEntry);

      if (!this.orderEditHistory) {
        this.orderEditHistory = [];
      }

      const editHistoryEntry = {
        field: "additionalPlants",
        previousValue: previousTotal,
        newValue: newTotal,
      };

      if (historyEntry.notes) {
        editHistoryEntry.notes = historyEntry.notes;
      }
      if (historyEntry.changedBy) {
        editHistoryEntry.changedBy = historyEntry.changedBy;
      }

      this.orderEditHistory.push(editHistoryEntry);
    }
  }

  if (this.isModified("returnedPlants")) {
    const previousReturned = this._oldReturnedPlants || 0;
    const delta = (this.returnedPlants || 0) - previousReturned;

    if (delta > 0) {
      if (!this.returnHistory) {
        this.returnHistory = [];
      }

      this.returnHistory.push({
        date: new Date(),
        quantity: delta,
        reason: this.returnReason,
      });
    }

    this._oldReturnedPlants = this.returnedPlants || 0;
  }

  this._oldAdditionalPlants = this.additionalPlants || 0;
  this._oldNumberOfPlants = this.numberOfPlants || 0;
  if (typeof this._originalAdditionalPlants !== "number") {
    this._originalAdditionalPlants = this.additionalPlants || 0;
  }
  if (typeof this._oldReturnedPlants !== "number") {
    this._oldReturnedPlants = this.returnedPlants || 0;
  }
  this._additionalPlantsChangeMeta = undefined;
  this.additionalPlantsChangeReason = undefined;
  this.additionalPlantsChangeNotes = undefined;
  this.additionalPlantsChangedBy = undefined;

  next();
});

orderSchema.pre("findOneAndUpdate", async function (next) {
  this.setOptions({ new: true, runValidators: true });

  const update = this.getUpdate() || {};
  const $set = { ...(update.$set || {}) };
  const $unset = update.$unset ? { ...update.$unset } : undefined;
  const meta = {};

  const collectMeta = (source) => {
    if (!source) return;
    if (source.additionalPlantsChangeMeta) {
      Object.assign(meta, source.additionalPlantsChangeMeta);
      delete source.additionalPlantsChangeMeta;
    }
    if (source.additionalPlantsChangeReason !== undefined) {
      meta.reason = source.additionalPlantsChangeReason;
      delete source.additionalPlantsChangeReason;
    }
    if (source.additionalPlantsChangeNotes !== undefined) {
      meta.notes = source.additionalPlantsChangeNotes;
      delete source.additionalPlantsChangeNotes;
    }
    if (source.additionalPlantsChangedBy !== undefined) {
      meta.changedBy = source.additionalPlantsChangedBy;
      delete source.additionalPlantsChangedBy;
    }
  };

  collectMeta(update);
  collectMeta($set);

  const relevantKeys = ["numberOfPlants", "additionalPlants", "returnedPlants"];
  relevantKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(update, key)) {
      $set[key] = update[key];
      delete update[key];
    }
  });

  const modifiesQuantity = relevantKeys.some((key) =>
    Object.prototype.hasOwnProperty.call($set, key)
  );

  if (!modifiesQuantity) {
    update.$set = $set;
    if ($unset) {
      const unsetKeys = Object.keys($unset);
      if (unsetKeys.length) {
        update.$unset = $unset;
      } else {
        delete update.$unset;
      }
    }
    this.setUpdate(update);
    return next();
  }

  let doc = null;
  try {
    doc = await this.model
      .findOne(this.getQuery())
      .select("numberOfPlants additionalPlants returnedPlants remainingPlants")
      .lean();
  } catch (error) {
    return next(error);
  }

  const previous = {
    numberOfPlants: doc?.numberOfPlants ?? 0,
    additionalPlants: doc?.additionalPlants ?? 0,
    returnedPlants: doc?.returnedPlants ?? 0,
    remainingPlants: doc?.remainingPlants ?? 0,
  };

  const numberOfPlants =
    $set.numberOfPlants ?? previous.numberOfPlants;
  const additionalPlants =
    $set.additionalPlants ?? previous.additionalPlants;
  const returnedPlants =
    $set.returnedPlants ?? previous.returnedPlants;

  const totalPlants = numberOfPlants + additionalPlants;
  $set.totalPlants = totalPlants;

  const hasExplicitRemaining = Object.prototype.hasOwnProperty.call(
    $set,
    "remainingPlants"
  );
  const hasNumber = Object.prototype.hasOwnProperty.call($set, "numberOfPlants");
  const hasAdditional = Object.prototype.hasOwnProperty.call(
    $set,
    "additionalPlants"
  );
  const hasReturned = Object.prototype.hasOwnProperty.call(
    $set,
    "returnedPlants"
  );

  if (hasExplicitRemaining) {
    // Controller provided remaining (e.g. dispatch completion)
  } else if (hasNumber || hasAdditional) {
    const prevRem = Number(previous.remainingPlants) || 0;
    const deltaNum = numberOfPlants - previous.numberOfPlants;
    const deltaAdd = additionalPlants - previous.additionalPlants;
    $set.remainingPlants = Math.max(0, prevRem + deltaNum + deltaAdd);
  } else if (hasReturned && !hasNumber && !hasAdditional) {
    delete $set.remainingPlants;
  }

  if (
    doc &&
    Object.prototype.hasOwnProperty.call($set, "additionalPlants") &&
    additionalPlants !== previous.additionalPlants
  ) {
    const change = additionalPlants - previous.additionalPlants;

    if (change !== 0) {
      update.$push = update.$push || {};

      const historyEntry = {
        previousTotal: previous.additionalPlants,
        newTotal: additionalPlants,
        changeInPlants: change,
      };

      if (meta.reason) historyEntry.reason = meta.reason;
      if (meta.notes) historyEntry.notes = meta.notes;
      if (meta.changedBy) historyEntry.changedBy = meta.changedBy;

      if (update.$push.additionalPlantsHistory) {
        if (update.$push.additionalPlantsHistory.$each) {
          update.$push.additionalPlantsHistory.$each.push(historyEntry);
        } else {
          update.$push.additionalPlantsHistory = {
            $each: [update.$push.additionalPlantsHistory, historyEntry],
          };
        }
      } else {
        update.$push.additionalPlantsHistory = { $each: [historyEntry] };
      }

      const editHistoryEntry = {
        field: "additionalPlants",
        previousValue: previous.additionalPlants,
        newValue: additionalPlants,
      };

      if (historyEntry.notes) editHistoryEntry.notes = historyEntry.notes;
      if (historyEntry.changedBy)
        editHistoryEntry.changedBy = historyEntry.changedBy;

      if (update.$push.orderEditHistory) {
        if (update.$push.orderEditHistory.$each) {
          update.$push.orderEditHistory.$each.push(editHistoryEntry);
        } else {
          update.$push.orderEditHistory = {
            $each: [update.$push.orderEditHistory, editHistoryEntry],
          };
        }
      } else {
        update.$push.orderEditHistory = { $each: [editHistoryEntry] };
      }
    }
  }

  // Base quantity (numberOfPlants): log to orderEditHistory when it changes — backup if controller
  // did not push (and merge safely with controller-provided $each).
  if (
    Object.prototype.hasOwnProperty.call($set, "numberOfPlants") &&
    Number($set.numberOfPlants) !== Number(previous.numberOfPlants)
  ) {
    const existingEach = update.$push?.orderEditHistory?.$each;
    const alreadyHasNumberOfPlantsEntry =
      Array.isArray(existingEach) &&
      existingEach.some((e) => e && e.field === "numberOfPlants");
    if (!alreadyHasNumberOfPlantsEntry) {
      update.$push = update.$push || {};
      const entry = {
        field: "numberOfPlants",
        previousValue: previous.numberOfPlants,
        newValue: $set.numberOfPlants,
        notes: `Quantity changed from ${previous.numberOfPlants} to ${$set.numberOfPlants} plants`,
      };
      if (!update.$push.orderEditHistory) {
        update.$push.orderEditHistory = { $each: [entry] };
      } else if (update.$push.orderEditHistory.$each) {
        update.$push.orderEditHistory.$each.push(entry);
      } else {
        update.$push.orderEditHistory = {
          $each: [update.$push.orderEditHistory, entry],
        };
      }
    }
  }

  update.$set = $set;

  if ($unset) {
    const unsetKeys = Object.keys($unset);
    if (unsetKeys.length) {
      update.$unset = $unset;
    } else {
      delete update.$unset;
    }
  }

  this.setUpdate(update);
  next();
});

// Pre-save middleware to track orderStatus changes
orderSchema.pre("save", function (next) {
  // Check if orderStatus has changed and it's not a new document
  if (this.isModified("orderStatus") && !this.isNew) {
    // Get the previous status (before this update)
    const previousStatus =
      this._oldOrderStatus || this.constructor.schema.paths.orderStatus.default;
    const newStatus = this.orderStatus;

    // Don't create a history entry if status hasn't actually changed
    if (previousStatus !== newStatus) {
      // Initialize statusChanges array if it doesn't exist yet
      if (!this.statusChanges) {
        this.statusChanges = [];
      }

      // Add new status change record
      this.statusChanges.push({
        previousStatus: previousStatus,
        newStatus: newStatus,
        // reason and changedBy would typically be set by the controller that's changing the status
        // We'll just record the status change with available information
      });
    }

    // Store current status for future comparisons
    this._oldOrderStatus = this.orderStatus;
  } else if (this.isNew) {
    // Store initial status for new documents
    this._oldOrderStatus = this.orderStatus;
  }

  next();
});

// Note: Farm ready date changes are tracked in the controller using $push
// to ensure proper user information and reason tracking

// Add validation middleware to ensure proper business logic
orderSchema.pre("validate", function (next) {
  try {
    if (hasPlantLineItems(this)) {
      rollupPlantLineItemsToRoot(this);
    }
  } catch (err) {
    return next(err);
  }

  sanitizePaymentArrayForOrder(this.payment, this);

  const totalOrderedPlants =
    (this.numberOfPlants || 0) + (this.additionalPlants || 0);

  if (this.additionalPlants < 0) {
    const error = new Error("Additional plants cannot be negative");
    return next(error);
  }

  if ((this.damagedPlants || 0) < 0) {
    const error = new Error("Damaged plants cannot be negative");
    return next(error);
  }

  // Ensure total resolved quantities don't exceed ordered plants.
  if ((this.returnedPlants || 0) + (this.damagedPlants || 0) > totalOrderedPlants) {
    const error = new Error(
      "Returned plus damaged plants cannot exceed the total number of plants in the order"
    );
    return next(error);
  }
  next();
});

// findOneAndUpdate bypasses pre("validate"); sanitize payment $push/$set before validators run
orderSchema.pre("findOneAndUpdate", function (next) {
  try {
    const update = this.getUpdate();
    if (update) {
      patchPaymentUpdateOperation(update);
      this.setUpdate(update);
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Track original values when document is loaded from database
orderSchema.post("init", function() {
  this._originalOrderStatus = this.orderStatus;
  this._originalAdditionalPlants = this.additionalPlants || 0;
  this._oldAdditionalPlants = this.additionalPlants || 0;
  this._oldNumberOfPlants = this.numberOfPlants || 0;
  this._oldReturnedPlants = this.returnedPlants || 0;
});

// Pre-save: Check if status changed and store the change
orderSchema.pre("save", function (next) {
  if (!this.isNew && this.isModified("orderStatus")) {
    this._statusChanged = {
      oldStatus: this._originalOrderStatus || "UNKNOWN",
      newStatus: this.orderStatus,
    };
  }
  next();
});

// Post-save: Send notification after status change is committed
orderSchema.post("save", async function (doc) {
  if (doc._statusChanged) {
    // Use setImmediate to avoid blocking the response
    setImmediate(async () => {
      try {
        // Dynamically import to avoid circular dependency
        const { sendStatusChangeNotification } = await import("../utility/orderNotificationHelper.js");
        await sendStatusChangeNotification(doc, doc._statusChanged.oldStatus, doc._statusChanged.newStatus);
      } catch (error) {
        console.error("❌ Error sending status change notification:", error);
        // Don't fail the save if notification fails
      }
    });
  }
});

// Also handle findOneAndUpdate which is used by the controller
orderSchema.post("findOneAndUpdate", async function(doc) {
  if (doc) {
    // Get the update operation
    const update = this.getUpdate();
    const newStatus = update.$set?.orderStatus || update.orderStatus;
    
    if (newStatus && doc.orderStatus !== newStatus) {
      setImmediate(async () => {
        try {
          const { sendStatusChangeNotification } = await import("../utility/orderNotificationHelper.js");
          // Reload the document to get the updated status
          const updatedDoc = await doc.constructor.findById(doc._id);
          if (updatedDoc) {
            await sendStatusChangeNotification(updatedDoc, doc.orderStatus, newStatus);
          }
        } catch (error) {
          console.error("❌ Error sending status change notification:", error);
        }
      });
    }
  }
});

const Order = model("Order", orderSchema);

export { plantLineItemSchema };
export default Order;
