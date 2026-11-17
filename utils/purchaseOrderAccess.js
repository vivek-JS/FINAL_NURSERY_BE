/** Roles that may create PO with auto-approve + auto GRN (inventory purchase orders). */

const PO_AUTO_ACCEPT_ROLES = new Set([
  'SUPER_ADMIN',
  'SUPERADMIN',
  'OFFICE_ADMIN',
  'OFFICEADMIN',
  'RAM_AGRI_MASTER',
  'RAM_AGRI_SALES_MANAGER',
  'RAM_AGRI_SALES_OFFICE_MANAGER',
]);

export function canPurchaseOrderAutoAccept(user) {
  if (!user) return false;
  const jt = String(user.jobTitle || '').trim().toUpperCase();
  const role = String(user.role || '').trim().toUpperCase();
  return PO_AUTO_ACCEPT_ROLES.has(jt) || PO_AUTO_ACCEPT_ROLES.has(role);
}

const STORE_PHONE_ROLES = new Set([
  ...PO_AUTO_ACCEPT_ROLES,
  'ADMIN',
  'ACCOUNTANT',
  'CASHIER',
  'STORE',
  'STORE_MANAGER',
  'INVENTORY',
]);

export function canUseStorePhone(user) {
  if (!user) return false;
  const jt = String(user.jobTitle || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const role = String(user.role || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return STORE_PHONE_ROLES.has(jt) || STORE_PHONE_ROLES.has(role);
}
