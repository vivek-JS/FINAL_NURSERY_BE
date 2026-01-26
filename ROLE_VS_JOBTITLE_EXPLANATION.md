# Difference Between Role and Job Title

## Overview

In the Nursery Management System, **`role`** and **`jobTitle`** serve different purposes:

- **`role`**: Used for **authentication, authorization, and access control** (security/permissions)
- **`jobTitle`**: Used for **organizational/functional classification** (what the person does in the organization)

---

## 🔐 ROLE (Security & Permissions)

### Purpose
- **Primary use**: Access control, permissions, and security
- **Used by**: Middleware, route protection, API authorization
- **Determines**: What features/endpoints a user can access

### Available Roles
```javascript
enum: [
  "SUPER_ADMIN",    // Full system access
  "ADMIN",          // Administrative access
  "SALES",          // Sales team access
  "DEALER",         // Dealer access
  "FARMER",         // Farmer access (default)
  "ACCOUNTANT",     // Financial operations
  "OFFICE_ADMIN",   // Office management
  "DISPATCH_MANAGER" // Dispatch operations
]
```

### How It's Used
1. **Route Protection**: `authorizeRoles(['SUPER_ADMIN', 'ADMIN'])`
2. **Permission Checks**: `if (req.user.role === 'SUPER_ADMIN')`
3. **Access Control**: Determines which API endpoints are accessible
4. **Security Middleware**: Used in `auth.middleware.js` for authorization

### Example Usage
```javascript
// In middleware/auth.middleware.js
const userRole = req.user.role;
if (!requiredRoles.includes(userRole)) {
  return res.status(403).json({ error: 'Insufficient permissions' });
}

// In controllers
if (req.user.role !== 'SUPER_ADMIN') {
  // Restrict access
}
```

---

## 👔 JOB TITLE (Organizational Classification)

### Purpose
- **Primary use**: Organizational structure, reporting, filtering
- **Used by**: UI display, filtering, organizational hierarchy
- **Determines**: What department/function the person belongs to

### Available Job Titles
```javascript
enum: [
  "Manager",                // Management position
  "HR",                     // Human Resources
  "SALES",                  // Sales department
  "PRIMARY",                // Primary operations
  "OFFICE_STAFF",           // Office staff
  "DRIVER",                 // Transportation
  "LABORATORY_MANAGER",     // Lab management
  "DEALER",                 // Dealer position
  "OFFICE_ADMIN",           // Office administration
  "ACCOUNTANT",             // Accounting department
  "DISPATCH_MANAGER",       // Dispatch management
  "RAM_AGRI_SALES",         // Ram Agri sales team
  "RAM_AGRI_SALES_MANAGER"  // Ram Agri sales management
]
```

### How It's Used
1. **UI Display**: Shows user's position in the organization
2. **Filtering**: Filter users by department/function
3. **Reporting**: Group users by job title for reports
4. **Organizational Logic**: Special business logic based on job title

### Example Usage
```javascript
// In controllers/agriSalesOrder.controller.js
if (req.user.jobTitle === "RAM_AGRI_SALES") {
  // Special logic for Ram Agri sales team
} else if (req.user.jobTitle === "RAM_AGRI_SALES_MANAGER") {
  // Special logic for Ram Agri sales manager
}

// Filtering users
query.jobTitle = jobTitle; // Filter by job title
```

---

## 🔄 Key Differences

| Aspect | ROLE | JOB TITLE |
|--------|------|-----------|
| **Purpose** | Security & Permissions | Organizational Classification |
| **Used For** | Access control, API authorization | UI display, filtering, reporting |
| **Default** | "FARMER" | No default (optional) |
| **Required** | Yes (always set) | No (can be null/undefined) |
| **Security Impact** | High (affects what user can do) | Low (mostly informational) |
| **Can Change** | Yes, but affects permissions | Yes, more flexible |

---

## 📋 Real-World Examples

### Example 1: Super Admin
```javascript
{
  role: "SUPER_ADMIN",        // Full system access
  jobTitle: "Manager"         // Organizational position
}
```
- **Role** determines: Can access all features
- **Job Title** determines: Shown as "Manager" in UI

### Example 2: Accountant
```javascript
{
  role: "ACCOUNTANT",         // Can access payment features
  jobTitle: "ACCOUNTANT"      // Works in accounting department
}
```
- **Role** determines: Can add/change payments
- **Job Title** determines: Shown in accounting department

### Example 3: Sales Person
```javascript
{
  role: "SALES",              // Sales team access
  jobTitle: "RAM_AGRI_SALES"  // Part of Ram Agri sales team
}
```
- **Role** determines: Can manage orders, farmers
- **Job Title** determines: Special Ram Agri sales logic applies

---

## ⚠️ Important Notes

1. **Role is Primary for Security**: Always check `role` for authorization
2. **Job Title is Secondary**: Used for organizational/UI purposes
3. **They Can Overlap**: Sometimes role and jobTitle have similar values (e.g., "SALES")
4. **Role is More Restrictive**: Changing role affects permissions
5. **Job Title is More Flexible**: Can be changed without security implications

---

## 🎯 Best Practices

1. **For Authorization**: Always use `role`
   ```javascript
   if (req.user.role === 'SUPER_ADMIN') { ... }
   ```

2. **For Display/Filtering**: Use `jobTitle`
   ```javascript
   const salesTeam = users.filter(u => u.jobTitle === 'RAM_AGRI_SALES');
   ```

3. **For Special Business Logic**: Can use both
   ```javascript
   if (req.user.role === 'SALES' && req.user.jobTitle === 'RAM_AGRI_SALES') {
     // Special Ram Agri sales logic
   }
   ```

---

## 📝 Summary

- **ROLE** = "What can this user do?" (Security & Permissions)
- **JOB TITLE** = "What is this user's position?" (Organization & Display)

Both fields work together to provide a complete picture of a user's identity and capabilities in the system.
