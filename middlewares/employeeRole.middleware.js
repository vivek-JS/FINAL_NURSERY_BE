/**
 * Employee management: Office Admin can add/edit; only Super Admin may delete.
 */

const isSuperAdmin = (user) => {
  const jt = user?.jobTitle;
  const r = user?.role;
  return (
    jt === "SUPER_ADMIN" ||
    jt === "SUPERADMIN" ||
    r === "SUPER_ADMIN" ||
    r === "SUPERADMIN"
  );
};

const isOfficeOrSuperAdmin = (user) => {
  const jt = user?.jobTitle;
  const r = user?.role;
  return (
    isSuperAdmin(user) ||
    jt === "OFFICE_ADMIN" ||
    jt === "OFFICEADMIN" ||
    r === "OFFICE_ADMIN" ||
    r === "OFFICEADMIN"
  );
};

export const requireEmployeeManager = (req, res, next) => {
  if (!isOfficeOrSuperAdmin(req.user)) {
    return res.status(403).json({
      status: "fail",
      message: "Only Super Admin or Office Admin can add or edit employees",
    });
  }
  next();
};

export const requireSuperAdminForEmployeeDelete = (req, res, next) => {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({
      status: "fail",
      message: "Only Super Admin can delete employees",
    });
  }
  next();
};
