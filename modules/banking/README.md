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
PENDING ──(statement match score ≥ 85)──▶ BANK_VERIFIED ──(accountant)──▶ COLLECTED
    │
    └──(no match / low score / multiple matches)──▶ SUSPENSE ──(manual resolve)──▶ BANK_VERIFIED
```

### Reconciliation matching (confidence scoring)

| Rule | Score | Type |
|------|-------|------|
| UTR + amount + account + date | 100 | EXACT |
| UTR + amount (+ date) | 95–98 | EXACT |
| Transaction ID + amount | 90 | EXACT |
| Cheque + amount | 85 | EXACT |
| Amount + date + narration similarity | 60–80 | FUZZY |

Env: `BANKING_AUTO_VERIFY_THRESHOLD=85`, `BANKING_FUZZY_THRESHOLD=60`

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
ICICI_CORPORATE_BASE_URL=https://apibankingonesandbox.icicibank.com
ICICI_CORPORATE_ID=YOUR_CORP_ID
ICICI_CORPORATE_USER_ID=YOUR_USER
ICICI_AGGREGATOR_ID=YOUR_AGGR_ID
ICICI_ACCOUNT_ID=YOUR_ACCOUNT_NUMBER
ICICI_CORPORATE_API_KEY=YOUR_API_KEY
ICICI_PRIVATE_KEY_PATH=config/certs/private.key
ICICI_PUBLIC_CERT_PATH=config/certs/public.crt
ICICI_BANK_PUBLIC_CERT_PATH=config/certs/icici_public.crt
ICICI_BANKING_CRON_ENABLED=false
```

**Never commit** `private.key`, `icici_public.crt`, or API keys.

### 3. Register with ICICI (Step 1)

```bash
curl -X POST http://localhost:8000/api/banking/icici/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Idempotency-Key: reg-$(date +%s)"
```

Sandbox URL: `POST https://apibankingonesandbox.icicibank.com/api/Corporate/CIB/v1/Registration`

### 4. Fetch statement (Step 2)

```bash
curl -X POST http://localhost:8000/api/banking/icici/statement \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fromDate":"2026-05-01","toDate":"2026-05-27"}'
```

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
| source | enum | SDK, CORPORATE_HTTP, MANUAL |

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

## Duplicate UTR detection

Composite key: `SHA256(accountNumber|UTR|amount|YYYY-MM-DD)`

Safe insert: `duplicateDetection.service.js` → catches MongoDB 11000, returns `{ inserted, skipped, duplicates }`.

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
