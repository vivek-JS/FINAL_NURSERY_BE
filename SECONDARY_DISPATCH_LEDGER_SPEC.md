# Secondary Dispatch Ledger Spec

## Goal

Keep slot, order, batch, and inward balances correct with full traceability for every vehicle `load` and `unload`.

This spec uses append-only ledger records and derived counters.

## Collections

### 1) `secondarydispatchledgerevents`

One row per API action (`LOAD` or `UNLOAD`), stores the full input and resolved allocations.

Required fields:

- `eventId` (uuid)
- `dispatchId`
- `action` (`LOAD`/`UNLOAD`)
- `requestPayload`
- `requestHash`
- `resolvedAllocations`
- `allocationHash`
- `createdBy`
- `createdAt`

Indexes:

- `{ dispatchId: 1, createdAt: -1 }`
- `{ requestHash: 1 }`

### 2) `secondarydispatchledgerlines`

Normalized line-level movement records, one row per allocation line.

Required fields:

- `ledgerLineId` (uuid)
- `eventId`
- `dispatchId`
- `action`
- `linkedOrderId` (nullable)
- `batchId` (nullable)
- `secondaryInwardId` (nullable)
- `secondaryOutwardId` (nullable)
- `linkedBookingSlotId` (nullable)
- `plantsAbs`
- `plantsDelta` (`+` on load, `-` on unload)
- `slotDelta` (`-` on load if slot-linked, `+` on unload if slot-linked)
- `createdAt`

Indexes:

- `{ eventId: 1 }`
- `{ dispatchId: 1, createdAt: -1 }`
- `{ linkedOrderId: 1, createdAt: -1 }`
- `{ batchId: 1, createdAt: -1 }`
- `{ secondaryInwardId: 1, createdAt: -1 }`
- `{ secondaryOutwardId: 1, createdAt: -1 }`
- `{ linkedBookingSlotId: 1, createdAt: -1 }`

## Transaction Flow

Use one Mongo transaction per load/unload request:

1. Validate payload and permissions.
2. Resolve allocations deterministically (FIFO/selected lines).
3. Build event + ledger lines.
4. Insert event and lines.
5. Compute deltas from ledger lines.
6. Apply counter updates:
   - dispatch loaded count
   - order shed-loaded count
   - secondary inward available/remaining
   - slot actual dispatched/available adjustment
7. Commit transaction.

If any update fails, rollback whole transaction.

## Counter Rules

### On LOAD

- `dispatch.shedLoadedPlantsTotal += plants`
- `order.shedLoadedQuantity += plants` (if linked order)
- `secondaryInward.remainingPlants -= plants`
- `slot.actualPlantsDispatched += plants` (or equivalent `actualAvailable -= plants`) when slot-linked

### On UNLOAD

Exact reverse of the linked outward lines:

- `dispatch.shedLoadedPlantsTotal -= plants`
- `order.shedLoadedQuantity -= plants`
- `secondaryInward.remainingPlants += plants`
- `slot.actualPlantsDispatched -= plants` (or equivalent restore)

## Idempotency

Generate key:

- `dispatchId + action + sha256(requestPayloadCanonical)`

Before processing, check whether this idempotency key already exists in events (or a dedicated idempotency collection). If found, return prior result and do not re-apply deltas.

## Read APIs Enabled by Ledger

- Slot-level dispatched by day/batch/inward.
- Order-level loaded from shed grouped by batch lineage.
- Vehicle load/unload history timeline.
- Batch-wise source trace for every dispatched order.

## Module

Use helper module:

- `utils/secondaryDispatchLedger.js`

Workflow service and controllers:

- `services/secondaryDispatchLedgerWorkflow.service.js`
- `controllers/secondaryDispatchLedger.controller.js`
- `routes/secondaryDispatchLedger.routes.js`

Exports:

- payload normalization for load/unload
- immutable event builder
- normalized ledger line builder
- delta aggregation for transactional updates
- idempotency key builder

## Integration in Existing Load/Unload Handlers

Inside your current `/load` and `/unload` handlers:

1. Build resolved allocations as you already do today.
2. Call `recordSecondaryDispatchLedger(...)` in the same transaction.
3. Call `applySecondaryDispatchCounterPatch(...)` with project hooks:
   - dispatch counter update
   - order shed-loaded update
   - secondary inward remaining update
   - slot dispatched/available update
   - batch-level dispatched update
4. Return `slotSubtractTotal` / `slotRestoreTotal` from summed `slotDelta`.

This keeps API response shape compatible while introducing an auditable append-only ledger.
