import { describe, it } from "node:test";
import assert from "node:assert";
import mongoose from "mongoose";
import {
  buildSowingMatchForBatchList,
  buildSowingMatchForSingleBatch,
} from "../utility/sowingBatchMatch.js";

describe("sowingBatchMatch — Mongo query compatibility", () => {
  it("never emits $regexReplace or $regexMatch (hosted DB compatibility)", () => {
    const id = new mongoose.Types.ObjectId();
    const forbidden = ["$regexReplace", "$regexMatch"];
    for (const q of [
      buildSowingMatchForBatchList([id], ["100", "BATCH-5"]),
      buildSowingMatchForSingleBatch(id, "100"),
    ]) {
      const s = JSON.stringify(q);
      for (const op of forbidden) {
        assert.ok(
          !s.includes(op),
          `Query must not contain ${op}; got substring match in ${s.slice(0, 200)}…`
        );
      }
    }
  });
});
