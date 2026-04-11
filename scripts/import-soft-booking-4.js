/**
 * LIVE IMPORT — soft booking Data 4.xlsx → prod DB
 *
 * Usage (from FINAL_NURSERY_BE):
 *   node scripts/import-soft-booking-4.js            ← PROD (default)
 *   node scripts/import-soft-booking-4.js --dry-run  ← preview only
 *   node scripts/import-soft-booking-4.js --stage    ← stage DB
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ─── CLI flags ───────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const STAGE   = args.includes('--stage');

const XLSX_PATH = path.join(__dirname, 'data', 'soft booking Data 4.xlsx');

// ─── Crop / variety name normalisation ───────────────────────────────────────
const CROP_MAP = {
  chilli:      'Chili',
  chili:       'Chili',
  papaya:      'Papaya',
  banana:      'Banana',
  watermelon:  'Watermelon',
  muskmelon:   'Muskmelon',
};

const VARIETY_MAP = {
  'g-9':       'G9',
  'g9':        'G9',
  'superson':  'Superson',
  'superman':  'Superson',
};

function normCrop(raw) {
  if (!raw) return raw;
  return CROP_MAP[String(raw).trim().toLowerCase()] || String(raw).trim();
}

function normVariety(raw) {
  if (!raw) return raw;
  const lower = String(raw).trim().toLowerCase();
  return VARIETY_MAP[lower] || String(raw).trim();
}

// ─── Excel serial date → JS Date ─────────────────────────────────────────────
// Excel epoch is 1899-12-30 (due to the fictional leap day in 1900)
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

// ─── Slot lookup ─────────────────────────────────────────────────────────────
async function findSlot(PlantSlot, plant, subtype, deliveryDate) {
  const year = deliveryDate ? deliveryDate.getFullYear() : new Date().getFullYear();
  const slotDocs = await PlantSlot.find({ plantId: plant._id, year });

  // For date-less orders, also try adjacent years
  const allSlotDocs = deliveryDate
    ? slotDocs
    : await PlantSlot.find({ plantId: plant._id });

  const targetDate = deliveryDate ? normalizeDate(deliveryDate) : null;

  // Try exact match then ±7, ±14 day offsets; if no delivery date → first slot
  const offsets = targetDate ? [0, -7, 7, -14, 14] : [null];

  for (const offset of offsets) {
    const checkDate = offset === null
      ? null
      : offset === 0
        ? targetDate
        : normalizeDate(new Date(targetDate.getTime() + offset * 86400 * 1000));

    for (const slotDoc of allSlotDocs) {
      for (const st of slotDoc.subtypeSlots) {
        if (st.subtypeId.toString() !== subtype._id.toString()) continue;
        for (const slot of st.slots) {
          if (checkDate === null) {
            // No delivery date — return first slot chronologically
            return { slot, appliedOffset: 0, noDeliveryDate: true };
          }
          const slotStart = new Date(slot.startDay.split('-').reverse().join('-') + 'T00:00:00Z');
          const slotEnd   = new Date(slot.endDay.split('-').reverse().join('-')   + 'T00:00:00Z');
          if (checkDate >= slotStart && checkDate <= slotEnd) {
            return { slot, appliedOffset: offset };
          }
        }
      }
    }
  }

  throw new Error(
    `No slot found for "${subtype.name}" ` +
    (deliveryDate ? `near ${deliveryDate.toDateString()} (±14 days)` : '(any date)')
  );
}

// ─── Phone normalisation ──────────────────────────────────────────────────────
function parsePhone(raw) {
  if (raw === undefined || raw === null || raw === '') return { mobile: null, invalid: true };
  const parts = String(raw).trim().split(/[\/|,]+/).map(p => p.trim()).filter(Boolean);
  const primary = (parts[0] || '').replace(/\D/g, '');
  if (primary.length >= 10) return { mobile: primary.slice(-10), invalid: false };
  return { mobile: null, invalid: true };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // DB connection
  let uri;
  if (STAGE) {
    uri = process.env.STAGE_MONGO_URL || process.env.MONGO_URL;
    if (!uri) { console.error('Missing STAGE_MONGO_URL'); process.exit(1); }
    console.log('🔗 Connecting to STAGE…');
  } else {
    uri = process.env.PROD_MONGO_URL;
    if (!uri) { console.error('Missing PROD_MONGO_URL'); process.exit(1); }
    console.log('🔗 Connecting to PROD…');
  }

  if (!DRY_RUN) await mongoose.connect(uri);

  const Order    = DRY_RUN ? null : (await import('../models/order.model.js')).default;
  const Farmer   = DRY_RUN ? null : (await import('../models/farmer.model.js')).default;
  const User     = DRY_RUN ? null : (await import('../models/user.model.js')).default;
  const PlantCms = DRY_RUN ? null : (await import('../models/plantCms.model.js')).default;
  const PlantSlot = DRY_RUN ? null : (await import('../models/slots.model.js')).default;

  // Read Excel
  const wb    = XLSX.readFile(XLSX_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (matrix.length < 2) { console.error('Empty sheet'); process.exit(1); }

  // Hardcoded column indices (verified from Excel header row):
  // 0=Date, 1=Booking NO., 2=Name, 3=Mobile No., 4=Address, 5=Taluka, 6=District,
  // 7=Advance On Booking Receipts, 8=adv match or not, 9=Advance Amt., 10=Crop,
  // 11=Variety, 12=Media, 13=Expected Nursery, 14=Plant Qty., 15=Rate,
  // 16=Expected Del. Date, 17=Old Del. Date, 18=Del. Y/N, 19=Actually Deli.Date,
  // 20=Invoice amount, 21=Bal. Amt., 22=Refrence, 23=Order By,
  // 24=Ad. Amt. Mode, 25=Bank, 26=CH No., 27=Advance Date, 28=Receipt Code,
  // 29=ADV Y/N, 30=CC Y/N, 31=Remark
  const iDate     = 0;
  const iBookNo   = 1;
  const iName     = 2;
  const iMobile   = 3;
  const iAddress  = 4;
  const iTaluka   = 5;
  const iDistrict = 6;
  const iAdvMatch = 8;
  const iAdvAmt   = 9;
  const iCrop     = 10;
  const iVariety  = 11;
  const iMedia    = 12;
  const iExpNurs  = 13;
  const iQty      = 14;
  const iRate     = 15;
  const iDelDate  = 16;
  const iRef      = 22;
  const iOrderBy  = 23;
  const iAdvMode  = 24;
  const iBank     = 25;
  const iCheque   = 26;
  const iAdvDate  = 27;
  const iRemark   = 31;

  // Convert each row
  const rows = [];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    const bookingNo = String(row[iBookNo] ?? '').trim();
    const name      = String(row[iName]  ?? '').trim();
    if (!bookingNo && !name) continue; // blank
    rows.push({
      rowNum:         r + 1,
      date:           row[iDate],
      bookingNo,
      name,
      mobile:         row[iMobile],
      address:        String(row[iAddress]  ?? '').trim(),
      taluka:         String(row[iTaluka]   ?? '').trim(),
      district:       String(row[iDistrict] ?? '').trim(),
      advAmt:         row[iAdvAmt],
      advMatch:       row[iAdvMatch],
      crop:           String(row[iCrop]     ?? '').trim(),
      variety:        String(row[iVariety]  ?? '').trim(),
      media:          String(row[iMedia]    ?? '').trim(),
      expectedNursery: String(row[iExpNurs] ?? '').trim(),
      qty:            row[iQty],
      rate:           row[iRate],
      delDate:        row[iDelDate],
      reference:      String(row[iRef]      ?? '').trim(),
      orderBy:        String(row[iOrderBy]  ?? '').trim(),
      advMode:        String(row[iAdvMode]  ?? '').trim(),
      bank:           row[iBank],
      cheque:         row[iCheque],
      advDate:        row[iAdvDate],
      remark:         String(row[iRemark]   ?? '').trim(),
    });
  }

  console.log(`\n📦 ${rows.length} data rows found — ${DRY_RUN ? 'DRY RUN (no writes)' : 'starting import'}\n`);
  console.log('='.repeat(80));

  if (DRY_RUN) {
    rows.forEach((r, i) => {
      const delStr = r.delDate ? excelDateToJS(r.delDate)?.toDateString() : '(no date)';
      console.log(`  Row ${r.rowNum}: [${r.bookingNo}] ${r.name} | ${normCrop(r.crop)} / ${normVariety(r.variety)} | qty=${r.qty} rate=${r.rate} | del=${delStr}`);
    });
    console.log('\nDry run complete. No writes made.');
    return;
  }

  // Start import
  const highestOrder = await Order.findOne().sort({ orderId: -1 });
  let nextSystemId   = highestOrder ? highestOrder.orderId + 1 : 100000;
  const usedIds      = new Set();

  const results   = { success: 0, failed: 0, skipped: 0 };
  const summary   = { slotFallbacks: [], invalidPhone: 0, noDelDate: 0 };
  const successes = [];
  const errors    = [];

  for (const row of rows) {
    const { rowNum } = row;
    const missing = [];
    if (!row.name)   missing.push('Name');
    if (!row.crop)   missing.push('Crop');
    if (!row.variety) missing.push('Variety');
    if (!row.qty)    missing.push('Plant Qty.');

    if (missing.length) {
      results.skipped++;
      console.log(`  ⏭️  Row ${rowNum}: skipped — missing ${missing.join(', ')}`);
      continue;
    }

    try {
      // Phone
      const { mobile, invalid } = parsePhone(row.mobile);
      if (invalid) summary.invalidPhone++;

      // Farmer — find or create
      const farmerQuery = mobile
        ? { mobileNumber: Number(mobile) }
        : { name: row.name };

      let farmer = await Farmer.findOne(farmerQuery);
      if (!farmer) {
        farmer = await Farmer.create({
          name:           row.name,
          mobileNumber:   mobile ? Number(mobile) : undefined,
          village:        row.address.split(',')[0] || 'Unknown',
          taluka:         row.taluka   || 'Unknown',
          district:       row.district || 'Unknown',
          stateName:      'Maharashtra',
          talukaName:     row.taluka   || 'Unknown',
          districtName:   row.district || 'Unknown',
          state:          'MH',
          isInvalidPhone: invalid,
          originalPhoneNumber: invalid ? String(row.mobile || '') : undefined,
        });
        console.log(`  👤 Created farmer: ${farmer.name} (${mobile || 'no phone'})`);
      }

      // Sales person — find by name (case-insensitive), else create
      const salesName = row.reference || row.orderBy || 'Default Sales';
      let salesPerson = await User.findOne({ name: new RegExp(`^${salesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      if (!salesPerson) {
        const dummyPhone = `9999${Math.floor(100000 + Math.random() * 900000)}`;
        salesPerson = await User.create({
          name:        salesName,
          phoneNumber: dummyPhone,
          password:    '12345678',
          role:        'DEALER',
        });
        console.log(`  👥 Created user: ${salesName}`);
      }

      // Dates
      const bookingDate  = row.date   ? normalizeDate(excelDateToJS(row.date))   : new Date();
      const deliveryDate = row.delDate ? normalizeDate(excelDateToJS(row.delDate)) : null;
      if (!deliveryDate) summary.noDelDate++;

      // Plant + variety (case-insensitive)
      const cropName    = normCrop(row.crop);
      const varietyName = normVariety(row.variety);

      const plant = await PlantCms.findOne({ name: new RegExp(`^${cropName}$`, 'i') });
      if (!plant) throw new Error(`Plant "${cropName}" not found`);

      const subtype = plant.subtypes.find(
        st => st.name.toLowerCase() === varietyName.toLowerCase()
      );
      if (!subtype) throw new Error(`Variety "${varietyName}" not found under "${plant.name}" (subtypes: ${plant.subtypes.map(s => s.name).join(', ')})`);

      // Slot
      const { slot: targetSlot, appliedOffset, noDeliveryDate } = await findSlot(
        PlantSlot, plant, subtype, deliveryDate
      );
      if (appliedOffset !== 0) {
        summary.slotFallbacks.push({ row: rowNum, name: row.name, offset: appliedOffset });
      }

      // orderId
      let newOrderId;
      const bookingNo = row.bookingNo;
      if (bookingNo && bookingNo !== '0') {
        const numericId = parseInt(String(bookingNo).replace(/\D/g, '')) || null;
        if (numericId && !usedIds.has(numericId) && !(await Order.findOne({ orderId: numericId }))) {
          newOrderId = numericId;
        } else {
          newOrderId = nextSystemId++;
        }
      } else {
        newOrderId = nextSystemId++;
      }
      usedIds.add(newOrderId);

      // Build order payload
      const orderData = {
        orderId:          newOrderId,
        is_excel:         true,
        farmer:           farmer._id,
        salesPerson:      salesPerson._id,
        numberOfPlants:   parseInt(row.qty)  || 0,
        remainingPlants:  parseInt(row.qty)  || 0,
        plantName:        plant._id,
        plantSubtype:     subtype._id,
        bookingSlot:      targetSlot._id,
        orderBookingDate: bookingDate,
        deliveryDate,
        rate:             parseFloat(row.rate) || 0,
        orderStatus:      'ACCEPTED',
        orderPaymentStatus: 'PENDING',
        expectedNursery:  row.expectedNursery || undefined,
      };

      // Remarks
      const remarks = [];
      if (row.remark)       remarks.push(row.remark);
      if (invalid)          remarks.push('Source mobile missing/invalid — farmer flagged');
      if (noDeliveryDate)   remarks.push('No delivery date in source data');
      if (appliedOffset !== 0) remarks.push(`Slot matched using ${appliedOffset > 0 ? '+' : ''}${appliedOffset} day adjustment`);
      if (remarks.length)   orderData.orderRemarks = remarks;

      // Advance payment
      if (row.advMatch && row.advAmt && parseFloat(row.advAmt) > 0) {
        const bankStr  = row.bank  ? String(row.bank).trim()  : '';
        const modeStr  = row.advMode ? String(row.advMode).trim() : '';
        orderData.payment = [{
          paidAmount:    parseFloat(row.advAmt),
          modeOfPayment: modeStr || bankStr || 'CASH',
          bankName:      bankStr || undefined,
          chequeNumber:  row.cheque ? String(row.cheque).trim() : undefined,
          paymentDate:   row.advDate ? normalizeDate(excelDateToJS(row.advDate)) : bookingDate,
          paymentStatus: 'COLLECTED',
          isWalletPayment: false,
          customerName:  row.name,
        }];
      }

      await Order.create(orderData);
      results.success++;
      successes.push({
        row: rowNum, orderId: newOrderId, name: row.name,
        crop: `${plant.name} / ${subtype.name}`,
        plants: row.qty, del: deliveryDate?.toDateString() || '—',
      });
      console.log(`  ✅ Row ${rowNum}: [${newOrderId}] ${row.name} | ${plant.name}/${subtype.name} | ${row.qty} plants`);

    } catch (err) {
      results.failed++;
      errors.push({ row: rowNum, name: row.name || 'Unknown', error: err.message });
      console.log(`  ❌ Row ${rowNum} (${row.name}): ${err.message}`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('📊 IMPORT REPORT');
  console.log('='.repeat(80));
  console.log(`Total rows processed  : ${rows.length}`);
  console.log(`✅ Imported           : ${results.success}`);
  console.log(`⏭️  Skipped (blank)    : ${results.skipped}`);
  console.log(`❌ Failed             : ${results.failed}`);
  console.log(`⚠️  Invalid phones     : ${summary.invalidPhone}`);
  console.log(`⚠️  No delivery date   : ${summary.noDelDate}`);
  console.log(`⚠️  Slot fallbacks     : ${summary.slotFallbacks.length}`);

  if (successes.length) {
    console.log('\n✅ Successfully imported:');
    successes.forEach((s, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. [${s.orderId}] Row ${s.row} — ${s.name} | ${s.crop} | ${s.plants} plants | del ${s.del}`)
    );
  }

  if (summary.slotFallbacks.length) {
    console.log('\n⚠️  Slot fallbacks applied:');
    summary.slotFallbacks.forEach(f =>
      console.log(`  Row ${f.row} (${f.name}): ${f.offset > 0 ? '+' : ''}${f.offset}d`)
    );
  }

  if (errors.length) {
    console.log('\n❌ Failed rows:');
    errors.forEach((e, i) => console.log(`  ${i + 1}. Row ${e.row} (${e.name}): ${e.error}`));

    // Write failures xlsx
    const wb2 = XLSX.utils.book_new();
    const cols = ['Row','Booking NO.','Name','Crop','Variety','Plant Qty.','Rate','Del. Date','Error'];
    const wsData = [cols, ...errors.map(e => {
      const src = rows.find(r => r.rowNum === e.row) || {};
      return [e.row, src.bookingNo, e.name, src.crop, src.variety, src.qty, src.rate, src.delDate, e.error];
    })];
    XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(wsData), 'Failures');
    const failPath = path.join(__dirname, 'soft-booking-4-failures.xlsx');
    XLSX.writeFile(wb2, failPath);
    console.log(`\n📝 Failures saved to: scripts/soft-booking-4-failures.xlsx`);
  }

  console.log('\n' + '='.repeat(80));
  await mongoose.connection.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
