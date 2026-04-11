/**
 * 1. Update Chili/Talwar subtype: slotDays=1, plantReadyDays=40, sowingAllowed=true,
 *    rate=1.6, slotStartDate=01-05-2025, slotEndDate=31-12-2026
 * 2. Generate daily slots (1-day) for May 1 2025 → Dec 31 2026 in plantslots collection
 * 3. Re-import the one failed order: Gajanan Hari Ubale (Chili/Talwar, 14000 plants, del May 15 2026)
 *
 * Usage:
 *   node scripts/create-talwar-slots-and-fix-order.js            ← PROD
 *   node scripts/create-talwar-slots-and-fix-order.js --dry-run  ← preview
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import moment from 'moment';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Slot generation (mirrors slots.controller.js logic) ─────────────────────
function generateSlotsForDateRange(startDateStr, endDateStr, slotSize = 1, capacityPerSlot = 50000) {
  const slots   = [];
  let current   = moment(startDateStr, 'DD-MM-YYYY');
  const endMom  = moment(endDateStr,   'DD-MM-YYYY');

  while (current.isSameOrBefore(endMom)) {
    const slotStart = current.clone();
    let   slotEnd   = current.clone().add(slotSize - 1, 'days');

    if (slotEnd.isAfter(endMom))              slotEnd = endMom.clone();
    const monthEnd = slotStart.clone().endOf('month');
    if (slotEnd.isAfter(monthEnd))            slotEnd = monthEnd.clone();

    slots.push({
      startDay:          slotStart.format('DD-MM-YYYY'),
      endDay:            slotEnd.format('DD-MM-YYYY'),
      month:             slotStart.format('MMMM'),
      year:              slotStart.year(),
      totalPlants:       capacityPerSlot,
      totalBookedPlants: 0,
      availablePlants:   capacityPerSlot,
      buffer:            0,
      effectiveBuffer:   0,
      bufferAdjustedCapacity: capacityPerSlot,
      bufferAmount:      0,
      originalTotalPlants: capacityPerSlot,
      orders:            [],
      allowedSalesmen:   [],
      restrictToSalesmen: false,
      overflow:          false,
      status:            true,
    });

    current = slotEnd.clone().add(1, 'days');
  }

  return slots;
}

// ─── Excel serial → JS Date ───────────────────────────────────────────────────
function excelDateToJS(serial) {
  if (!serial || typeof serial !== 'number') return null;
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}
function normalizeDate(d) {
  if (!d) return null;
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

// ─── Find slot for a delivery date ───────────────────────────────────────────
async function findSlotForDate(PlantSlot, plant, subtype, deliveryDate) {
  const targetDate = normalizeDate(deliveryDate);
  const year = targetDate.getFullYear();
  const allDocs = await PlantSlot.find({ plantId: plant._id });

  for (const offset of [0, -7, 7, -14, 14]) {
    const check = new Date(targetDate.getTime() + offset * 86400 * 1000);
    check.setUTCHours(0, 0, 0, 0);

    for (const doc of allDocs) {
      for (const st of doc.subtypeSlots) {
        if (st.subtypeId.toString() !== subtype._id.toString()) continue;
        for (const slot of st.slots) {
          const s = new Date(slot.startDay.split('-').reverse().join('-') + 'T00:00:00Z');
          const e = new Date(slot.endDay.split('-').reverse().join('-')   + 'T00:00:00Z');
          if (check >= s && check <= e) return { slot, offset };
        }
      }
    }
  }
  throw new Error(`No slot found near ${deliveryDate.toDateString()} (±14 days)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const SLOT_SIZE         = 1;         // 1-day slots
  const CAPACITY_PER_SLOT = 50000;
  const SLOT_START        = '01-05-2025';
  const SLOT_END          = '31-12-2026';
  const PLANT_READY_DAYS  = 40;
  const RATE              = 1.6;

  // Failed order data (from Excel row 2)
  const FAILED = {
    name:           'Gajanan Hari Ubale',
    mobile:         '8459597670',
    address:        'Jalandi',
    taluka:         'Jamner',
    district:       'Jalgaon',
    bookingDateSerial: 46114,
    deliveryDateSerial: 46157,
    bookingNo:      '25-26/B1588',
    qty:            14000,
    rate:           1.6,
    reference:      'Barde Sir',
    advAmt:         7000,
    advMatch:       true,
    advMode:        'Online',
    bank:           '1341',
    cheque:         '95215',
    advDateSerial:  46114,
  };

  console.log(DRY_RUN ? '\n🔎 DRY RUN — reads only, no writes\n' : '\n🔗 Connecting to PROD…\n');
  await mongoose.connect(process.env.PROD_MONGO_URL);

  const PlantCms  = (await import('../models/plantCms.model.js')).default;
  const PlantSlot = (await import('../models/slots.model.js')).default;
  const Order     = (await import('../models/order.model.js')).default;
  const Farmer    = (await import('../models/farmer.model.js')).default;
  const User      = (await import('../models/user.model.js')).default;

  // ── Step 1: Update Talwar subtype in PlantCms ──────────────────────────────
  console.log('Step 1: Updating Chili / Talwar subtype config…');
  const chili = await PlantCms.findOne({ name: 'Chili' });
  if (!chili) throw new Error('Chili plant not found');

  const talwarIdx = chili.subtypes.findIndex(s => s.name === 'Talwar');
  if (talwarIdx < 0) throw new Error('Talwar subtype not found');

  const talwar = chili.subtypes[talwarIdx];
  console.log(`  Before: slotDays=${talwar.slotDays}, plantReadyDays=${talwar.plantReadyDays}, start=${talwar.slotStartDate}, end=${talwar.slotEndDate}, capacity=${talwar.slotCapacity}`);

  if (!DRY_RUN) {
    chili.subtypes[talwarIdx].slotDays        = SLOT_SIZE;
    chili.subtypes[talwarIdx].plantReadyDays  = PLANT_READY_DAYS;
    chili.subtypes[talwarIdx].slotStartDate   = SLOT_START;
    chili.subtypes[talwarIdx].slotEndDate     = SLOT_END;
    chili.subtypes[talwarIdx].slotCapacity    = CAPACITY_PER_SLOT;
    chili.subtypes[talwarIdx].rates           = [RATE];
    chili.markModified('subtypes');
    await chili.save();
    console.log(`  ✅ Updated: slotDays=1, plantReadyDays=40, start=${SLOT_START}, end=${SLOT_END}, capacity=${CAPACITY_PER_SLOT}, rate=${RATE}`);
  } else {
    console.log(`  Would set: slotDays=1, plantReadyDays=40, start=${SLOT_START}, end=${SLOT_END}, capacity=${CAPACITY_PER_SLOT}, rate=${RATE}`);
  }

  // Reload to get updated subtype _id
  const chiliUpdated = DRY_RUN ? chili : await PlantCms.findOne({ name: 'Chili' });
  const talwarSubtype = chiliUpdated.subtypes.find(s => s.name === 'Talwar');

  // ── Step 2: Generate slots for 2025 and 2026 ──────────────────────────────
  console.log('\nStep 2: Generating 1-day slots from 01-05-2025 to 31-12-2026…');

  const yearRanges = [
    { year: 2025, start: '01-05-2025', end: '31-12-2025' },
    { year: 2026, start: '01-01-2026', end: '31-12-2026' },
  ];

  let totalSlotsCreated = 0;

  for (const { year, start, end } of yearRanges) {
    const slots = generateSlotsForDateRange(start, end, SLOT_SIZE, CAPACITY_PER_SLOT);
    console.log(`  Year ${year}: ${slots.length} slots (${start} → ${end})`);
    totalSlotsCreated += slots.length;

    if (!DRY_RUN) {
      // Find or create plantslots doc for this plant + year
      let slotDoc = await PlantSlot.findOne({ plantId: chili._id, year });

      if (slotDoc) {
        const stIdx = slotDoc.subtypeSlots.findIndex(
          ss => ss.subtypeId.toString() === talwarSubtype._id.toString()
        );
        if (stIdx >= 0) {
          slotDoc.subtypeSlots[stIdx].slots = slots;
          slotDoc.markModified('subtypeSlots');
        } else {
          slotDoc.subtypeSlots.push({ subtypeId: talwarSubtype._id, slots });
          slotDoc.markModified('subtypeSlots');
        }
        await slotDoc.save();
        console.log(`    ✅ Updated existing slot doc for ${year}`);
      } else {
        await PlantSlot.create({
          plantId: chili._id,
          year,
          subtypeSlots: [{ subtypeId: talwarSubtype._id, slots }],
        });
        console.log(`    ✅ Created new slot doc for ${year}`);
      }
    }
  }

  console.log(`  Total slots that will exist: ${totalSlotsCreated}`);

  // ── Step 3: Re-import the failed order ────────────────────────────────────
  console.log('\nStep 3: Re-importing failed order — Gajanan Hari Ubale…');

  const bookingDate  = normalizeDate(excelDateToJS(FAILED.bookingDateSerial));
  const deliveryDate = normalizeDate(excelDateToJS(FAILED.deliveryDateSerial));
  console.log(`  Booking date : ${bookingDate?.toDateString()}`);
  console.log(`  Delivery date: ${deliveryDate?.toDateString()}`);

  if (!DRY_RUN) {
    // Find or create farmer
    let farmer = await Farmer.findOne({ mobileNumber: Number(FAILED.mobile) });
    if (!farmer) {
      farmer = await Farmer.create({
        name:         FAILED.name,
        mobileNumber: Number(FAILED.mobile),
        village:      FAILED.address,
        taluka:       FAILED.taluka,
        district:     FAILED.district,
        stateName:    'Maharashtra',
        talukaName:   FAILED.taluka,
        districtName: FAILED.district,
        state:        'MH',
      });
      console.log(`  👤 Created farmer: ${farmer.name}`);
    } else {
      console.log(`  👤 Found existing farmer: ${farmer.name}`);
    }

    // Find salesPerson
    let salesPerson = await User.findOne({ name: new RegExp(`^${FAILED.reference}$`, 'i') });
    if (!salesPerson) {
      salesPerson = await User.create({
        name:        FAILED.reference,
        phoneNumber: `9999${Math.floor(100000 + Math.random() * 900000)}`,
        password:    '12345678',
        role:        'DEALER',
      });
      console.log(`  👥 Created user: ${FAILED.reference}`);
    } else {
      console.log(`  👥 Found user: ${salesPerson.name}`);
    }

    // Find slot
    const chiliFresh = await PlantCms.findOne({ name: 'Chili' });
    const talwarFresh = chiliFresh.subtypes.find(s => s.name === 'Talwar');
    const { slot: targetSlot, offset } = await findSlotForDate(PlantSlot, chiliFresh, talwarFresh, deliveryDate);
    console.log(`  📅 Slot found: ${targetSlot.startDay} → ${targetSlot.endDay}` + (offset !== 0 ? ` (offset ${offset}d)` : ''));

    // orderId
    const highestOrder = await Order.findOne().sort({ orderId: -1 });
    const newOrderId   = highestOrder ? highestOrder.orderId + 1 : 100000;

    const orderData = {
      orderId:          newOrderId,
      is_excel:         true,
      farmer:           farmer._id,
      salesPerson:      salesPerson._id,
      numberOfPlants:   FAILED.qty,
      remainingPlants:  FAILED.qty,
      plantName:        chiliFresh._id,
      plantSubtype:     talwarFresh._id,
      bookingSlot:      targetSlot._id,
      orderBookingDate: bookingDate,
      deliveryDate,
      rate:             FAILED.rate,
      orderStatus:      'ACCEPTED',
      orderPaymentStatus: 'PENDING',
      expectedNursery:  'RB',
      payment: [{
        paidAmount:    FAILED.advAmt,
        modeOfPayment: FAILED.advMode,
        bankName:      FAILED.bank,
        chequeNumber:  FAILED.cheque,
        paymentDate:   normalizeDate(excelDateToJS(FAILED.advDateSerial)),
        paymentStatus: 'COLLECTED',
        isWalletPayment: false,
        customerName:  FAILED.name,
      }],
    };

    const order = await Order.create(orderData);
    console.log(`  ✅ Order created: [${order.orderId}] ${FAILED.name} | Chili/Talwar | ${FAILED.qty} plants | del ${deliveryDate?.toDateString()}`);
  } else {
    console.log(`  Would create order: ${FAILED.name} | Chili/Talwar | ${FAILED.qty} plants | del ${deliveryDate?.toDateString()}`);
    console.log(`  Payment: ₹${FAILED.advAmt} via ${FAILED.advMode}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(DRY_RUN ? 'Dry run complete — no writes.' : '✅ All done!');
  console.log('='.repeat(60));

  if (!DRY_RUN) await mongoose.connection.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
