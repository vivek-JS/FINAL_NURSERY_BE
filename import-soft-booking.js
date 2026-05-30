/**
 * LIVE IMPORT — soft booking 2 (1).xlsx  →  prod DB
 * Run: node import-soft-booking.js
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import XLSX from 'xlsx';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const connectDB = async () => {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URL / MONGODB_URI not set');
  await mongoose.connect(uri);
  console.log('✅ Connected to MongoDB\n');
};

const parseDate = (dateStr) => {
  if (!dateStr) return null;
  if (typeof dateStr === 'string' && dateStr.includes('/')) {
    const [month, day, year] = dateStr.split('/').map(Number);
    const fullYear = year > 30 ? 1900 + year : 2000 + year;
    return new Date(fullYear, month - 1, day);
  }
  return new Date(dateStr);
};

const normalizeDate = (date) => {
  if (!date) return null;
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const shiftDate = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const findSlot = async (PlantSlot, PlantCms, deliveryDate, plantType, plantSubtype) => {
  const year = deliveryDate.getFullYear();
  const normalizedDeliveryDate = normalizeDate(deliveryDate);

  const plant = await PlantCms.findOne({ name: plantType });
  if (!plant) throw new Error(`Plant "${plantType}" not found`);

  const subtype = plant.subtypes.find(st => st.name === plantSubtype);
  if (!subtype) throw new Error(`Variety "${plantSubtype}" not found under "${plantType}"`);

  const slotDocs = await PlantSlot.find({ plantId: plant._id, year });

  for (const offset of [0, -7, 7, -14, 14]) {
    const targetDate = offset === 0
      ? normalizedDeliveryDate
      : normalizeDate(shiftDate(normalizedDeliveryDate, offset));

    for (const slotDoc of slotDocs) {
      for (const st of slotDoc.subtypeSlots) {
        if (st.subtypeId.toString() === subtype._id.toString()) {
          for (const slot of st.slots) {
            const slotStart = new Date(slot.startDay.split('-').reverse().join('-') + 'T00:00:00Z');
            const slotEnd   = new Date(slot.endDay.split('-').reverse().join('-')   + 'T00:00:00Z');
            if (targetDate >= slotStart && targetDate <= slotEnd) {
              return { slot, appliedOffset: offset };
            }
          }
        }
      }
    }
  }
  throw new Error(`No slot found for "${plantSubtype}" near ${deliveryDate.toDateString()} (±14 days)`);
};

const run = async () => {
  await connectDB();

  const Order    = (await import('./models/order.model.js')).default;
  const Farmer   = (await import('./models/farmer.model.js')).default;
  const User     = (await import('./models/user.model.js')).default;
  const PlantCms = (await import('./models/plantCms.model.js')).default;
  const PlantSlot = (await import('./models/slots.model.js')).default;
  const {
    isDealerUser,
    lookupCommissionRateForPlantSubtype,
  } = await import('./services/dealerCommission.service.js');

  console.log('📖 Reading Excel via read-soft-booking.py …\n');
  const { stdout } = await execAsync('python3 read-soft-booking.py', { cwd: __dirname });
  const rows = JSON.parse(stdout);
  console.log(`📦 ${rows.length} rows found — starting import\n`);
  console.log('='.repeat(80));

  const highestOrder = await Order.findOne().sort({ orderId: -1 });
  let nextSystemId = highestOrder ? highestOrder.orderId + 1 : 100000;
  const usedIds = new Set();

  const results  = { success: 0, failed: 0, skipped: 0 };
  const summary  = { slotFallbacks: [], invalidPhone: 0 };
  const successes = [];
  const errors    = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const excelRow = i + 2;

    // Skip blank rows
    const missing = [];
    if (!row['Name'])               missing.push('Name');
    if (!row['Date'])               missing.push('Date');
    if (!row['Expected Del. Date']) missing.push('Expected Del. Date');
    if (!row['Crop'])               missing.push('Crop');
    if (!row['Variety'])            missing.push('Variety');
    if (!row['Plant Qty.'])         missing.push('Plant Qty.');

    if (missing.length) {
      results.skipped++;
      continue;
    }

    try {
      // Phone normalisation
      const rawMobile = row['Mobile No.'];
      let normalizedMobile = null;
      let secondaryMobile  = null;
      let isInvalidPhone   = false;

      if (rawMobile !== undefined && rawMobile !== null) {
        const parts = String(rawMobile).trim().split(/[\/|,]+/).map(p => p.trim()).filter(Boolean);
        const primary = parts[0]?.replace(/\D/g, '') || '';
        if (primary.length >= 10) normalizedMobile = primary.slice(-10);
        else                       isInvalidPhone = true;
        if (parts[1]) {
          const sec = parts[1].replace(/\D/g, '');
          if (sec.length >= 10) secondaryMobile = sec.slice(-10);
        }
      } else {
        isInvalidPhone = true;
      }
      if (isInvalidPhone) summary.invalidPhone++;

      // Farmer — find or create
      const farmerQuery = normalizedMobile
        ? { mobileNumber: Number(normalizedMobile) }
        : { name: row['Name'], taluka: row['Taluka'] || 'Unknown', district: row['District'] || 'Unknown' };

      let farmer = await Farmer.findOne(farmerQuery);
      if (!farmer) {
        farmer = await Farmer.create({
          name: row['Name'],
          mobileNumber:    normalizedMobile   ? Number(normalizedMobile)   : undefined,
          alternateNumber: secondaryMobile    ? Number(secondaryMobile)    : undefined,
          village:    (row['Address'] || '').split(',')[0] || 'Unknown',
          taluka:     row['Taluka']   || 'Unknown',
          district:   row['District'] || 'Unknown',
          stateName:  'Maharashtra',
          talukaName: row['Taluka']   || 'Unknown',
          districtName: row['District'] || 'Unknown',
          state: 'MH',
          isInvalidPhone,
          originalPhoneNumber: isInvalidPhone ? (String(rawMobile) || null) : undefined,
        });
      } else {
        let updated = false;
        if (normalizedMobile && !farmer.mobileNumber)      { farmer.mobileNumber    = Number(normalizedMobile); updated = true; }
        if (secondaryMobile  && !farmer.alternateNumber)   { farmer.alternateNumber = Number(secondaryMobile);  updated = true; }
        if (isInvalidPhone   && !farmer.isInvalidPhone)    { farmer.isInvalidPhone  = true; farmer.originalPhoneNumber = String(rawMobile) || null; updated = true; }
        if (updated) await farmer.save();
      }

      // Sales person — find or create
      const salesName = row['Refrence'] || row['Order By'] || 'Default Sales';
      let salesPerson = await User.findOne({ name: salesName, jobTitle: 'SALES' });
      if (!salesPerson) {
        const dummyPhone = `9999999${Math.floor(1000 + Math.random() * 9000)}`;
        salesPerson = await User.create({
          name: salesName,
          phoneNumber: dummyPhone,
          jobTitle: 'SALES',
          password: '12345678',
          role: 'DEALER',
        });
      }

      // Dates
      const bookingDate  = parseDate(row['Date']);
      const deliveryDate = parseDate(row['Expected Del. Date']);

      // Plant + variety
      const plant = await PlantCms.findOne({ name: row['Crop'] });
      if (!plant) throw new Error(`Plant "${row['Crop']}" not found`);
      const subtype = plant.subtypes.find(st => st.name === row['Variety']);
      if (!subtype) throw new Error(`Variety "${row['Variety']}" not found under "${row['Crop']}"`);

      // Slot
      const { slot: targetSlot, appliedOffset } = await findSlot(PlantSlot, PlantCms, deliveryDate, row['Crop'], row['Variety']);
      if (appliedOffset !== 0) summary.slotFallbacks.push({ row: excelRow, name: row['Name'], offset: appliedOffset });

      // orderId
      const bookingNo = row['Booking NO.'];
      let newOrderId;
      if (bookingNo && bookingNo !== '0' && bookingNo !== 0) {
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

      // Build order
      const orderData = {
        orderId: newOrderId,
        farmer: farmer._id,
        salesPerson: salesPerson._id,
        numberOfPlants:  parseInt(row['Plant Qty.']) || 0,
        remainingPlants: parseInt(row['Plant Qty.']) || 0,
        plantName:    plant._id,
        plantSubtype: subtype._id,
        bookingSlot:  targetSlot._id,
        orderBookingDate: bookingDate,
        deliveryDate,
        rate: parseFloat(row['Rate']) || 0,
        orderStatus: 'ACCEPTED',
        orderPaymentStatus: 'PENDING',
      };

      const remarks = [];
      if (row['Remark'])      remarks.push(row['Remark']);
      if (isInvalidPhone)     remarks.push('Source mobile missing/invalid — farmer flagged');
      if (appliedOffset !== 0) remarks.push(`Slot matched using ${appliedOffset} day adjustment`);
      if (remarks.length)     orderData.orderRemarks = remarks;

      if (row['adv match or not'] && row['Advance Amt.']) {
        const bankValue  = row['Bank']        ? String(row['Bank']).trim()        : '';
        const adAmtMode  = row['Ad. Amt. Mode'] ? String(row['Ad. Amt. Mode']).trim() : '';
        orderData.payment = [{
          paidAmount:    parseFloat(row['Advance Amt.']) || 0,
          modeOfPayment: bankValue || adAmtMode || 'CASH',
          bankName:      bankValue || undefined,
          paymentDate:   row['Advance Date'] ? parseDate(row['Advance Date']) : new Date(),
          paymentStatus: 'COLLECTED',
          isWalletPayment: false,
        }];
      }

      if (isDealerUser(salesPerson)) {
        orderData.commissionRatePerPlant = await lookupCommissionRateForPlantSubtype(
          plant._id,
          subtype._id
        );
      }

      await Order.create(orderData);
      results.success++;
      successes.push({ row: excelRow, orderId: newOrderId, name: row['Name'], crop: `${row['Crop']} / ${row['Variety']}`, plants: row['Plant Qty.'] });

    } catch (err) {
      results.failed++;
      errors.push({ row: excelRow, name: row['Name'] || 'Unknown', error: err.message });
    }
  }

  // ── Console report ──────────────────────────────────────────────────────────
  console.log('\n✅ Import complete!\n');
  console.log('='.repeat(80));
  console.log('📊 IMPORT REPORT');
  console.log('='.repeat(80));
  console.log(`Total rows processed : ${rows.length}`);
  console.log(`✅ Imported          : ${results.success}`);
  console.log(`⏭️  Skipped (blank)   : ${results.skipped}`);
  console.log(`❌ Failed            : ${results.failed}`);
  console.log(`⚠️  Invalid phones    : ${summary.invalidPhone}`);
  console.log(`⚠️  Slot fallbacks    : ${summary.slotFallbacks.length}`);

  if (successes.length) {
    console.log('\n✅ Successfully imported orders:');
    successes.forEach((s, i) =>
      console.log(`  ${String(i+1).padStart(2)}. [${s.orderId}] Row ${s.row} — ${s.name} | ${s.crop} | ${s.plants} plants`)
    );
  }

  if (summary.slotFallbacks.length) {
    console.log('\n⚠️  Slot fallbacks applied:');
    summary.slotFallbacks.forEach(f => console.log(`  Row ${f.row} (${f.name}): +${f.offset}d`));
  }

  if (errors.length) {
    console.log('\n❌ Failed rows:');
    errors.forEach((e, i) => console.log(`  ${i+1}. Row ${e.row} (${e.name}): ${e.error}`));

    // Write failure xlsx
    const cols = ['Date','Booking NO.','Name','Mobile No.','Address','Taluka','District','Crop','Variety','Plant Qty.','Rate','Expected Del. Date','Refrence','Order By','Error'];
    const wsData = [cols, ...errors.map(e => cols.map(c => c === 'Error' ? e.error : (rows[e.row - 2]?.[c] ?? '')))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wsData), 'Failures');
    const failPath = path.join(__dirname, 'soft-booking-failures.xlsx');
    XLSX.writeFile(wb, failPath);
    console.log(`\n📝 Failure details saved to: soft-booking-failures.xlsx`);
  }

  console.log('\n' + '='.repeat(80));
  await mongoose.connection.close();
};

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
