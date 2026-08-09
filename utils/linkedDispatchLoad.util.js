import { getAgriOrderLines } from '../models/agriSalesOrder.model.js';

function normalizeCategory(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ');
}

export function isGiftInventoryCategory(category) {
  return normalizeCategory(category) === 'gift';
}

/** Build display rows for plant dispatch — seeds, chemicals (Ram Agri) and gift inventory lines. */
export function buildLinkedDispatchLoadLines(order, productById = new Map()) {
  const lines = getAgriOrderLines(order);
  return lines.map((line) => {
    const isRamAgri = Boolean(line.isRamAgriProduct || line.ramAgriCropId);
    let category = null;
    let isGift = false;

    if (isRamAgri) {
      category = line.ramAgriCropName ? 'ram_agri' : 'ram_agri';
    } else {
      const pid = line.productId?._id || line.productId;
      const product = pid ? productById.get(String(pid)) : null;
      category = product?.category || null;
      isGift = isGiftInventoryCategory(category);
    }

    const productName =
      line.productName ||
      (line.ramAgriCropName && line.ramAgriVarietyName
        ? `${line.ramAgriCropName} · ${line.ramAgriVarietyName}`
        : line.ramAgriCropName) ||
      'Product';

    return {
      productName,
      quantity: Number(line.quantity) || 0,
      rate: Number(line.rate) || 0,
      category,
      isGift,
      isRamAgriProduct: isRamAgri,
      unitAbbreviation:
        line.primaryUnit?.abbreviation ||
        line.primaryUnit?.name ||
        productById.get(String(line.productId?._id || line.productId || ''))?.primaryUnit
          ?.abbreviation ||
        '',
    };
  });
}

export function mapLinkedOrdersForDispatchStatus(linkedOrders, productById) {
  return linkedOrders.map((order) => ({
    agriOrderId: order._id,
    agriOrderNumber: order.orderNumber,
    linkedNurseryOrderId: order.linkedNurseryOrderId,
    linkedNurseryOrderCode: order.linkedNurseryOrderCode || '',
    agriLoadStatus: order.agriLoadStatus || 'PENDING_LOAD',
    dispatchStatus: order.dispatchStatus,
    orderStatus: order.orderStatus,
    customerName: order.customerName,
    productName: order.productName,
    quantity: order.quantity,
    loadLines: buildLinkedDispatchLoadLines(order, productById),
  }));
}
