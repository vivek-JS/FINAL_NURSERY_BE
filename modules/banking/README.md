# ICICI Corporate Banking Module

Enterprise-grade ICICI Corporate API integration for ERP payment reconciliation.

## Architecture

```
React ERP  ──JWT──▶  Express /api/banking/*
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   iciciRegistration  iciciCorporate   reconciliationEngine
   iciciBalance       Statement         suspense.service
   iciciStatus        duplicateDetection verificationStatusEngine
          │               │               │
          ▼               ▼               ▼
   rsaEncryption     BankStatementEntry  Order/Agri payments
   (node-forge)      PaymentReconciliation  CashBook
                     SuspenseEntry          BankReconciliationMatch
                     BankAuditLog
```

### Hybrid encryption flow

```
┌─────────────┐     1. JSON payload
│   Your ERP  │────▶2. Random AES-256 key + IV
└─────────────┘     3. AES encrypt payload → encryptedData
                    4. RSA-OAEP (ICICI public cert) encrypt AES key → encryptedKey
                    5. POST { encryptedKey, encryptedData, iv } to ICICI

ICICI response (same envelope):
  1. RSA decrypt encryptedKey with your private.key
  2. AES decrypt encryptedData
  3. Parse JSON
```

Implementation: `modules/banking/crypto/rsaEncryption.js`

### Payment verification flow

```
PENDING ──(bank agrees on UTR and amount)──▶ BANK_VERIFIED ──(accountant)──▶ COLLECTED
    │
    └──(anything else)──▶ SUSPENSE ──(manual resolve)──▶ BANK_VERIFIED
```

### Reconciliation matching (confidence scoring)

Amount is a hard gate: a pair whose amounts differ by a paisa or more is never a
candidate, however well everything else lines up.

| Rule | Score | Type | Auto-verifies |
|------|-------|------|---------------|
| UTR + amount + account + date | 100 | EXACT | Yes |
| UTR + amount (+ date) | 95–98 | EXACT | Yes |
| Transaction ID + amount | 90 | EXACT | No — suspense |
| Cheque + amount | 85 | EXACT | No — suspense |
| Amount + date + narration similarity | 60–80 | FUZZY | No — suspense |

Only a UTR agreeing with the bank at the same amount may clear a payment on its
own (`qualifiesForAutoVerify`). Every other rule is a suggestion for an
accountant, not a decision — it opens a suspense row carrying its score so the
accountant can see how close it was. There is deliberately no score threshold to
tune: a cheque match scoring 85 still requires a human.

Env: `BANKING_FUZZY_THRESHOLD=60` (the floor below which a pair is not even
offered as a candidate).

### Suspense lifecycle

Each run scores statement lines up to 7 days either side of its range, plus any
line carrying the payment's UTR, transaction id or cheque number on any date.

| Reason | Opened when |
|--------|-------------|
| `NO_MATCH` | A payment has no bank line `BANKING_NO_MATCH_GRACE_DAYS` (default 2) after its payment date. Not raised when the range has no statement at all. |
| `AMOUNT_MISMATCH` | The bank has the payment's UTR at a different amount |
| `MULTIPLE_MATCH` | Two or more lines tie for a payment |
| `MANUAL_REVIEW` | The best line matched on cheque, bank transaction id or amount and date, not a UTR |
| `ORPHAN_CREDIT` | A credit in the range that no payment claimed |

- Payments in suspense stay in every run, so a line that arrives later clears
  them. Their open rows close with `closedBy: SYSTEM`.
- A line offered to a payment is never also an orphan credit, and a payment has
  one open row at a time (a new reason supersedes the old one).
- An accountant's decision sticks. A written-off orphan line becomes `IGNORED`.
  "Return to pending" sends the payment back to the Pending tab, and the
  dismissed pairing is not reopened by later runs.

End-to-end check against a local MongoDB (creates and drops its own database):

```bash
node scripts/test-banking-suspense-lifecycle.mjs
```

### Payouts (maker / checker / ICICI approval)

Outgoing payments need three people (Accounts dashboard → **Payouts** tab):

1. **Maker** (accountant or super admin) creates the payment. It is checked
   against ICICI's rules up front: IFSC format, RTGS ≥ ₹2 L, IMPS ≤ ₹5 L, NEFT
   remarks ≤ 32 characters, letters/digits/spaces only. If the same account and
   amount were paid in the last 7 days, the maker gets a duplicate warning.
