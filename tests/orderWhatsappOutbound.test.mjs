/**
 * Order WhatsApp outbound log — model, routes, service helpers, status transitions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import OrderWhatsappOutbound from "../models/orderWhatsappOutbound.model.js";
import {
  pickLocalMessageId,
  normalizeMobile10,
  updateOutboundFromStatusWebhook,
  recordFarmerReply,
  recordFarmerRescheduleComplete,
  isErpSessionAutoReplyStatusText,
  listOutboundLogs,
  normalizeCampaignName,
  listWhatsappCampaigns,
} from "../services/orderWhatsappOutbound.service.js";

describe("OrderWhatsappOutbound model", () => {
  it("defines farm_ready template and status lifecycle", () => {
    assert.deepEqual(OrderWhatsappOutbound.schema.path("templateType").enumValues, [
      "farm_ready",
    ]);
    assert.deepEqual(OrderWhatsappOutbound.schema.path("status").enumValues, [
      "pending",
      "sent",
      "delivered",
      "read",
      "failed",
    ]);
  });

  it("indexes localMessageId, orderId+createdAt, status+createdAt", () => {
    const indexes = OrderWhatsappOutbound.schema.indexes().map(([spec]) => spec);
    assert.ok(indexes.some((s) => s.localMessageId === 1));
    assert.ok(indexes.some((s) => s.orderId === 1 && s.createdAt === -1));
    assert.ok(indexes.some((s) => s.status === 1 && s.createdAt === -1));
  });

  it("defaults status to pending", () => {
    const doc = new OrderWhatsappOutbound({
      orderId: "507f1f77bcf86cd799439011",
    });
    assert.equal(doc.status, "pending");
    assert.equal(doc.templateType, "farm_ready");
  });
});

describe("order WhatsApp outbound routes", () => {
  it("registers send-selected and outbound log endpoints", () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), "routes/order.route.js"),
      "utf8"
    );
    assert.match(routeSource, /\/whatsapp\/campaigns",\s*noCacheApiResponse,\s*listOrderWhatsappCampaignsController/);
    assert.match(routeSource, /\/whatsapp\/outbound",\s*noCacheApiResponse,\s*listOrderWhatsappOutboundController/);
    assert.match(routeSource, /\/whatsapp\/send-selected",\s*sendSelectedOrdersWhatsappController/);
  });
});

describe("send-selected controller validation", () => {
  it("supports bulk farm-ready send with delay and batch id", () => {
    const source = readFileSync(
      resolve(process.cwd(), "controllers/order.controller.js"),
      "utf8"
    );
    assert.match(source, /WHATSAPP_BULK_SEND_MAX/);
    assert.match(source, /WHATSAPP_BULK_SEND_DELAY_MS/);
    assert.match(source, /batchId/);
    assert.match(source, /campaignName/);
    assert.match(source, /createWhatsappCampaign/);
    assert.match(source, /Campaign name is required for farm-ready WhatsApp send/);
    assert.match(source, /manual_selected/);
    assert.doesNotMatch(source, /Select only 1 order for now/);
  });
});

describe("orderWhatsappOutbound.service helpers", () => {
  it("normalizeCampaignName — trims and caps length", () => {
    assert.equal(normalizeCampaignName("  June Keli  "), "June Keli");
    assert.equal(normalizeCampaignName(""), "Farm Ready Campaign");
    assert.equal(normalizeCampaignName("x".repeat(200)).length, 120);
  });

  it("pickLocalMessageId — nested WATI shapes", () => {
    assert.equal(
      pickLocalMessageId({ data: { localMessageId: "abc-123" } }),
      "abc-123"
    );
    assert.equal(
      pickLocalMessageId({ data: { receivers: [{ localMessageId: "rcv-1" }] } }),
      "rcv-1"
    );
    assert.equal(pickLocalMessageId({}), null);
  });

  it("normalizeMobile10 — strips country code", () => {
    assert.equal(normalizeMobile10("917588686453"), "7588686453");
    assert.equal(normalizeMobile10("7588686453"), "7588686453");
    assert.equal(normalizeMobile10(""), null);
  });

  it("isErpSessionAutoReplyStatusText — skips farm-ready and reschedule confirmations", () => {
    assert.equal(
      isErpSessionAutoReplyStatusText({
        text: "✅ धन्यवाद!\n\nआपले शेत तयार असल्याची नोंद झाली.",
      }),
      true
    );
    assert.equal(
      isErpSessionAutoReplyStatusText({
        text: "✅ धन्यवाद!\n\nआपली Delivery Date निश्चित झाली.\n📅 Delivery Date: 18/06/2026",
      }),
      true
    );
    assert.equal(isErpSessionAutoReplyStatusText({ text: "Hello farmer" }), false);
  });
});

describe("updateOutboundFromStatusWebhook — status rank", () => {
  const orderId = "507f1f77bcf86cd799439011";
  const localMessageId = "msg-test-001";

  const originalFindOne = OrderWhatsappOutbound.findOne.bind(OrderWhatsappOutbound);
  const originalUpdateOne = OrderWhatsappOutbound.updateOne.bind(OrderWhatsappOutbound);

  it("advances sent → delivered → read without downgrading", async () => {
    const docState = {
      _id: "outbound-1",
      orderId,
      localMessageId,
      status: "sent",
      sentAt: new Date("2026-05-27T10:00:00Z"),
      deliveredAt: null,
      readAt: null,
      whatsappMessageId: null,
    };

    OrderWhatsappOutbound.findOne = () => ({
      sort: () => Promise.resolve({ ...docState }),
    });
    OrderWhatsappOutbound.updateOne = async (_filter, update) => {
      Object.assign(docState, update.$set);
      return { modifiedCount: 1 };
    };

    const deliveredAt = new Date("2026-05-27T10:05:00Z");
    const r1 = await updateOutboundFromStatusWebhook({
      localMessageId,
      event: "delivered",
      timestamp: deliveredAt,
    });
    assert.equal(r1.updated, true);
    assert.equal(docState.status, "delivered");
    assert.equal(docState.deliveredAt, deliveredAt);

    const readAt = new Date("2026-05-27T10:10:00Z");
    OrderWhatsappOutbound.findOne = () => ({
      sort: () => Promise.resolve({ ...docState }),
    });
    const r2 = await updateOutboundFromStatusWebhook({
      localMessageId,
      event: "read",
      timestamp: readAt,
    });
    assert.equal(r2.updated, true);
    assert.equal(docState.status, "read");
    assert.equal(docState.readAt, readAt);

    // delivered after read should not downgrade
    OrderWhatsappOutbound.findOne = () => ({
      sort: () => Promise.resolve({ ...docState }),
    });
    const r3 = await updateOutboundFromStatusWebhook({
      localMessageId,
      event: "delivered",
      timestamp: new Date("2026-05-27T10:06:00Z"),
    });
    assert.equal(r3.matched, 1);
    assert.equal(docState.status, "read");

    OrderWhatsappOutbound.findOne = originalFindOne;
    OrderWhatsappOutbound.updateOne = originalUpdateOne;
  });

  it("returns matched 0 when no localMessageId or whatsappMessageId", async () => {
    const r = await updateOutboundFromStatusWebhook({ event: "sent" });
    assert.deepEqual(r, { matched: 0 });
  });

  it("links template sent ids then matches delivered by watiWebhookId", async () => {
    const sendUuid = "d38f0c3a-e833-4725-a894-53a2b1dc1af6";
    const watiId = "6a190344640dd7889fbbacc7";
    const wamid = "wamid.HBgMOTE5NTk1OTk2NDUyFQIAERgSODE0NzEwQUVBODQ3NTRBREQzAA==";
    const docState = {
      _id: "outbound-wati-id",
      orderId,
      localMessageId: sendUuid,
      watiWebhookId: null,
      whatsappMessageId: null,
      status: "sent",
    };

    OrderWhatsappOutbound.findOne = () => ({
      sort: () => Promise.resolve({ ...docState }),
    });
    OrderWhatsappOutbound.updateOne = async (_filter, update) => {
      Object.assign(docState, update.$set);
      return { modifiedCount: 1 };
    };

    await updateOutboundFromStatusWebhook({
      localMessageId: sendUuid,
      watiWebhookId: watiId,
      whatsappMessageId: wamid,
      event: "sent",
      timestamp: new Date("2026-05-29T06:59:00Z"),
    });
    assert.equal(docState.watiWebhookId, watiId);
    assert.equal(docState.whatsappMessageId, wamid);

    const deliveredAt = new Date("2026-05-29T07:00:00Z");
    const r = await updateOutboundFromStatusWebhook({
      watiWebhookId: watiId,
      whatsappMessageId: wamid,
      event: "delivered",
      timestamp: deliveredAt,
    });

    assert.equal(r.matched, 1);
    assert.equal(r.updated, true);
    assert.equal(docState.status, "delivered");
    assert.equal(docState.deliveredAt, deliveredAt);

    OrderWhatsappOutbound.findOne = originalFindOne;
    OrderWhatsappOutbound.updateOne = originalUpdateOne;
  });
});

describe("recordFarmerReply", () => {
  const originalFindOne = OrderWhatsappOutbound.findOne.bind(OrderWhatsappOutbound);
  const originalUpdateOne = OrderWhatsappOutbound.updateOne.bind(OrderWhatsappOutbound);

  it("updates latest farm_ready outbound when no localMessageId match", async () => {
    const orderId = "507f1f77bcf86cd799439011";
    const doc = {
      _id: "out-99",
      orderId,
      templateType: "farm_ready",
      farmerReplyAt: null,
    };
    let updated = null;

    OrderWhatsappOutbound.findOne = (query) => {
      if (query.localMessageId) return Promise.resolve(null);
      if (query.orderId && query.templateType === "farm_ready") {
        return { sort: () => Promise.resolve(doc) };
      }
      return Promise.resolve(null);
    };
    OrderWhatsappOutbound.updateOne = async (_f, update) => {
      updated = update.$set;
      return { modifiedCount: 1 };
    };

    await recordFarmerReply({
      orderId,
      text: "शेत तयार आहे",
      action: "button_farm_ready",
      messageId: "wamid.in",
    });

    assert.equal(updated.farmerReplyText, "शेत तयार आहे");
    assert.equal(updated.farmerReplyAction, "button_farm_ready");
    assert.ok(updated.farmerReplyAt instanceof Date);

    OrderWhatsappOutbound.findOne = originalFindOne;
    OrderWhatsappOutbound.updateOne = originalUpdateOne;
  });

  it("recordFarmerRescheduleComplete — overwrites prior reply with slot summary", async () => {
    const orderId = "507f1f77bcf86cd799439011";
    const doc = {
      _id: "out-resched",
      orderId,
      templateType: "farm_ready",
      farmerReplyAt: new Date("2026-05-29T03:00:00Z"),
      farmerReplyText: "दुसरी तारीख निवडा",
      farmerReplyAction: "button_reschedule",
      status: "read",
    };
    let updated = null;

    OrderWhatsappOutbound.findOne = () => ({
      sort: () => Promise.resolve(doc),
    });
    OrderWhatsappOutbound.updateOne = async (_f, update) => {
      updated = update.$set;
      return { modifiedCount: 1 };
    };

    await recordFarmerRescheduleComplete(orderId, {
      slotLabel: "18 to 24 June",
      deliveryLabel: "18/06/2026",
    });

    assert.equal(updated.farmerReplyAction, "delivery_rescheduled");
    assert.match(updated.farmerReplyText, /18 to 24 June/);
    assert.match(updated.farmerReplyText, /18\/06\/2026/);

    OrderWhatsappOutbound.findOne = originalFindOne;
    OrderWhatsappOutbound.updateOne = originalUpdateOne;
  });
});

describe("listOutboundLogs pagination shape", () => {
  const originalFind = OrderWhatsappOutbound.find.bind(OrderWhatsappOutbound);
  const originalCount = OrderWhatsappOutbound.countDocuments.bind(OrderWhatsappOutbound);

  it("returns data array and pagination metadata", async () => {
    const rows = [{ _id: "a", status: "sent" }];
    OrderWhatsappOutbound.find = () => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            populate: () => ({
              populate: () => ({
                lean: async () => rows,
              }),
            }),
          }),
        }),
      }),
    });
    OrderWhatsappOutbound.countDocuments = async () => 120;

    const result = await listOutboundLogs({ page: 2, limit: 50 });
    assert.deepEqual(result.data, rows);
    assert.equal(result.pagination.page, 2);
    assert.equal(result.pagination.limit, 50);
    assert.equal(result.pagination.total, 120);
    assert.equal(result.pagination.totalPages, 3);

    OrderWhatsappOutbound.find = originalFind;
    OrderWhatsappOutbound.countDocuments = originalCount;
  });
});
