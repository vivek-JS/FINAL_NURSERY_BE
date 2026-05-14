import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryChallanPdfBuffer,
  buildCompleteInvoicePdfBuffer,
  resolveChallanInvoiceLabelForPdf,
} from "../services/dispatchPdfDocuments.service.js";

const dispatchId = "507f1f77bcf86cd799439011";

test("resolveChallanInvoiceLabelForPdf prefers official then manual then history", () => {
  assert.equal(
    resolveChallanInvoiceLabelForPdf(
      { officialDeliveryChallanNumber: " R-12 ", deliveryChallanInvoiceNumber: "x" },
      dispatchId
    ),
    "R-12"
  );
  assert.equal(
    resolveChallanInvoiceLabelForPdf(
      {
        deliveryChallanInvoiceNumber: " M-1 ",
        dispatchHistory: [{ dispatchId, invoiceNumber: "H-9" }],
      },
      dispatchId
    ),
    "M-1"
  );
  assert.equal(
    resolveChallanInvoiceLabelForPdf(
      { dispatchHistory: [{ dispatchId, invoiceNumber: " H-9 " }] },
      dispatchId
    ),
    "H-9"
  );
});

test("buildDeliveryChallanPdfBuffer returns non-empty PDF buffer", async () => {
  const buf = await buildDeliveryChallanPdfBuffer({
    _id: dispatchId,
    transportId: "T-1",
    driverName: "Driver",
    vehicleName: "Truck",
    vehicleNumber: "MH-01",
    createdAt: new Date("2024-01-15"),
    orderDispatchDetails: [
      { orderId: "507f1f77bcf86cd799439012", dispatchQuantity: 100 },
    ],
    orderIds: [
      {
        _id: "507f1f77bcf86cd799439012",
        orderId: 501,
        rate: 12,
        numberOfPlants: 100,
        farmer: { name: "Farmer A", village: "V1", mobileNumber: "9000000000" },
        plantName: {
          name: "Tomato",
          subtypes: [{ _id: "507f1f77bcf86cd799439013", name: "Hybrid" }],
        },
        plantSubtype: "507f1f77bcf86cd799439013",
        dispatchHistory: [],
        deliveryChallanInvoiceNumber: "",
        officialDeliveryChallanNumber: "",
      },
    ],
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 800, `expected PDF bytes, got length ${buf.length}`);
  assert.equal(buf.subarray(0, 4).toString("binary"), "%PDF");
});

test("buildCompleteInvoicePdfBuffer returns non-empty PDF buffer", async () => {
  const buf = await buildCompleteInvoicePdfBuffer({
    _id: dispatchId,
    transportId: "T-2",
    driverName: "D",
    vehicleName: "Veh",
    orderDispatchDetails: [{ orderId: "507f1f77bcf86cd799439014", dispatchQuantity: 10 }],
    orderIds: [
      {
        _id: "507f1f77bcf86cd799439014",
        orderId: 9,
        rate: 20,
        returnedPlants: 1,
        damagedPlants: 0,
        farmer: { name: "B", village: "G", mobileNumber: "1" },
        plantName: { name: "Chili", subtypes: [] },
        payment: [{ paymentStatus: "COLLECTED", paidAmount: 50 }],
      },
    ],
  });
  assert.ok(buf.length > 800);
  assert.equal(buf.subarray(0, 4).toString("binary"), "%PDF");
});
