# Unified slot-end nightly cron

Automates what admins do manually from Slots:

1. **Past-due order rollover** — open-pipeline orders on expired booking slots move to the subtype’s current slot window.
2. **Expired capacity roll** — leftover booking `available` + `actualReadyPlants` on expired slots roll onto today’s slot window.
3. **Calendar-ready lagwad relocate** — secondary inward lines that are calendar-ready move to the ongoing slot.

## Enable (production)

Set in `FINAL_NURSERY_BE/.env` on the API server:

```env
SLOT_END_NIGHTLY_ENABLED=true
SLOT_END_NIGHTLY_CRON=5 1 * * *
SLOT_END_NIGHTLY_TZ=Asia/Kolkata
SLOT_END_NIGHTLY_ORDERS=true
SLOT_END_NIGHTLY_CAPACITY_ROLL=true
SLOT_END_NIGHTLY_LAGWAD_RELOCATE=true

# Legacy crons — keep false when unified job is on (avoids double runs):
PAST_DUE_SLOT_ROLLOVER_ENABLED=false
CALENDAR_READY_SLOT_RELOCATE_ENABLED=false
```

Restart the backend after changing env vars.

## Manual run

**CLI** (from `FINAL_NURSERY_BE`):

```bash
node scripts/run-slot-end-nightly.js --dry-run
node scripts/run-slot-end-nightly.js --dry-run --stage
node scripts/run-slot-end-nightly.js --as-of=2026-06-10
node scripts/run-slot-end-nightly.js --no-lagwad
```

**HTTP** (admin: SUPER_ADMIN / OFFICE_ADMIN):

`POST /api/v1/slots/slot-end-nightly/run?dryRun=true`

Optional query/body: `asOfDate`, `plantId`, `subtypeId`, `orders`, `capacityRoll`, `lagwadRelocate` (booleans).

## Tests

```bash
npm run test:slot-end-nightly
```

## Migration from legacy crons

| Legacy | Unified replacement |
|--------|---------------------|
| `PAST_DUE_SLOT_ROLLOVER_ENABLED` + `pastDueSlotRolloverCron.js` | Step 1 in `slotEndNightlyCron.js` |
| `CALENDAR_READY_SLOT_RELOCATE_ENABLED` + capacity roll inside `calendarReadySlotRelocateCron.js` | Steps 2–3 in `slotEndNightlyCron.js` |

When `SLOT_END_NIGHTLY_ENABLED=true`, legacy cron schedulers log a skip message and do not register.
