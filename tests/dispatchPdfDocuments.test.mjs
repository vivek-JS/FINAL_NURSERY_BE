import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveChallanInvoiceLabelForPdf,
  mapDispatchToChallanPages,
  mapDispatchToRamInvoicePages,
  renderDeliveryChallanDocument,
  renderRamBiotechInvoiceDocument,
} from "../../shared/dispatch-documents/index.js";
import {
  buildDeliveryChallanPdfBuffer,
  buildCompleteInvoicePdfBuffer,
} from "../services/dispatchPdfDocuments.service.js";

const dispatchId = "507f1f77bcf86cd799439011";

const sampleDispatch = {
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
      farmer: {
        name: "Farmer A",
        village: "V1",
        mobileNumber: "9000000000",
        talukaName: "Jalgaon",
        districtName: "Jalgaon",
        stateName: "Maharashtra",
      },
      plantName: {
        name: "Papaya",
        subtypes: [{ _id: "507f1f77bcf86cd799439013", name: "Red Lady" }],
      },
      plantSubtype: "507f1f77bcf86cd799439013",
      dispatchHistory: [],
      payment: [{ paidAmount: 500, modeOfPayment: "Cash", paymentStatus: "COLLECTED" }],
    },
  ],
};

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
});

test("mapDispatchToChallanPages produces per-order props", () => {
  const pages = mapDispatchToChallanPages(sampleDispatch);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].dispatchQty, 100);
  assert.equal(pages[0].farmerName, "Farmer A");
  assert.match(pages[0].plantName, /Papaya/i);
});

test("mapDispatchToRamInvoicePages produces invoice fields", () => {
  const pages = mapDispatchToRamInvoicePages(sampleDispatch);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].billTo, "Farmer A");
  assert.equal(pages[0].atPost, "V1");
  assert.equal(pages[0].items[0].quantity, "100");
  assert.equal(pages[0].isBanana, false);
  assert.match(pages[0].items[0].description, /Papaya Red Lady Plants/i);
  assert.equal(pages[0].licNo, "LCSD1220240806JLG");
  assert.ok(pages[0].amountInWords.includes("Rupees"));
});

test("mapDispatchToRamInvoicePages — one invoice per order / farmer", () => {
  const multi = {
    ...sampleDispatch,
    orderIds: [
      sampleDispatch.orderIds[0],
      {
        ...sampleDispatch.orderIds[0],
        _id: "507f1f77bcf86cd799439099",
        orderId: 502,
        farmer: { ...sampleDispatch.orderIds[0].farmer, name: "Farmer B" },
      },
      {
        ...sampleDispatch.orderIds[0],
        _id: "507f1f77bcf86cd799439088",
        orderId: 503,
        farmer: { ...sampleDispatch.orderIds[0].farmer, name: "Farmer C" },
      },
    ],
  };
  const pages = mapDispatchToRamInvoicePages(multi);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => p.billTo), ["Farmer A", "Farmer B", "Farmer C"]);
});

test("banana invoice includes Lic, DBT, Batch and aadhar row", () => {
  const bananaDispatch = {
    ...sampleDispatch,
    orderIds: [
      {
        ...sampleDispatch.orderIds[0],
        plantName: { name: "Banana", subtypes: [{ _id: "s1", name: "G-9" }] },
        plantSubtype: "s1",
        batchNumber: "0024",
        farmer: {
          ...sampleDispatch.orderIds[0].farmer,
          aadharNumber: "954899304088",
        },
      },
    ],
  };
  const pages = mapDispatchToRamInvoicePages(bananaDispatch);
  assert.equal(pages[0].isBanana, true);
  assert.equal(pages[0].licNo, "LCSD2021119028");
  assert.equal(pages[0].dbtNo, "TC2023/C020/1");
  assert.match(pages[0].items[0].description, /Banana G-9 Plants/i);
  assert.equal(pages[0].lotLabel, "Batch No.");
  const html = renderRamBiotechInvoiceDocument(pages, "Test");
  assert.match(html, /DBT No/);
  assert.match(html, /Adhar NO/);
  assert.match(html, /Batch No/);
  assert.doesNotMatch(html, /Thumb<\/th>/);
});

