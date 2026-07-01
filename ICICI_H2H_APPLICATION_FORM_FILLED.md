# ICICI Bank - API H2H Application Form (Filled Draft)

> Reference: `API H2H Application form_16Apr2026_V5.0.pdf` (ICICI Bank, V5.0)
> Applicant: **Ram Biotech** (Nursery / Agri ERP)

## How to use this document

This is a **draft fill** for the official ICICI Bank API H2H application PDF. Transcribe these
values into the actual PDF before submission.

- **Technical values** (callback URLs, server IPs, SSL cert, API selections) are derived from the
  ERP backend (`FINAL_NURSERY_BE`) and are ready to use after confirmation.
- **`TBD - ...`** marks business/legal/banking values that are **not** in the codebase and must be
  supplied from company records (GST, PAN, bank account, registered contacts, transaction volumes).
- Each requested API product is tagged with an implementation status:
  - `[Implemented]` - working code exists in the backend.
  - `[Partial]` - related code exists but not the full bank flow.
  - `[Net-new]` - selected per request, but no backing code yet (development required).

---

## PAGE 1

### Customer Details

| # | Field | Value |
|---|-------|-------|
| 1 | Onboarding ID (generated from IDP) | `TBD - provided by ICICI IDP after initiation` |
| 2 | Account Name (as per Bank records) | `TBD - registered current account name (e.g. Ram Biotech)` |
| 3 | Account No. for Credit/Debit Fund | `TBD - ICICI current account number` |
| 4 | Account No. for Debit charges | `TBD - account to debit service/setup charges` |
| 5 | Cust ID / Corp ID, User ID & Alias ID | `TBD - CIB Corp ID, User ID, Alias ID` |
| 6 | Contact Name | `TBD - authorized business contact` |
| 7 | Registered Mobile Number | `TBD - registered mobile` |
| 8 | Registered Email ID | `TBD - registered business email` |
| 9 | Tech person name (authorized for tech details) & contact no. | `TBD - integration owner name + phone` |
| 10 | Tech person Email ID | `TBD - integration owner email` |
| 11 | GSTIN | `TBD - Ram Biotech GSTIN` |
| 12 | Address | `TBD - confirm registered address. ERP invoice template shows: Nashirabad - Sunasgaon road, Nashirabad, Tal. & Dist. Jalgaon, Maharashtra 425309` |
| 13 | PAN Number | `TBD - company PAN` |
| 14 | Email ID for UPI Collection Merchant Dashboard / H2H / API Integration Kit | `TBD - email to receive dashboard + API kit credentials` |
| 15 | Annual UPI Collection Txn Volume (no. of txn) | `TBD - estimated annual count` |
| 16 | Peak daily UPI Collection Txn Volume (no. of txn) | `TBD - estimated peak/day count` |
| 17 | Annual UPI Collection Txn Value (INR) | `TBD - estimated annual value` |
| 18 | Peak daily UPI Collection Txn Value (INR) | `TBD - estimated peak/day value` |

### Integration Required (Select API)

All products requested per instruction. Status reflects current backend support.

| Product | Requested | Status | Backing code |
|---------|-----------|--------|--------------|
| E-Collect API | Yes | `[Net-new]` | No virtual-account / e-collection code exists |
| UPI Collect API (collect + QR) | Yes | `[Implemented]` | EazyPay dynamic QR: `services/iciciQr.service.js`, `services/iciciBankService.js`, `UPI_QR` mode in `models/order.model.js` |
| CIB API | Yes | `[Implemented]` | Corporate statement/balance/recon: `src/services/iciciApiService.js`, `services/iciciStatement.service.js`, `modules/banking/` |
| CIB Bulk | Yes | `[Net-new]` | No bulk payout flow implemented |
| Composite API (IMPS/UPI/NEFT/RTGS payout, STP) | Yes | `[Net-new]` | No outbound payout/payment API; manual recording only |
| H2H / SFTP / Flick | Yes | `[Net-new]` | No SFTP/Flick file integration |
| Connected Banking (Aggregator) | Yes | `[Net-new]` | No aggregator integration |

- TSP support required (Rs. 15,000 in addition to setup fee): **`TBD - Yes / No`**
- Support Needed: **`TBD - Yes / No`**

### Integration Charges

> "Applicable for testing and TSP support valid for 60 days from date of application."
> Write `NA` where not applicable; `NIL` for zero/no charges.
> All commercials below are governed by the ICICI **Schedule of Charges (SOC)** - fill the agreed
> rates during commercial negotiation.

