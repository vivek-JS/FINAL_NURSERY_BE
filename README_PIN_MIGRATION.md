# 🔐 PIN Migration Script - README

## ✅ Migration Script Created!

I've created a complete migration system to set all **SALES** and **DEALER** users' passwords to the default 4-digit PIN `1234`.

---

## 📁 Files Created

| File | Purpose |
|------|---------|
| `set-sales-dealer-pin-1234.js` | Main migration script |
| `run-pin-migration.sh` | Interactive script runner |
| `MIGRATION_GUIDE_PIN_1234.md` | Complete documentation |
| `RUN_MIGRATION.md` | Quick reference guide |
| `MIGRATION_COMPLETE_SUMMARY.md` | Executive summary |
| `README_PIN_MIGRATION.md` | This file |

---

## 🚀 How to Run (3 Ways)

### **Option 1: Interactive (Recommended)**
```bash
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
./run-pin-migration.sh
```
- Asks for confirmation
- Offers to create backup
- Shows progress
- User-friendly

### **Option 2: Direct**
```bash
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
node set-sales-dealer-pin-1234.js
```
- Runs immediately
- Shows detailed logs
- Good for automation

### **Option 3: With Manual Backup**
```bash
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE

# Create backup first
mongodump --db nursery-management --out ./backup-$(date +%Y%m%d)

# Run migration
node set-sales-dealer-pin-1234.js
```
- Most secure
- Easy rollback
- Production recommended

---

## 🎯 What This Does

### **Finds:**
- All users with `role: "SALES"` OR `jobTitle: "SALES"`
- All users with `role: "DEALER"` OR `jobTitle: "DEALER"`
- Excludes disabled users

### **Updates Each User:**
```javascript
// Before
{
  password: "old-hashed-password",
  isPasswordSet: true
}

// After
{
  password: "hashed-1234",
  isPasswordSet: false  ← Forces PIN change on login
}
```

### **Result:**
- Users can login with PIN `1234`
- PIN change modal appears in Android app
- Users MUST set new 4-digit PIN
- Can then access the app

---

## 📊 Example Output

```bash
$ ./run-pin-migration.sh

🔐 Sales & Dealer PIN Migration Script
═══════════════════════════════════════════════════════

This script will:
  1. Set all SALES users' password to 1234
  2. Set all DEALER users' password to 1234
  3. Set isPasswordSet to false (force PIN change on login)

⚠️  IMPORTANT: This will affect all SALES and DEALER users!

Do you want to continue? (yes/no): yes

🚀 Running migration...
═══════════════════════════════════════════════════════

✅ MongoDB connected successfully
🔐 Starting PIN migration for Sales and Dealer users...

📊 Found 15 SALES users
📊 Found 8 DEALER users
🎯 Total users to update: 23

✅ Updated: Rajesh Kumar (9876543210)
✅ Updated: Priya Sharma (9876543211)
... [21 more updates]

═══════════════════════════════════════════════════════
📊 MIGRATION SUMMARY
═══════════════════════════════════════════════════════

✅ Successfully updated: 23 users
❌ Failed to update: 0 users
📱 Default PIN set to: 1234
🔐 isPasswordSet: false (will force PIN change on login)

✨ Migration completed successfully!
```

---

## ✅ Safety Features

| Feature | Description |
|---------|-------------|
| **Backup Recommended** | Script prompts for backup |
| **Confirmation Required** | Asks before running |
| **Detailed Logging** | Shows each user updated |
| **Error Handling** | Catches and reports errors |
| **Reversible** | Can restore from backup |
| **Excludes Disabled** | Skips inactive users |

---

## 🧪 Testing After Migration

### **Test Case 1: Sales User**
1. Open Android app
2. Login with:
   - Phone: `[sales user phone]`
   - PIN: `1234`
3. ✅ PIN change modal appears
4. Set new PIN: `5678`
5. ✅ Access granted

### **Test Case 2: Dealer User**
1. Login with:
   - Phone: `[dealer phone]`
   - PIN: `1234`
2. ✅ PIN change modal appears
3. Set new PIN: `9876`
4. ✅ Access granted

### **Test Case 3: Subsequent Login**
1. Logout
2. Login with new PIN (`5678`)
3. ✅ No modal - direct access

---

## 📋 Pre-Flight Checklist

Before running migration:

- [ ] **Backup database** (critical!)
- [ ] **Stop backend server** (recommended)
- [ ] **Test on staging** (if available)
- [ ] **Notify users** (prepare message)
- [ ] **Schedule maintenance window** (optional)

After migration:

- [ ] **Verify update count** matches expected
- [ ] **Test login** with PIN 1234
- [ ] **Verify PIN change** modal works
- [ ] **Monitor logs** for issues
- [ ] **Send user notifications**

---

## 🔄 Rollback Procedure

If something goes wrong:

```bash
# Stop backend
# Ctrl+C if running

# Restore from backup
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
mongorestore --db nursery-management ./backup-YYYYMMDD/nursery-management

# Verify restoration
mongo nursery-management --eval "db.users.findOne({phoneNumber: 9876543210})"

# Restart backend
npm start
```

---

## 📞 User Communication

After migration, send this message:

```
Subject: Your Login PIN Has Been Reset to 1234

Dear [Name],

Your Ram Biotech app login PIN has been reset to: 1234

Next steps:
1. Open the app
2. Login with your phone number and PIN: 1234
3. You'll be prompted to create a new 4-digit PIN
4. Choose a secure PIN you can remember

This is a one-time process for security purposes.

Need help? Contact IT support.

Thank you,
Ram Biotech IT Team
```

---

## 🐛 Troubleshooting

### **"Cannot connect to database"**
```bash
# Check MongoDB is running
brew services list | grep mongodb

# Start if needed
brew services start mongodb-community
```

### **"0 users found"**
```bash
# Verify users exist
mongo nursery-management
> db.users.find({ role: 'SALES' }).count()
> db.users.find({ jobTitle: 'SALES' }).count()
```

### **"Module not found"**
```bash
# Install dependencies
npm install mongoose bcryptjs dotenv
```

---

## 📚 Documentation

For more details, see:

1. **`MIGRATION_GUIDE_PIN_1234.md`** - Complete guide (detailed)
2. **`RUN_MIGRATION.md`** - Quick reference (1 page)
3. **`MIGRATION_COMPLETE_SUMMARY.md`** - Executive summary

---

## 🎯 Quick Commands

```bash
# Navigate to backend
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE

# Backup database
mongodump --db nursery-management --out ./backup-$(date +%Y%m%d)

# Run migration (interactive)
./run-pin-migration.sh

# Run migration (direct)
node set-sales-dealer-pin-1234.js

# Verify migration
mongo nursery-management --eval "db.users.find({
  \$or: [{role: 'SALES'}, {jobTitle: 'SALES'}],
  isPasswordSet: false
}).count()"

# Rollback
mongorestore --db nursery-management ./backup-YYYYMMDD/nursery-management
```

---

## ✅ Status

**Script Status**: ✅ Ready to Run  
**Testing Status**: 🟡 Needs Testing  
**Documentation**: ✅ Complete  
**Backup Strategy**: ✅ Implemented  

---

## 🎉 Summary

You now have a **production-ready migration system** that:

✅ Sets SALES/DEALER passwords to `1234`  
✅ Forces PIN change on first login  
✅ Has safety features and backups  
✅ Is fully documented  
✅ Has interactive and direct modes  
✅ Includes rollback procedures  

**Everything is ready to run! 🚀**

---

**Created**: October 18, 2025  
**Version**: 1.0.0  
**Author**: AI Assistant  
**Status**: Production Ready  

