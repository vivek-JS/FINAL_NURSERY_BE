/** Who may post manual / direct inventory stock adjustments (Ram Agri + Biotech seed). */

export function isSuperAdminUser(user) {
  const role = String(user?.role || '').toUpperCase().trim();
  const jobTitle = String(user?.jobTitle || '').toUpperCase().trim();
  return (
    role === 'SUPER_ADMIN' ||
    role === 'SUPERADMIN' ||
    jobTitle === 'SUPER_ADMIN' ||
    jobTitle === 'SUPERADMIN'
  );
}

export function isRamAgriMasterUser(user) {
  const role = String(user?.role || '').toUpperCase().trim();
  const jobTitle = String(user?.jobTitle || '').toUpperCase().trim();
  return role === 'RAM_AGRI_MASTER' || jobTitle === 'RAM_AGRI_MASTER';
}

export function isRamAgriInputAdminUser(user) {
  const role = String(user?.role || '').toUpperCase().trim();
  const jobTitle = String(user?.jobTitle || '').toUpperCase().trim();
  return role === 'RAM_AGRI_INPUT_ADMIN' || jobTitle === 'RAM_AGRI_INPUT_ADMIN';
}

export function isOfficeAdminUser(user) {
  const role = String(user?.role || '').toUpperCase().trim();
  const jobTitle = String(user?.jobTitle || '').toUpperCase().trim();
  return (
    role === 'OFFICE_ADMIN' ||
    role === 'OFFICEADMIN' ||
    jobTitle === 'OFFICE_ADMIN' ||
    jobTitle === 'OFFICEADMIN'
  );
}

export function isRamAgriSalesOfficeManagerUser(user) {
  const role = String(user?.role || '').toUpperCase().trim();
  const jobTitle = String(user?.jobTitle || '').toUpperCase().trim();
  return (
    role === 'RAM_AGRI_SALES_OFFICE_MANAGER' ||
    jobTitle === 'RAM_AGRI_SALES_OFFICE_MANAGER'
  );
}

export function isAdminUser(user) {
  const role = String(user?.role || '').toUpperCase().trim();
  const jobTitle = String(user?.jobTitle || '').toUpperCase().trim();
  return role === 'ADMIN' || jobTitle === 'ADMIN';
}

export function canDirectStockUpdate(user) {
  if (
    isSuperAdminUser(user) ||
    isRamAgriMasterUser(user) ||
    isRamAgriInputAdminUser(user) ||
    isOfficeAdminUser(user) ||
    isRamAgriSalesOfficeManagerUser(user) ||
    isAdminUser(user)
  ) {
    return true;
  }
  const combined = `${String(user?.jobTitle || '')} ${String(user?.role || '')}`.toUpperCase();
  if (combined.includes('RAM_AGRI_INPUT') && combined.includes('MANAGER')) return true;
  if (combined.includes('RAM AGRI INPUT') && combined.includes('MANAGER')) return true;
  return false;
}
