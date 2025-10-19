# 🔐 Sales & Dealer PIN Migration Guide

## Purpose

This migration script sets all SALES and DEALER users' passwords to the default 4-digit PIN `1234` and forces them to change it on their next login.

---

## 🎯 What This Script Does

1. **Finds all SALES users:**
   - Users with `role: "SALES"`
   - Users with `jobTitle: "SALES"`

2. **Finds all DEALER users:**
   - Users with `role: "DEALER"`
   - Users with `jobTitle: "DEALER"`

3. **For each user:**
   - Sets password to hashed version of `"1234"`
   - Sets `isPasswordSet` to `false`
   - Forces PIN change on next login

4. **Excludes:**
   - Disabled users (`isDisabled: true`)
   - Super admins (not targeted by query)

---

## 🚀 How to Run

### **Step 1: Navigate to Backend Directory**
```bash
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
```

### **Step 2: Make Sure .env is Configured**
Ensure your `.env` file has the MongoDB connection string:
```env
MONGO_URI=mongodb://localhost:27017/your-database-name
```

### **Step 3: Run the Migration Script**
```bash
node set-sales-dealer-pin-1234.js
```

---

## 📊 Example Output

```
✅ MongoDB connected successfully
🔐 Starting PIN migration for Sales and Dealer users...

🔒 Default PIN hashed successfully

📊 Found 15 SALES users

📊 Found 8 DEALER users

🎯 Total users to update: 23

📋 Users to be updated:
═══════════════════════════════════════════════════════

1. Name: Rajesh Kumar
   Phone: 9876543210
   Role: SALES
   Job Title: SALES
   Current isPasswordSet: true

2. Name: Priya Sharma
   Phone: 9876543211
   Role: SALES
   Job Title: SALES
   Current isPasswordSet: false

... (more users)

═══════════════════════════════════════════════════════

⚠️  This will:
   1. Set password to "1234" (hashed)
   2. Set isPasswordSet to false
   3. Force users to change PIN on next login

✅ Updated: Rajesh Kumar (9876543210)
✅ Updated: Priya Sharma (9876543211)
... (more updates)

═══════════════════════════════════════════════════════
📊 MIGRATION SUMMARY
═══════════════════════════════════════════════════════

✅ Successfully updated: 23 users
❌ Failed to update: 0 users
📱 Default PIN set to: 1234
🔐 isPasswordSet: false (will force PIN change on login)

✨ Migration completed successfully!

✅ All done! Closing database connection...
👋 Database connection closed. Goodbye!
```

---

## 🔍 What Happens After Migration

### **For Each User:**

1. **Current Password**: Replaced with hashed `"1234"`
2. **isPasswordSet**: Set to `false`
3. **Next Login:**
   - User enters phone number and `1234`
   - Login succeeds
   - PIN change modal appears in Android app
   - User MUST set a new 4-digit PIN
   - Can then access the app

---

## 🧪 Testing the Migration

### **Test Case 1: Sales User Login**
```
1. Run migration script
2. Open Android app
3. Login as sales user:
   - Phone: 9876543210
   - PIN: 1234
4. PIN change modal appears ✅
5. Set new PIN: 5678
6. Access granted ✅
```

### **Test Case 2: Dealer User Login**
```
1. Login as dealer:
   - Phone: 9876543211
   - PIN: 1234
2. PIN change modal appears ✅
3. Set new PIN: 9876
4. Access granted ✅
```

### **Test Case 3: Subsequent Login**
```
1. Logout
2. Login with new PIN (5678)
3. No PIN modal - direct access ✅
```

---

## 📋 Pre-Migration Checklist

- [ ] **Backup Database** (IMPORTANT!)
  ```bash
  mongodump --db your-database-name --out ./backup-$(date +%Y%m%d)
  ```

- [ ] **Check .env Configuration**
  ```bash
  cat .env | grep MONGO_URI
  ```

- [ ] **Test on Staging First** (if available)

- [ ] **Inform Users** about PIN reset
  - Send notification/email
  - Explain they'll need to change PIN on next login

- [ ] **Verify Backend is NOT Running**
  ```bash
  lsof -ti:8000
  # Should return nothing or stop the server
  ```

---

## 🔄 Rollback (If Needed)

If something goes wrong, restore from backup:

