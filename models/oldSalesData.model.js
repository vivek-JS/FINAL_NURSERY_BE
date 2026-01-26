import mongoose from 'mongoose';

const oldSalesDataSchema = new mongoose.Schema(
  {
    deliveryDate: { type: Date },
    referenceReceiptNo: { type: String, trim: true },
    billGivenOrNot: { type: String, trim: true },
    bookingNo: { type: String, trim: true },
    customerName: { type: String, trim: true },
    mobileNo: { type: String, trim: true },
    village: { type: String, trim: true },
    taluka: { type: String, trim: true },
    district: { type: String, trim: true },
    plant: { type: String, trim: true },
    variety: { type: String, trim: true },
    media: { type: String, trim: true },
    details: { type: String, trim: true },
    shadeNo: { type: String, trim: true },
    batch: { type: String, trim: true },
    issuePlantQty: { type: Number },
    returnQty: { type: Number },
    damagedQty: { type: Number },
    extraPlants: { type: Number },
    plantQty: { type: Number },
    mis: { type: Number },
    reference: { type: String, trim: true },
    marketingReference: { type: String, trim: true },
    rate: { type: Number },
    invoiceAmount: { type: Number },
    rentOrExtraCharge: { type: Number },
    vehicleNo: { type: String, trim: true },
    driverName: { type: String, trim: true },
    totalInvoiceAmount: { type: Number },
    advancePaid: { type: Number },
    advanceDate: { type: Date },
    advanceDetails: { type: String, trim: true },
    remainingAmount: { type: Number },
    paymentMode: { type: String, trim: true },
    paymentDate: { type: Date },
    paymentAmount: { type: Number },
    chequeNo: { type: String, trim: true },
    depositedInBank: { type: String, trim: true },
    balanceAmount: { type: Number },
    remainingAmountPaidDate: { type: Date },
    remainingAmountPaymentMode: { type: String, trim: true },
    remainingAmountChequeNo: { type: String, trim: true },
    remark: { type: String, trim: true },
    verifiedOrNot: { type: String, trim: true },
    sourceRowNumber: { type: Number },
    sourceSheet: { type: String, trim: true },
    sourceFile: { type: String, trim: true },
    importBatchId: { type: String, trim: true },
  },
  {
    timestamps: true,
    collection: 'old_sales_data',
  }
);

oldSalesDataSchema.index({ bookingNo: 1 });
oldSalesDataSchema.index({ customerName: 1 });
oldSalesDataSchema.index({ deliveryDate: 1 });
oldSalesDataSchema.index({ importBatchId: 1 });

const OldSalesData = mongoose.model('OldSalesData', oldSalesDataSchema);

export default OldSalesData;
