/**
 * DRY RUN — soft booking 2 (1).xlsx
 *
 * Reads the new soft-booking Excel and validates each row against the DB
 * WITHOUT writing anything. Reports what would be created vs found,
 * and flags any rows that would fail.
 *
 * Run: node dry-run-soft-booking.js
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const connectDB = async () => {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URL / MONGODB_URI not set');
  await mongoose.connect(uri);
  console.log('✅ Connected to MongoDB (read-only dry run)\n');
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
  if (!plant) return { found: false, reason: `Plant "${plantType}" not found in CMS` };

  const subtype = plant.subtypes.find(st => st.name === plantSubtype);
  if (!subtype) return { found: false, reason: `Variety "${plantSubtype}" not found under "${plantType}"` };

  const slotDocs = await PlantSlot.find({ plantId: plant._id, year });

  const candidateOffsets = [0, -7, 7, -14, 14];
  for (const offset of candidateOffsets) {
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
              return { found: true, slotId: slot._id, appliedOffset: offset };
            }
          }
        }
      }
    }
  }
  return { found: false, reason: `No slot found for "${plantSubtype}" near ${deliveryDate.toDateString()} (±14 days)` };
};

const run = async () => {
  await connectDB();

  const Order    = (await import('./models/order.model.js')).default;
  const Farmer   = (await import('./models/farmer.model.js')).default;
  const User     = (await import('./models/user.model.js')).default;
  const PlantCms = (await import('./models/plantCms.model.js')).default;
  const PlantSlot = (await import('./models/slots.model.js')).default;

  console.log('📖 Reading Excel via read-soft-booking.py …\n');
  const { stdout } = await execAsync('python3 read-soft-booking.py', { cwd: __dirname });
  const rows = JSON.parse(stdout);
  console.log(`📦 ${rows.length} rows found in Excel\n`);
  console.log('='.repeat(90));

  const highestOrder = await Order.findOne().sort({ orderId: -1 });
  let nextSystemId = highestOrder ? highestOrder.orderId + 1 : 100000;
  const usedIds = new Set();

  const summary = {
    wouldSucceed: 0,
    wouldFail: 0,
    farmerNew: 0,
    farmerFound: 0,
    salesNew: 0,
    salesFound: 0,
    slotFallbacks: [],
    invalidPhone: 0,
    duplicateBookingNo: 0,
    errors: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const excelRow = i + 2;
    const issues = [];
    const notes  = [];

    // ── Required field check ────────────────────────────────────────────────
    const missing = [];
    if (!row['Name'])              missing.push('Name');
    if (!row['Date'])              missing.push('Date');
    if (!row['Expected Del. Date']) missing.push('Expected Del. Date');
    if (!row['Crop'])              missing.push('Crop');
    if (!row['Variety'])           missing.push('Variety');
    if (!row['Plant Qty.'])        missing.push('Plant Qty.');
    if (missing.length) {
      issues.push(`Missing required fields: ${missing.join(', ')}`);
    }

    // ── Phone normalisation ─────────────────────────────────────────────────
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

    if (isInvalidPhone) {
      summary.invalidPhone++;
      notes.push(`⚠️  Invalid/missing phone: "${rawMobile}"`);
    }

    // ── Farmer lookup ───────────────────────────────────────────────────────
    let farmerStatus = '?';
    if (!missing.includes('Name')) {
      const farmerQuery = normalizedMobile
        ? { mobileNumber: Number(normalizedMobile) }
        : { name: row['Name'], taluka: row['Taluka'] || 'Unknown', district: row['District'] || 'Unknown' };
      const farmer = await Farmer.findOne(farmerQuery);
      if (farmer) {
        farmerStatus = `FOUND (${farmer._id})`;
        summary.farmerFound++;
      } else {
        farmerStatus = 'NEW (would create)';
        summary.farmerNew++;
      }
    }

    // ── Sales person lookup ─────────────────────────────────────────────────
    const salesName = row['Refrence'] || row['Order By'] || 'Default Sales';
    const sales = await User.findOne({ name: salesName, jobTitle: 'SALES' });
    let salesStatus;
    if (sales) {
      salesStatus = `FOUND`;
      summary.salesFound++;
    } else {
      salesStatus = `NEW (would create "${salesName}")`;
      summary.salesNew++;
    }

    // ── Plant / Variety lookup ──────────────────────────────────────────────
    let plantStatus = '?';
    let varietyStatus = '?';
    let plant = null;
    if (row['Crop']) {
      plant = await PlantCms.findOne({ name: row['Crop'] });
      if (!plant) {
        issues.push(`Plant "${row['Crop']}" not found in CMS`);
        plantStatus = 'NOT FOUND ❌';
      } else {
        plantStatus = 'FOUND';
        const subtype = plant.subtypes.find(st => st.name === row['Variety']);
        if (!subtype) {
          issues.push(`Variety "${row['Variety']}" not found under "${row['Crop']}"`);
          varietyStatus = 'NOT FOUND ❌';
        } else {
          varietyStatus = 'FOUND';
        }
      }
    }

    // ── Slot lookup ─────────────────────────────────────────────────────────
    let slotStatus = '?';
    if (!issues.length && plant) {
      const deliveryDate = parseDate(row['Expected Del. Date']);
      const slotResult = await findSlot(PlantSlot, PlantCms, deliveryDate, row['Crop'], row['Variety']);
      if (slotResult.found) {
        if (slotResult.appliedOffset !== 0) {
          slotStatus = `FOUND (offset ${slotResult.appliedOffset}d) ⚠️`;
          summary.slotFallbacks.push({ row: excelRow, name: row['Name'], offset: slotResult.appliedOffset });
          notes.push(`Slot matched with ${slotResult.appliedOffset} day offset`);
        } else {
          slotStatus = 'FOUND ✅';
        }
      } else {
        issues.push(slotResult.reason);
        slotStatus = 'NOT FOUND ❌';
      }
    }

    // ── Booking NO. / orderId collision check ───────────────────────────────
    const bookingNo = row['Booking NO.'];
    let assignedId;
    if (bookingNo && bookingNo !== '0' && bookingNo !== 0) {
      const numericId = parseInt(String(bookingNo).replace(/\D/g, '')) || null;
      if (numericId) {
        if (usedIds.has(numericId)) {
          assignedId = nextSystemId++;
          summary.duplicateBookingNo++;
          notes.push(`Booking NO. "${bookingNo}" already used in this batch → will use system ID ${assignedId}`);
        } else {
          const existing = await Order.findOne({ orderId: numericId });
          if (existing) {
            assignedId = nextSystemId++;
            summary.duplicateBookingNo++;
            notes.push(`Booking NO. "${bookingNo}" already in DB → will use system ID ${assignedId}`);
          } else {
            assignedId = numericId;
          }
        }
      } else {
        assignedId = nextSystemId++;
        notes.push(`Booking NO. "${bookingNo}" is non-numeric → using system ID ${assignedId}`);
      }
    } else {
      assignedId = nextSystemId++;
    }
    usedIds.add(assignedId);

    // ── Output row result ───────────────────────────────────────────────────
    const status = issues.length ? '❌ WOULD FAIL' : '✅ WOULD SUCCEED';
    if (issues.length) summary.wouldFail++; else summary.wouldSucceed++;

    console.log(`Row ${String(excelRow).padStart(2)} | ${status} | ${(row['Name'] || '').padEnd(30)} | ID: ${assignedId}`);
    console.log(`       Crop: ${row['Crop']} / ${row['Variety']}  |  Plants: ${row['Plant Qty.']}  |  Del: ${row['Expected Del. Date']}`);
    console.log(`       Farmer: ${farmerStatus}  |  Sales: ${salesStatus}`);
    console.log(`       Plant: ${plantStatus}  |  Variety: ${varietyStatus}  |  Slot: ${slotStatus}`);
    if (notes.length)  notes.forEach(n  => console.log(`       📝 ${n}`));
    if (issues.length) issues.forEach(e => console.log(`       ❌ ${e}`));
    console.log();

    if (issues.length) {
      summary.errors.push({ row: excelRow, name: row['Name'], issues });
    }
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('='.repeat(90));
  console.log('📊 DRY RUN SUMMARY');
  console.log('='.repeat(90));
  console.log(`Total rows:              ${rows.length}`);
  console.log(`✅ Would succeed:        ${summary.wouldSucceed}`);
  console.log(`❌ Would fail:           ${summary.wouldFail}`);
  console.log(`👤 Farmers (new):        ${summary.farmerNew}`);
  console.log(`👤 Farmers (existing):   ${summary.farmerFound}`);
  console.log(`👔 Sales (new):          ${summary.salesNew}`);
  console.log(`👔 Sales (existing):     ${summary.salesFound}`);
  console.log(`⚠️  Invalid phones:       ${summary.invalidPhone}`);
  console.log(`⚠️  Slot fallbacks:       ${summary.slotFallbacks.length}`);
  console.log(`⚠️  Booking NO. collisions: ${summary.duplicateBookingNo}`);

  if (summary.errors.length) {
    console.log('\n❌ Rows that would fail:');
    summary.errors.forEach((e, idx) => {
      console.log(`  ${idx + 1}. Row ${e.row} (${e.name}): ${e.issues.join(' | ')}`);
    });
  }

  console.log('\n🚫 Nothing was written to the database — this was a dry run.');
  console.log('   Run  node import-soft-booking.js  when ready to actually import.\n');

  await mongoose.connection.close();
};

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