```bash
# Restore from backup
mongorestore --db your-database-name ./backup-YYYYMMDD/your-database-name

# Or manually update specific users
mongo
> use your-database-name
> db.users.updateOne(
    { phoneNumber: 9876543210 },
    { 
      $set: { 
        password: "original-hashed-password",
        isPasswordSet: true 
      } 
    }
  )
```

---

## 📊 Query to Check Migration Status

### **Before Migration:**
```javascript
// In MongoDB shell or Compass
db.users.find({
  $or: [
    { role: 'SALES' },
    { jobTitle: 'SALES' },
    { role: 'DEALER' },
    { jobTitle: 'DEALER' }
  ]
}, {
  name: 1,
  phoneNumber: 1,
  role: 1,
  jobTitle: 1,
  isPasswordSet: 1
}).pretty()
```

### **After Migration:**
```javascript
// Check all users have isPasswordSet: false
db.users.find({
  $or: [
    { role: 'SALES' },
    { jobTitle: 'SALES' },
    { role: 'DEALER' },
    { jobTitle: 'DEALER' }
  ],
  isPasswordSet: false
}).count()

// Should match total SALES + DEALER users
```

---

## 🔐 Security Considerations

### **Why This is Safe:**
1. ✅ Default PIN (`1234`) is only temporary
2. ✅ Users MUST change it on first login
3. ✅ `isPasswordSet: false` forces PIN change
4. ✅ PIN is properly hashed (bcrypt with salt)
5. ✅ Disabled users are excluded

### **Best Practices:**
- 🔒 Run migration during off-hours
- 🔒 Notify users in advance
- 🔒 Monitor login attempts after migration
- 🔒 Keep backup for 30 days

---

## 🎯 Users Affected

This migration affects:

### **SALES Users:**
- Sales persons
- Sales managers
- Field sales staff

### **DEALER Users:**
- Registered dealers
- Dealer accounts

### **NOT Affected:**
- Super admins (excluded from query)
- Office staff
- Accountants
- Other roles
- Disabled users

---

## 📞 Communication Template

Send this to affected users:

```
Subject: Important: Your PIN Will Be Reset

Dear [User Name],

Your login PIN will be reset to a default value (1234) as part 
of our security update.

What you need to do:
1. Login with phone number and PIN: 1234
2. You'll be prompted to set a new 4-digit PIN
3. Choose a secure PIN you can remember

When: [Date and Time]

If you have any questions, please contact IT support.

Thank you,
IT Team
```

---

## 🐛 Troubleshooting

### **Error: Cannot connect to database**
```bash
# Check MongoDB is running
brew services list | grep mongodb
# or
sudo systemctl status mongod

# Start if needed
brew services start mongodb-community
# or
sudo systemctl start mongod
```

### **Error: User model not found**
```bash
# Ensure you're in the correct directory
pwd
# Should be: /Users/VivekP/Movies/ram/FINAL_NURSERY_BE

# Check file exists
ls -la models/user.model.js
```

### **Error: MONGO_URI not defined**
```bash
# Check .env file
cat .env | grep MONGO_URI

# Add if missing
echo 'MONGO_URI=mongodb://localhost:27017/nursery-db' >> .env
```

---

## ✅ Success Criteria

Migration is successful when:

- [x] Script completes without errors
- [x] All SALES users have PIN = `1234` (hashed)
- [x] All DEALER users have PIN = `1234` (hashed)
- [x] All affected users have `isPasswordSet: false`
- [x] Users can login with `1234`
- [x] PIN change modal appears on login
- [x] Users can set new PIN successfully

---

## 📚 Related Files

- `set-sales-dealer-pin-1234.js` - Migration script
- `models/user.model.js` - User schema
- `controllers/user.controller.js` - Login logic
- `android-app/src/components/PinChangeModal.js` - PIN change UI

---

## 🎉 After Migration

Once migration is complete:

1. ✅ Test login with a sales user
2. ✅ Test login with a dealer user
3. ✅ Verify PIN change modal works
4. ✅ Verify new PIN is saved
5. ✅ Monitor for any issues
6. ✅ Document completion date

---

**Migration Status**: Ready to Run
**Estimated Time**: < 5 minutes
**Risk Level**: Low (reversible with backup)
**Last Updated**: October 18, 2025

