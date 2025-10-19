# 🚀 Quick Migration Guide - Set Sales & Dealer PIN to 1234

## ⚡ TL;DR - Run This

```bash
# 1. Go to backend directory
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE

# 2. (IMPORTANT!) Backup database first
mongodump --db nursery-db --out ./backup-$(date +%Y%m%d)

# 3. Run the migration
node set-sales-dealer-pin-1234.js

# 4. Done! ✅
```

---

## 📋 What This Does

Sets all **SALES** and **DEALER** users' passwords to `1234` and forces them to change it on next login.

---

## 🎯 Expected Result

```
✅ MongoDB connected successfully
🔐 Starting PIN migration...
📊 Found 15 SALES users
📊 Found 8 DEALER users
🎯 Total users to update: 23

✅ Updated: Rajesh Kumar (9876543210)
✅ Updated: Priya Sharma (9876543211)
... (more updates)

📊 MIGRATION SUMMARY
✅ Successfully updated: 23 users
❌ Failed to update: 0 users
📱 Default PIN set to: 1234
✨ Migration completed successfully!
```

---

## ✅ Quick Checklist

Before running:
- [ ] Backend is **NOT** running (stop it first)
- [ ] Database backup created
- [ ] You have MongoDB access

After running:
- [ ] All users updated successfully
- [ ] Test login with PIN `1234`
- [ ] PIN change modal appears
- [ ] Users can set new PIN

---

## 🧪 Quick Test

```bash
# After migration, test on Android app:
# 1. Login as sales user
#    Phone: [any sales user phone]
#    PIN: 1234
# 
# 2. PIN change modal should appear
# 3. Set new PIN: 5678
# 4. Success! Access granted
```

---

## 🆘 If Something Goes Wrong

```bash
# Restore from backup
mongorestore --db nursery-db ./backup-YYYYMMDD/nursery-db
```

---

## 📞 Users Affected

- ✅ All SALES users (role or job title)
- ✅ All DEALER users (role or job title)
- ❌ Super admins (not affected)
- ❌ Other roles (not affected)
- ❌ Disabled users (skipped)

---

**Ready to run? Go ahead! 🚀**

See `MIGRATION_GUIDE_PIN_1234.md` for detailed documentation.