2. **ERP checker** (a role in `ICICI_PAYOUT_CHECKER_ROLES`, normally not the
   maker) approves or rejects. A super admin may approve their own payout or
   payee unless `ICICI_PAYOUT_SUPER_ADMIN_SELF_APPROVE=false`; it is recorded as
   self-approved, and ICICI's net-banking approval remains the second check. Approval sends `POST /Transaction` **without
   `WORKFLOW_REQD`**, so ICICI holds it as "Pending For approval".
3. **ICICI authoriser** approves it in net banking (CIB). The status poller (or
   "Check status") moves it to Paid with the UTR, or to Failed/Returned.

| Status | Meaning |
|--------|---------|
| `PENDING_APPROVAL` | Waiting for the ERP checker (maker may cancel) |
| `SUBMITTING` | Being sent; after 5 min without an answer it becomes `UNKNOWN` |
| `AWAITING_BANK_APPROVAL` | Held at ICICI for the net-banking authoriser |
| `PROCESSING` | Approved at ICICI, not settled yet |
| `UNKNOWN` | ICICI did not answer (timeout, 8010/8012/8013/103068). Check status; a checker may resend with the **same** `UNIQUEID`, which ICICI never pays twice |
| `SUCCESS` / `FAILED` / `REVERSED` | Final bank result |
| `REJECTED` / `CANCELLED` | Stopped in the ERP; nothing reached the bank |

The `UNIQUEID` is 15 characters (`RB` + yymmdd + 7 random characters) because
ICICI shows the first 15 in the statement narration. The ICICI corporate must
have a CIB approval workflow configured for the API user, or ICICI may post
the payment without step 3. Payouts are not posted to the ledger yet.

#### Payee register (beneficiaries)

The CIB payment API is ad hoc ("without any bene registration"), and the spec
has no beneficiary registration or validation API, so ICICI keeps no payee list
for us. The register (`icici_beneficiaries`, **Payouts → Payees**) does it in the
ERP with the same two-person rule:

- A maker adds a payee: ICICI Bank (IFSC starts `ICIC`, paid ICICI to ICICI) or
  another bank (NEFT/RTGS/IMPS). Name, account and IFSC are checked as ICICI
  would, and the account number is typed twice.
- A different approver approves (`ACTIVE`) or rejects it. The same account +
  IFSC cannot be registered twice while pending or active.
- A payout with `beneficiaryId` takes the payee details from the register, not
  the request. Disabling a payee blocks approval of its pending payouts.
- `ICICI_PAYOUT_REQUIRE_BENEFICIARY=true` turns off one-time payees.

| UAT "Beneficiary APIs" row | Covered by |
|----------------------------|------------|
| Beneficiary Registration – ICICI | Add payee, ICICI Bank (ERP register) |
| Beneficiary Registration – Non ICICI | Add payee, another bank (ERP register) |
| Beneficiary Validation – Success | Format checks + approval → `ACTIVE` |
| Duplicate / Invalid Beneficiary | `DUPLICATE_BENEFICIARY` (409) / `VALIDATION` (400) |

If ICICI enables registered-beneficiary payments, they must supply that API's
spec; until then mark these UAT rows "No — ad hoc payments" for the bank.

`GET /beneficiaries?status=&search=`, `POST /beneficiaries`, and
`POST /beneficiaries/:id/approve | reject | disable`.

API (all need accountant or super admin): `GET /payouts/config`,
`GET /payouts/summary`, `GET /payouts?view=approval|bank|done|all&search=`,
`POST /payouts`, `GET /payouts/:id`, and `POST /payouts/:id/approve | reject |
cancel | refresh | resend`.

#### Excel upload and bulk decisions (`payoutBulk.service.js`)

- `POST /payouts/bulk` and `POST /beneficiaries/bulk` take `{ rows, dryRun }`
  (max 500 rows; the UI reads the Excel template into rows). Each row gets the
  same checks as a single create. `dryRun: true` (default) only returns
  per-row verdicts: `ok`, `warning` (possible duplicate in the file or the
  last 7 days; payouts only, created with `confirmDuplicates: true`) or
  `error`. The commit creates the valid rows, which still wait for approval.
- A payout row whose account + IFSC is an approved payee is linked to it and
  uses the register's details. All payouts of one upload share a `batchId` /
  `batchName` (`GET /payouts?batchId=`).
