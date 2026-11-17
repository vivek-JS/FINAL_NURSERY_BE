/**
 * ICICI Beneficiary Registration API (/BeneAddition): packet and reply mapping,
 * using the replies the CIB_SV sandbox gave in UAT.
 *
 * @see modules/banking/services/iciciBeneRegistration.service.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beneNickname,
  buildBeneAdditionPayload,
  mapBeneAdditionReply,
} from "../modules/banking/services/iciciBeneRegistration.service.js";
import {
  buildBeneValidationPayload,
  mapBeneValidationReply,
} from "../modules/banking/services/iciciBeneValidation.service.js";

const CFG = { corpId: "TXBCORP1", userId: "USER1", aggregatorId: "TXBCIBTEST001", urn: "TESTING123" };

describe("BeneAddition packet", () => {
  it("carries every mandatory field", () => {
    const p = buildBeneAdditionPayload(
      { name: "ABC Traders", accountNumber: "010506009999", ifsc: "citi0000003", bankKind: "NON_ICICI" },
      CFG
    );
    assert.deepEqual(Object.keys(p).sort(), [
      "AGGR_ID", "BnfAccNo", "BnfName", "BnfNickName", "CrpId", "CrpUsr", "IFSC", "PayeeType", "URN",
    ]);
    assert.equal(p.PayeeType, "O");
    assert.equal(p.IFSC, "CITI0000003");
    assert.equal(p.CrpId, "TXBCORP1");
  });

  it("ICICI Bank payees are PayeeType W", () => {
    const p = buildBeneAdditionPayload({ name: "X", accountNumber: "000451000301", ifsc: "ICIC0000011", bankKind: "ICICI" }, CFG);
    assert.equal(p.PayeeType, "W");
  });

  it("nickname is letters and digits, unique by account tail, at most 20 chars", () => {
    assert.equal(beneNickname({ name: "A.B.C Traders & Sons Pvt Ltd", accountNumber: "50100012345678" }), "ABCTRADERSSONSPV5678");
    assert.equal(beneNickname({ nickname: "ram seeds", name: "x", accountNumber: "1234" }), "RAMSEEDS1234");
  });
});

describe("BeneAddition reply (sandbox packets)", () => {
  const cases = [
    [
      { MESSAGE: "Fund transfer to the newly added payee will not be allowed immediately.", ERRORCODE: "66139117", STATUS: "FAILURE", RESPONSE: "FAILURE" },
      "REGISTERED",
    ],
    [
      { MESSAGE: "Counterparty already exists with bene ID 46129112.Please give a unique Bank ID", ERRORCODE: "995609", STATUS: "FAILURE", RESPONSE: "FAILURE" },
      "ALREADY_EXISTS",
    ],
    [{ MESSAGE: "Incorrect IFSC entered.", ERRORCODE: "101436", STATUS: "FAILURE", RESPONSE: "FAILURE" }, "INVALID_IFSC"],
    [{ MESSAGE: "Invalid login credentials.", ERRORCODE: "106803", STATUS: "FAILURE", RESPONSE: "FAILURE" }, "INVALID_LOGIN"],
    [{ MESSAGE: "Invalid Corp ID or User ID or Aggregator ID Is passed.", ERRORCODE: "9906", STATUS: "FAILURE", RESPONSE: "FAILURE" }, "NOT_REGISTERED"],
    [{ success: false, response: 8017, errormessage: "Invalid request." }, "BAD_REQUEST"],
    [{ STATUS: "SUCCESS", RESPONSE: "SUCCESS", MESSAGE: "Payee added" }, "REGISTERED"],
  ];
  for (const [raw, state] of cases) {
    it(`${raw.ERRORCODE || raw.response || raw.STATUS} → ${state}`, () => {
      assert.equal(mapBeneAdditionReply(raw).state, state);
    });
  }

  it("reads ICICI's bene ID from the duplicate message", () => {
    const r = mapBeneAdditionReply({ MESSAGE: "Counterparty already exists with bene ID 46129112.", ERRORCODE: "995609" });
    assert.equal(r.beneId, "46129112");
  });

  it("a fresh add is recognised by its message whatever the code, which becomes the bene ID", () => {
    for (const code of ["66139117", "36231217", "79129229"]) {
      const r = mapBeneAdditionReply({
        MESSAGE: "Fund transfer to the newly added payee will not be allowed immediately. To check the availability, Please check the payee status from the payee list",
        ERRORCODE: code,
        STATUS: "FAILURE",
        RESPONSE: "FAILURE",
      });
      assert.equal(r.state, "REGISTERED");
      assert.equal(r.coolingPeriod, true);
      assert.equal(r.beneId, code);
    }
  });
});

describe("BeneValidation packet", () => {
  it("sends the sign-off identity fields plus the account", () => {
    const p = buildBeneValidationPayload({ accountNumber: "000451000301", ifsc: "icic0000011" }, CFG);
    assert.deepEqual(p, {
      CORPID: "TXBCORP1",
      USERID: "USER1",
      AGGRID: "TXBCIBTEST001",
      URN: "TESTING123",
      BENEACCNO: "000451000301",
      IFSC: "ICIC0000011",
    });
  });

  it("omits IFSC when the caller has none", () => {
    const p = buildBeneValidationPayload({ accountNumber: "000451000301" }, CFG);
    assert.equal("IFSC" in p, false);
  });
});

describe("BeneValidation reply", () => {
  const cases = [
    [{ STATUS: "SUCCESS", RESPONSE: "SUCCESS", MESSAGE: "Beneficiary Validated", BENENAME: "ABC" }, "VALIDATED"],
    [{ MESSAGE: "Invalid Corp ID or User ID or Aggregator ID Is passed.", ERRORCODE: "9906", RESPONSE: "FAILURE" }, "NOT_REGISTERED"],
    [{ MESSAGE: "Invalid login credentials.", ERRORCODE: "106803", RESPONSE: "FAILURE" }, "INVALID_LOGIN"],
    [{ MESSAGE: "Invalid Beneficiary Account No.", ERRORCODE: "100019", RESPONSE: "FAILURE" }, "INVALID_ACCOUNT"],
    [{ success: false, response: 8017, errormessage: "Invalid request." }, "BAD_REQUEST"],
  ];
  for (const [raw, state] of cases) {
    it(`${raw.ERRORCODE || raw.response || raw.STATUS} → ${state}`, () => {
      assert.equal(mapBeneValidationReply(raw).state, state);
    });
  }
});
