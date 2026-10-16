import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  settleSowPackets,
  isSowingRequestClosed,
  wantsSowingClosed,
} from "../utility/sowPacketSettlement.js";

describe("wantsSowingClosed", () => {
  it("closes when company packets are returned on a partial save", () => {
    assert.equal(wantsSowingClosed({ completeSowing: false, packetsToReturn: 13 }), true);
  });

  it("closes when raising packets are returned on a partial save", () => {
    assert.equal(wantsSowingClosed({ completeSowing: false, raisingPacketsToReturn: 0.5 }), true);
  });

  it("stays a partial save when nothing is returned", () => {
    assert.equal(
      wantsSowingClosed({ completeSowing: false, packetsToReturn: 0, raisingPacketsToReturn: NaN }),
      false
    );
  });

  it("keeps an explicit complete", () => {
    assert.equal(wantsSowingClosed({ completeSowing: true }), true);
  });

  it("returns the leftover too once a return closes the request", () => {
    const completeSowing = wantsSowingClosed({ packetsToReturn: 13 });
    const out = settleSowPackets({ remaining: 43.1, usedHint: 30, packetsToReturn: 13, completeSowing });
    assert.equal(out.packetsUsed, 30);
    assert.ok(Math.abs(out.packetsToReturn - 13.1) < 1e-9);
  });
});

describe("settleSowPackets", () => {
  it("honors explicit return even when plant-based used-hint eats all bags", () => {
    const out = settleSowPackets({
      remaining: 10,
      usedHint: 10,
      packetsToReturn: 3,
      completeSowing: true,
    });
    assert.equal(out.packetsUsed, 7);
    assert.equal(out.packetsToReturn, 3);
  });

  it("auto-returns leftover unused bags on complete when return is 0", () => {
    const out = settleSowPackets({
      remaining: 10,
      usedHint: 8,
      packetsToReturn: 0,
      completeSowing: true,
    });
    assert.equal(out.packetsUsed, 8);
    assert.equal(out.packetsToReturn, 2);
  });

  it("leaves leftover open on partial save", () => {
    const out = settleSowPackets({
      remaining: 10,
      usedHint: 8,
      packetsToReturn: 0,
      completeSowing: false,
    });
    assert.equal(out.packetsUsed, 8);
    assert.equal(out.packetsToReturn, 0);
  });

  it("allows return-only (0 plants / 0 used hint)", () => {
    const out = settleSowPackets({
      remaining: 10,
      usedHint: 0,
      packetsToReturn: 4,
      completeSowing: false,
    });
    assert.equal(out.packetsUsed, 0);
    assert.equal(out.packetsToReturn, 4);
  });

  it("returns all unused bags when completing with 0 plants", () => {
    const out = settleSowPackets({
      remaining: 6,
      usedHint: 0,
      packetsToReturn: 0,
      completeSowing: true,
    });
    assert.equal(out.packetsUsed, 0);
    assert.equal(out.packetsToReturn, 6);
  });

  it("caps return at remaining", () => {
    const out = settleSowPackets({
      remaining: 5,
      usedHint: 1,
      packetsToReturn: 99,
      completeSowing: false,
    });
    assert.equal(out.packetsUsed, 0);
    assert.equal(out.packetsToReturn, 5);
  });
});

describe("isSowingRequestClosed", () => {
  it("closes when worker marks complete even if bags remain", () => {
    assert.equal(
      isSowingRequestClosed({
        completeSowing: true,
        remainingAfter: 4,
        companyPackets: 10,
      }),
      true
    );
  });

  it("stays open on partial save while bags remain", () => {
    assert.equal(
      isSowingRequestClosed({
        completeSowing: false,
        remainingAfter: 4,
        companyPackets: 10,
      }),
      false
    );
  });

  it("auto-closes when remaining bags hit 0", () => {
    assert.equal(
      isSowingRequestClosed({
        completeSowing: false,
        remainingAfter: 0,
        companyPackets: 10,
      }),
      true
    );
  });

  it("stays open when raising bags remain even if company is done", () => {
    assert.equal(
      isSowingRequestClosed({
        completeSowing: false,
        remainingAfter: 4,
        companyPackets: 10,
        raisingPackets: 10,
      }),
      false
    );
  });

  it("auto-closes when only a float remainder is left (0.3 - 0.1 - 0.2)", () => {
    assert.equal(
      isSowingRequestClosed({
        completeSowing: false,
        remainingAfter: 0.3 - 0.1 - 0.2,
        companyPackets: 10,
      }),
      true
    );
  });

  it("stays open with a real fraction of a bag left", () => {
    assert.equal(
      isSowingRequestClosed({
        completeSowing: false,
        remainingAfter: 0.1,
        companyPackets: 10,
      }),
      false
    );
  });

  it("auto-closes mixed request when company + raising leftover is 0", () => {
    assert.equal(
      isSowingRequestClosed({
        completeSowing: false,
        remainingAfter: 0,
        companyPackets: 10,
        raisingPackets: 10,
      }),
      true
    );
  });
});