- `POST /payouts/bulk-approve | bulk-reject` and
  `POST /beneficiaries/bulk-approve | bulk-reject` take `{ ids, note | reason }`
  and return `{ items: [{ id, ok, status | error }], done, failed }`. Every
  item goes through the normal approve/reject rules. Payout approvals are sent
  to ICICI one at a time, 600 ms apart (ICICI allows 1–2 requests per second),
  at most 25 per request.

```bash
node scripts/test-banking-payouts.mjs   # stub bank + throwaway local MongoDB
```

---

## Folder structure

```
modules/banking/
├── config/iciciCorporate.config.js
├── crypto/
│   ├── keyManager.js          # Load private.key, public.crt, icici_public.crt
│   ├── rsaEncryption.js       # encryptPayload() / decryptPayload()
│   └── requestSigning.js      # HMAC signing, replay prevention
├── middleware/
│   ├── ipWhitelist.js
│   └── idempotency.js
├── models/
│   ├── bankAuditLog.model.js
│   ├── cashBook.model.js
│   ├── iciciRegistration.model.js
│   ├── paymentReconciliation.model.js
│   └── suspenseEntry.model.js
├── services/
│   ├── iciciHttpClient.js
│   ├── iciciRegistration.service.js
│   ├── iciciCorporateStatement.service.js
│   ├── iciciCorporateStatus.service.js
│   ├── iciciBalance.service.js
│   ├── duplicateDetection.service.js
│   ├── reconciliationEngine.service.js
│   ├── suspense.service.js
│   └── verificationStatusEngine.js
├── controllers/banking.controller.js
├── routes/banking.routes.js
├── jobs/bankingCronJobs.js
├── scripts/generate-rsa-keys.sh
└── README.md
```

Existing collections extended: `BankStatementEntry` (accountNumber, duplicateKey, reconciliationStatus).

---

## Step-by-step setup

### 1. Generate RSA 4096 keys

```bash
cd FINAL_NURSERY_BE
bash modules/banking/scripts/generate-rsa-keys.sh
```

Or manually:

```bash
mkdir -p config/certs

# Private key (4096-bit)
openssl genrsa -out config/certs/private.key 4096

# Your public certificate (upload to ICICI during registration)
openssl req -new -x509 -key config/certs/private.key \
  -out config/certs/public.crt -days 365 \
  -subj "/C=IN/O=YourCompany/CN=erp-banking"

# ICICI bank public cert — download from ICICI Corporate API portal
# Save as config/certs/icici_public.crt
```

### 2. Environment variables

Copy from `.env.example`:

```env
ICICI_CORPORATE_ENV=UAT
ICICI_CORPORATE_USE_STUB=true          # false for live
ICICI_CORPORATE_USE_HTTP=true
ICICI_CORPORATE_BASE_URL=https://apibankingonesandbox.icici.bank.in
ICICI_CORPORATE_API_PREFIX=/api/Corporate/CIB_SV/v1
ICICI_CRYPTO_MODE=CIB_SV               # PKCS1 + in-payload IV, per the CIB_SV UAT spec
ICICI_CORPORATE_ID=YOUR_CORP_ID
ICICI_CORPORATE_USER_ID=YOUR_USER
ICICI_AGGREGATOR_ID=YOUR_AGGR_ID
ICICI_AGGRNAME=YOUR_AGGR_NAME
ICICI_URN=YOUR_URN
ICICI_ACCOUNT_ID=YOUR_ACCOUNT_NUMBER
ICICI_CORPORATE_API_KEY=YOUR_API_KEY
ICICI_PRIVATE_KEY_PATH=config/certs/private.key
ICICI_PUBLIC_CERT_PATH=config/certs/public.crt
ICICI_BANK_PUBLIC_CERT_PATH=config/certs/icici_public.crt
ICICI_BANKING_CRON_ENABLED=false
ICICI_TXN_PATH=/Transaction                       # payouts
ICICI_PAYOUT_CHECKER_ROLES=SUPER_ADMIN,SUPERADMIN  # who may approve payouts in the ERP
ICICI_PAYOUT_POLL_ENABLED=false                   # poll ICICI for payout status
ICICI_PAYOUT_POLL_CRON=*/15 * * * *
ICICI_PAYOUT_MIN_CHECK_MS=600000                  # min gap between checks of one payout
ICICI_PAYOUT_REQUIRE_BENEFICIARY=false            # true = pay only approved payees
ICICI_PAYOUT_SUPER_ADMIN_SELF_APPROVE=true        # false = super admins also need a second approver
```

