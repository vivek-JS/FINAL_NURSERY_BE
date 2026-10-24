import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFastOrderExportStages,
  ORDER_EXPORT_MAX_ROWS,
} from "../services/orderExportList.service.js";

function limitStage(pipeline) {
  return pipeline.find((stage) => Object.prototype.hasOwnProperty.call(stage, "$limit"));
}

test("fast order export defaults to the full export cap", () => {
  const pipeline = [];
  appendFastOrderExportStages(pipeline, { sort: { createdAt: -1 } });

  assert.equal(limitStage(pipeline)?.$limit, ORDER_EXPORT_MAX_ROWS);
});

test("fast order export caps oversized helper limits", () => {
  const pipeline = [];
  appendFastOrderExportStages(pipeline, { limit: ORDER_EXPORT_MAX_ROWS + 1 });

  assert.equal(limitStage(pipeline)?.$limit, ORDER_EXPORT_MAX_ROWS);
});

test("fast order export still accepts smaller explicit helper limits", () => {
  const pipeline = [];
  appendFastOrderExportStages(pipeline, { limit: 25 });

  assert.equal(limitStage(pipeline)?.$limit, 25);
});