test("papaya invoice has Lic only and Lot No", () => {
  const withLot = {
    ...sampleDispatch,
    orderIds: [
      {
        ...sampleDispatch.orderIds[0],
        bookingSlot: { month: "OD24SE" },
      },
    ],
  };
  const pages = mapDispatchToRamInvoicePages(withLot);
  assert.equal(pages[0].lotLabel, "Lot No.");
  const html = renderRamBiotechInvoiceDocument(pages, "Test");
  assert.match(html, /LCSD1220240806JLG/);
  assert.doesNotMatch(html, /DBT No/);
  assert.doesNotMatch(html, /Adhar NO/);
  assert.match(html, /Lot No/);
  assert.match(html, /Thumb<\/th>/);
});

test("dealer order invoice uses Bill To / Ship To layout", () => {
  const dealerDispatch = {
    ...sampleDispatch,
    orderIds: [
      {
        ...sampleDispatch.orderIds[0],
        dealerOrder: true,
        dealer: {
          name: "Dealer ABC",
          phoneNumber: "9800000000",
          location: { village: "Dealer Village", taluka: "Jalgaon", district: "Jalgaon", state: "Maharashtra" },
        },
        farmer: {
          name: "Farmer A",
          village: "V1",
          mobileNumber: "9000000000",
          talukaName: "Amalner",
          districtName: "Jalgaon",
          stateName: "Maharashtra",
        },
      },
    ],
  };
  const pages = mapDispatchToRamInvoicePages(dealerDispatch);
  assert.equal(pages[0].useBillToShipTo, true);
  assert.equal(pages[0].billTo, "Dealer ABC");
  assert.equal(pages[0].shipTo, "Farmer A");
  const html = renderRamBiotechInvoiceDocument(pages, "Test");
  assert.match(html, /Ship To :- Mr\/Miss/);
  assert.match(html, /Bill To :- Mr\/Miss/);
});

test("invoice aadhar override from options", () => {
  const bananaDispatch = {
    ...sampleDispatch,
    orderIds: [
      {
        ...sampleDispatch.orderIds[0],
        plantName: { name: "Banana", subtypes: [{ _id: "s1", name: "G-9" }] },
        plantSubtype: "s1",
      },
    ],
  };
  const pages = mapDispatchToRamInvoicePages(bananaDispatch, undefined, {
    aadharByOrderId: { "507f1f77bcf86cd799439012": "111122223333" },
  });
  assert.equal(pages[0].aadhar, "1111 2222 3333");
});

test("renderDeliveryChallanDocument includes Marathi header", () => {
  const pages = mapDispatchToChallanPages(sampleDispatch);
  const html = renderDeliveryChallanDocument(pages, "Test");
  assert.match(html, /डिलिव्हरी चलन/);
  assert.match(html, /challan-page/);
});

test("renderRamBiotechInvoiceDocument includes company and terms", () => {
  const pages = mapDispatchToRamInvoicePages(sampleDispatch);
  const html = renderRamBiotechInvoiceDocument(pages, "Test");
  assert.match(html, /Ram Biotech/);
  assert.match(html, /अटी व शर्ती/);
  assert.match(html, /Name Of The Farmer/);
});

test("buildDeliveryChallanPdfBuffer returns non-empty PDF buffer", async () => {
  process.env.SKIP_PUPPETEER_PDF = "1";
  const buf = await buildDeliveryChallanPdfBuffer(sampleDispatch);
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 100, `expected PDF bytes, got length ${buf.length}`);
  assert.equal(buf.subarray(0, 4).toString("binary"), "%PDF");
  delete process.env.SKIP_PUPPETEER_PDF;
});

test("buildCompleteInvoicePdfBuffer returns non-empty PDF buffer", async () => {
  process.env.SKIP_PUPPETEER_PDF = "1";
  const buf = await buildCompleteInvoicePdfBuffer({
    ...sampleDispatch,
    transportStatus: "DELIVERED",
  });
  assert.ok(buf.length > 100);
  assert.equal(buf.subarray(0, 4).toString("binary"), "%PDF");
  delete process.env.SKIP_PUPPETEER_PDF;
});