**Never commit** `private.key`, `icici_public.crt`, or API keys.

### 3. Register with ICICI (Step 1)

```bash
curl -X POST http://localhost:8000/api/banking/icici/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Idempotency-Key: reg-$(date +%s)"
```

Sandbox URL: `POST https://apibankingonesandbox.icici.bank.in/api/Corporate/CIB_SV/v1/Registration`

Live calls also need ICICI's own public certificate saved at `ICICI_BANK_PUBLIC_CERT_PATH`;
it arrives as an attachment with the UAT credentials and is not in the repo.

### 4. Fetch statement (Step 2)

```bash
curl -X POST http://localhost:8000/api/banking/icici/statement \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fromDate":"2026-05-01","toDate":"2026-05-27"}'
```

### 4b. Import a statement instead (no bank connection needed)

The ICICI API is optional. An accountant can export the statement from net
banking and load it from the **Statement** tab, which is the supported path
while credentials and certificates are not in place. Everything downstream —
matching, suspense, per-payment checks — behaves identically, because imported
lines are ordinary `BankStatementEntry` rows with `source: "IMPORT"`.

```bash
curl -X POST http://localhost:8000/api/banking/statement/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accountNumber":"000405001234","csv":"Txn Date,Description,Ref No./Cheque No.,Debit,Credit,Balance\n01/04/2026,UPI/CR/412345678901/RAHUL,412345678901,,1500.00,51500.00"}'
```

The parser accepts the common Indian bank export shapes: separate Debit/Credit
columns or one signed Amount column, `dd/mm/yyyy`, `dd-MMM-yy` or ISO dates,
amounts written as `1,23,456.78`, `₹1,500.00`, `250.00 Dr` or `(250.00)`, and
preamble/footer rows which are skipped. Credits are stored positive, debits
negative. If the reference column is blank the parser looks for a UTR in the
narration.

Re-importing the same file inserts nothing: each row carries a deterministic
key, built from the reference when there is one so an imported line and the
same line later pulled from the API collapse into a single row. Two genuinely
identical credits on one day are still kept as two rows.

### 5. Run reconciliation (Step 4)

```bash
curl -X POST http://localhost:8000/api/banking/reconcile \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dateFrom":"2026-05-01","dateTo":"2026-05-27","source":"all"}'
```

### 6. Other APIs