| Product / Mode | Setup / Implementation | Transaction Charges |
|----------------|------------------------|---------------------|
| **E-Collect API** | `TBD (per SOC)` | NEFT: `TBD` / RTGS: `TBD` / FT: `TBD` / IMPS: `TBD` / UPI: `TBD` |
| iValidation deemed decision (if no/late response from your server) | **Recommend: Deemed Reject** | Rationale: ERP confirms payment only via callback/statement match before marking `BANK_VERIFIED`; auto-accept on timeout risks unverified credits |
| **UPI Collect API** (collect + QR) | `TBD (per SOC)` | B2C: NIL / B2B: NIL |
| **CIB API** | `TBD (per SOC)` | NEFT: `TBD` / RTGS: `TBD` / FT: `TBD` / IMPS (slabs `0<=1,000` / `>1,000<=25,000` / `>25,000`): `TBD` |
| **CIB Bulk** | `TBD (per SOC)` | NEFT: `TBD` / FT: `TBD` |
| **Composite API** | `TBD (per SOC)` | NEFT: `TBD` / RTGS: `TBD` / IMPS slabs: `TBD` / UPI slabs: `TBD` |
| **H2H / SFTP / Flick** | `TBD (per SOC)` | As per SOC (IPAY / Ecollection) |
| **IMPS** | `TBD (per SOC)` | Count slabs `<=250000` / `>250000<=500000` / `>500000<=750000` / `>750000`: `TBD` (excl. taxes) |
| **Connected Banking** | Aggregator Name: `TBD` | As per SOC: `TBD` |

### Product Capability Checklist (Collection / Payment / Others)

Tick = requested. Status notes show what the ERP currently supports.

**Collection**
- [x] eCollection API - iValidation (Msg Hold + MIS) - `[Net-new]`
- [x] UPI 2.0 - `[Partial]` (UPI QR collection implemented; UPI 2.0 mandates not implemented)
- [x] UPI collection - `[Implemented]` (EazyPay dynamic QR)
- [x] Dynamic VPA - `[Partial]` (dynamic QR uses merchant txn id; per-payer VPA not implemented)
- [x] H2H / SFTP Collection - `[Net-new]`
- [x] H2H Flick Collection - `[Net-new]`
- [x] NACH - `[Net-new]`
- [x] eNACH - `[Net-new]`
- [x] eSIGN - `[Net-new]`

**Payment**
- [x] CIB Multimode Payment & Recon APIs - `[Partial]` (statement + reconciliation implemented; outbound multimode payout not implemented)
- [x] CIB Bulk API - `[Net-new]`
- [x] Composite Pay (CIB + IMPS + UPI + Penny Drop) - `[Net-new]`
- [x] H2H / SFTP Payments - `[Net-new]`
- [x] H2H Flick Payments - `[Net-new]`
- [x] Composite Pay (Penny Less) - `[Net-new]`
- [x] RPP API - `[Net-new]`

**Others**
- [x] Balance Check - `[Implemented]` (`GET /api/banking/icici/balance`)
- [x] Bank statement - `[Implemented]` (`services/iciciStatement.service.js`, `POST /api/banking/icici/statement`)
- [x] OTP creation and validation - `[Net-new]`
- [x] Penny Less - `[Net-new]`
- [x] Connected Banking - `[Net-new]`
- [x] RPP API - `[Net-new]`

### Limits

| Mode | Limit |
|------|-------|
| UPI | `TBD - per-txn / daily limit` |
| IMPS | `TBD` |
| NEFT | `TBD` |
| RTGS | `TBD` |

### Signature

- To be signed by customer: **Signature as per Mode of Operation (MOP)** - `TBD - authorized signatory`
- Date (D D M M Y Y Y Y): `TBD`

---

## PAGE 2

### For NACH / eNACH / eSIGN

> Not implemented in the ERP. Mark `NA` unless these products are actually being onboarded now.

| Product | Setup / Implementation | Mandate charges (per mandate) | Transaction charges (per txn) |
|---------|------------------------|-------------------------------|-------------------------------|
| NACH | `TBD / NA` | `TBD / NA` | `TBD / NA` |
| eNACH | `TBD / NA` | `TBD / NA` | `TBD / NA` |
| eSIGN | `TBD / NA` | `TBD / NA` | `TBD / NA` |

- NPCI AMC on stored mandates passed on at actuals (per NPCI/2020-21/NACH/Circular No. 006).
- Dormant mandate fee schedule (informational, set by ICICI/NPCI):
  - First year: Re. 1/- ; Second & third year: Rs. 2/- ; Fourth & fifth year: Rs. 3/- ; Sixth year onwards: Rs. 5/-
