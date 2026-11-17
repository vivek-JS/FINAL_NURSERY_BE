import Product from '../models/product.model.js';
import Supplier from '../models/supplier.model.js';
import MeasurementUnit from '../models/measurementUnit.model.js';
import { extractSupplierInvoice } from './gemini.service.js';

const UNIT_ALIASES = {
  kg: ['kg', 'kgs', 'kilogram', 'kilograms', 'kilo'],
  g: ['g', 'gm', 'gms', 'gram', 'grams'],
  l: ['l', 'lt', 'ltr', 'litre', 'liter', 'litres', 'liters'],
  ml: ['ml', 'millilitre', 'milliliter'],
  bag: ['bag', 'bags'],
  pkt: ['pkt', 'pkts', 'packet', 'packets', 'pouch', 'pouches'],
  nos: ['nos', 'no', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'units'],
  box: ['box', 'boxes', 'carton', 'cartons'],
};

function fold(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[०-९]/g, (digit) => String('०१२३४५६७८९'.indexOf(digit)))
    .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function score(query, candidate) {
  const left = fold(query);
  const right = fold(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.includes(left) || left.includes(right)) return 0.9;
  const words = left.split(' ').filter((word) => word.length > 1);
  const other = new Set(right.split(' ').filter((word) => word.length > 1));
  if (!words.length || !other.size) return 0;
  return words.filter((word) => other.has(word)).length / words.length;
}

function bestMatch(query, rows, labels) {
  let chosen = null;
  let best = 0;
  for (const row of rows) {
    const value = Math.max(...labels.map((label) => score(query, label(row))));
    if (value > best) {
      best = value;
      chosen = row;
    }
  }
  return best >= 0.72 ? chosen : null;
}

function numberOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function matchUnit(raw, units) {
  const text = fold(raw);
  if (!text) return null;
  const aliases = Object.values(UNIT_ALIASES).find((list) => list.some((alias) => fold(alias) === text));
  const wanted = new Set(aliases ? aliases.map(fold) : [text]);
  return (
    units.find((unit) => wanted.has(fold(unit.abbreviation)) || wanted.has(fold(unit.name))) ||
    units.find((unit) => fold(unit.abbreviation) === text || fold(unit.name) === text) ||
    null
  );
}

function isoDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (!dmy) return '';
  const day = dmy[1].padStart(2, '0');
  const month = dmy[2].padStart(2, '0');
  return `${dmy[3]}-${month}-${day}`;
}

export async function readSupplierInvoiceImage(buffer, mimeType) {
  const extracted = await extractSupplierInvoice(buffer, mimeType);
  const [products, suppliers, units] = await Promise.all([
    Product.find({ isActive: { $ne: false } }).select('name code primaryUnit').lean(),
    Supplier.find({ isActive: { $ne: false } }).select('name').lean(),
    MeasurementUnit.find({ isActive: { $ne: false } }).select('name abbreviation').lean(),
  ]);

  const supplier = bestMatch(extracted.supplierName, suppliers, [(row) => row.name]);
  const rawLines = Array.isArray(extracted.lines) ? extracted.lines : [];
  const lines = rawLines
    .map((row) => {
      const name = String(row?.name || '').trim();
      if (!name) return null;
      const quantity = numberOf(row.quantity);
      let rate = numberOf(row.rate);
      const amount = numberOf(row.amount);
      if (!rate && amount && quantity) rate = Math.round((amount / quantity) * 100) / 100;
      const product = bestMatch(name, products, [(item) => item.name, (item) => item.code]);
      const unit = matchUnit(row.unit, units);
      const productUnit = product?.primaryUnit ? String(product.primaryUnit) : '';
      return {
        name,
        quantity: quantity || 1,
        unit: String(row.unit || '').trim(),
        rate,
        productId: product ? String(product._id) : '',
        productName: product?.name || '',
        unitId: productUnit || (unit ? String(unit._id) : ''),
        unitName: unit?.name || String(row.unit || '').trim(),
        matched: Boolean(product),
      };
    })
    .filter(Boolean);

  return {
    invoiceNumber: String(extracted.invoiceNumber || '').trim(),
    invoiceDate: isoDate(extracted.invoiceDate),
    supplierName: String(extracted.supplierName || '').trim(),
    supplierId: supplier ? String(supplier._id) : '',
    supplierMatchedName: supplier?.name || '',
    lines,
    units: units.map((unit) => ({
      id: String(unit._id),
      name: unit.name,
      abbreviation: unit.abbreviation,
    })),
  };
}