```bash
# Balance
curl http://localhost:8000/api/banking/icici/balance -H "Authorization: Bearer $TOKEN"

# Transaction status
curl "http://localhost:8000/api/banking/icici/status?utr=123456789012&amount=1500" \
  -H "Authorization: Bearer $TOKEN"

# Crypto health (no secrets)
curl http://localhost:8000/api/banking/crypto/health -H "Authorization: Bearer $TOKEN"

# Open suspense queue
curl http://localhost:8000/api/banking/suspense -H "Authorization: Bearer $TOKEN"

# Duplicate check
curl "http://localhost:8000/api/banking/duplicate-check?utr=X&amount=100&txnDate=2026-05-27" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Database schema

### bank_transactions → `BankStatementEntry`

| Field | Type | Notes |
|-------|------|-------|
| txnDate | Date | Indexed |
| amount | Number | |
| referenceNumber / utr | String | Indexed |
| accountNumber | String | Indexed |
| duplicateKey | String | Unique — SHA256(account\|utr\|amount\|date) |
| entryHash | String | Unique — legacy dedupe |
| reconciliationStatus | enum | UNMATCHED, MATCHED, SUSPENSE, IGNORED |
| source | enum | SDK, CORPORATE_HTTP, MANUAL, IMPORT |

### payment_reconciliation → `PaymentReconciliation`

Audit trail per match: paymentId, bankTransactionId, matchType, confidenceScore, runId.

### suspense_entries → `SuspenseEntry`

OPEN items for manual review: ORPHAN_CREDIT, MULTIPLE_MATCH, LOW_CONFIDENCE, etc.

### cash_book → `CashBook`

Bank/cash register lines linked to reconciled payments.

### Indexes

- `BankStatementEntry`: duplicateKey (unique), accountNumber+utr+amount+txnDate
- `PaymentReconciliation`: paymentId+bankTransactionId (unique)
- `SuspenseEntry`: status+createdAt

---

## Duplicate detection (statement lines)

Syncing or importing the same days again only adds lines that are new.
`safeInsertBankTransactions` compares every incoming line with the lines
already saved for that account (±2 days) and with earlier lines of the batch:

1. Both have ICICI's `TRANSACTIONID` → same line if the id and amount match.
2. Otherwise same amount and India-time day, plus the same UTR (or the UTR of
   one appears in the other's narration — a CSV without a reference column).
3. Neither has a reference → same amount, day and narration. Identical lines
   are counted, so two separate ₹500 cash deposits on one day stay two lines
   and a re-sync adds neither.

Because it compares stored lines, it also recognises lines saved before this
check existed. The unique `duplicateKey` / `entryHash` still stop two syncs
running at once from saving a line twice. The result is
`{ inserted, alreadySaved, repeatedInBatch, skipped, total }`, and the sync
message says "Fetched N lines from ICICI, X new saved, Y already in the system".

Statement pages: when more than 200 records match, ICICI returns `LASTTRID`
(`LISTTRID` in its sample); the sync calls again with `CONFLG=Y` and that
value until none comes back (max 100 pages, 600 ms apart). Set
`ICICI_STATEMENT_PAGINATION_PATH` if ICICI gives a separate URL for the next
pages. If a later page fails, the lines already fetched are saved and the
message says to sync again. Statement calls send no `X-Idempotency-Key`, so a
later sync of the same range is never answered with an earlier reply.

`node scripts/test-banking-statement-sync.mjs` (throwaway local MongoDB)
covers these cases.

Use `X-Idempotency-Key` header on POST endpoints for request-level idempotency.

---

## Security

| Control | Implementation |
|---------|----------------|
| IP whitelisting | `ICICI_IP_WHITELIST` — ICICI callback IPs + your office |
| Certificate rotation | Re-run Registration API; replace files; `invalidateKeyCache()` |
| Secure env | Keys in env paths only; never in git |
| Log masking | UTR, account, keys masked in Winston logs |
| Audit logs | `BankAuditLog` — every ICICI HTTP call |
| Request signing | HMAC via `ICICI_WEBHOOK_HMAC_SECRET` |
| Replay prevention | X-Request-Id nonce cache (10 min TTL) |

### Certificate rotation procedure

1. Generate new key pair (`generate-rsa-keys.sh`)
2. POST `/api/banking/icici/register` with new public.crt
3. Update env paths if filenames changed
4. Restart server (or wait 5 min for key cache TTL)

---

## Cron / automation

```env
ICICI_BANKING_CRON_ENABLED=true
ICICI_BANKING_CRON=0 6 * * *
ICICI_BANKING_LOOKBACK_DAYS=3
```

Daily at 06:00 IST: fetch statement → run enhanced reconciliation.

For production queue (Bull/Redis), extend `bankingCronJobs.js` to enqueue jobs instead of inline execution.

---

## Retry handling

`utils/retry.js` — exponential backoff on:
- Network errors (ECONNRESET, ETIMEDOUT)
- HTTP 408, 429, 500, 502, 503, 504

Config: `ICICI_CORPORATE_RETRY_ATTEMPTS=3`, `ICICI_CORPORATE_RETRY_DELAY_MS=1500`

---

## Deployment guidance

1. **TLS termination** at nginx — app runs HTTP internally; ICICI calls use HTTPS via Axios
2. **Store certs** in `/etc/icici/certs/` with `chmod 600` on private.key
3. **Secrets** via Render/AWS Secrets Manager — inject as env vars
4. **Stub mode off** in production: `ICICI_CORPORATE_USE_STUB=false`
5. **Enable cron** after UAT sign-off
6. **Monitor** `BankAuditLog` for FAILED entries
7. **Approval workflow**: payments at BANK_VERIFIED appear in existing `/api/payments/reconciliation/for-approval`

---

## Stub mode (development)

```env
ICICI_CORPORATE_USE_STUB=true
```

All APIs return synthetic data without bank certificates. Use for UI and reconciliation testing.

---

## Integration with existing ERP

| Legacy endpoint | New equivalent |
|-----------------|----------------|
| POST `/api/payments/icici/bank-statement` | POST `/api/banking/icici/statement` |
| POST `/api/payments/reconcile` | POST `/api/banking/reconcile` (enhanced scoring) |
| EazyPay QR `/api/payments/icici/qr` | Unchanged — separate EazyPay SDK |

Both reconciliation endpoints coexist; prefer `/api/banking/reconcile` for confidence scoring and suspense routing.