- Active mandate maintenance: Rs. 0.50 per mandate per annum.

### Corporate Front End Access - NACH Module Access

> Attach a separate list/letter if more than 2 users. Currently `NA` (NACH not used).

| Username | CIB User ID (Existing) | Email ID | Mobile No | Role (Maker/Checker) |
|----------|------------------------|----------|-----------|----------------------|
| `TBD / NA` | `TBD / NA` | `TBD / NA` | `TBD / NA` | `TBD / NA` |

### Technical Requisition

> "Attach the technical Requisition document as per applicable product."

| Field | Value |
|-------|-------|
| Products needing static IP | H2H, CIB API, Composite API, E-Collection, UPI Collection |
| Static Public IP for SFTP / Flick | `TBD - only if H2H/SFTP onboarded` |
| **UAT Static IP** (comprehensive list used for integration) | `TBD - confirm UAT egress IP(s) of the server used for testing` |
| **Production Static IP** (comprehensive list for live integration) | `167.71.232.6` - **CONFIRM** on the live VPS (`curl ifconfig.me`); single-server VPS hosting `api1.rambiotechplants.com` |
| **UAT Callback URL** (SSL https://) | `TBD - UAT host equivalent of the prod callback below (e.g. staging domain)/api/v1/order/payment/qr-callback` |
| **Production Callback URL** (SSL https://) | `https://api1.rambiotechplants.com/api/v1/order/payment/qr-callback` |
| CA-Signed SSL Certificate | 4096-bit public key, issued on client name. Cert org `RamBiotech`, CN `erp-icici-banking` (see `scripts/generate-icici-cert.sh`). `TBD - obtain CA-signed cert; current cert is self-generated` |

**Notes for the bank's technical team:**
- Inbound UPI QR callback handler: `controllers/order.controller.js` -> `handleQRPaymentCallback`,
  route `POST /api/v1/order/payment/qr-callback` (public, no JWT). Matches by `referenceId`
  (ICICI `merchantTranId`) or `UTR + amount`; idempotent.
- ERP also uses **status polling** as a fallback: `GET /api/payments/icici/status/:merchantTranId`.
- Corporate API base (sandbox): `https://apibankingonesandbox.icicibank.com`, prefix
  `/api/Corporate/CIB/v1`; RSA-4096 + AES hybrid encryption with registered public cert.
- Server: Node.js / Express, default `PORT=8000`, `trust proxy` enabled, behind nginx + Let's Encrypt.

### Declaration

Reference only - to be read, accepted and signed on the official PDF by an authorized signatory.
Covers: accuracy of particulars (incl. GSTIN/PAN/billing address); acceptance of CMS / UPI / IMPS /
AEPS / API Service T&Cs and Current Account + CIB terms; consent to data sharing with ICICI group;
consent to communications; authorization to debit account for charges; authority to avail/terminate
the API service; Penny Drop/Penny Less prior beneficiary consent; indemnity for non-compliance.

- Authorized signatory: `TBD`
- Date: `TBD`

### Collection Compliance Annexure (Aggregator)

Reference only - applicable if onboarding as an **Aggregator** with merchant collections. Confirms:
no dealings with prohibited business profiles; settlement directly to merchant accounts; Aggregator
responsible for merchant KYC and prior ICICI approval per merchant; e-collection validation mode
onboarding; audit/inspection rights for ICICI.

- Confirmation (review T&C at the ICICI Corporate Banking link in the form): `TBD - confirm if applying as Aggregator; if direct merchant, may be NA`
- Authorized signatory: `TBD`
- Date: `TBD`

---

## Summary of values you must supply (business/legal)

1. ICICI Corp ID / User ID / Alias ID, current account number(s), onboarding ID.
2. Account name (as per bank), registered mobile & email.
3. GSTIN, PAN, confirmed registered address.
4. Tech person name, phone, email.
5. Email for UPI merchant dashboard / API integration kit.
6. Estimated UPI txn volumes & values (annual + peak daily).
7. Agreed commercials (setup + per-txn charges per SOC), TSP support Yes/No.
8. Transaction limits (UPI / IMPS / NEFT / RTGS).
9. UAT host/domain + UAT static egress IP; confirm production IP `167.71.232.6`.
10. CA-signed 4096-bit SSL certificate on company name.
11. Authorized signatory + date; Aggregator vs direct-merchant decision.
