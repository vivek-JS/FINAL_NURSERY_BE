# Quick Test: Dispatch Manager Password Reset

## Current Status
✅ Feature is fully implemented and ready to use!

⚠️ **Note:** Your database currently has no users. You need to create a Dispatch Manager first.

## Quick Start (3 Steps)

### Step 1: Create a Test Dispatch Manager

Check if there are existing scripts to create a dispatch manager:
```bash
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
ls -la | grep dispatch
```

You should see files like:
- `create-dispatch-manager.js`
- `onboard-dispatch-manager-7588686458.js`
- `update-user-to-dispatch-manager.js`

Run one of these scripts (example):
```bash
node create-dispatch-manager.js
```

### Step 2: Reset All Dispatch Manager Passwords

```bash
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
node reset-dispatch-manager-passwords.js
```

Expected output:
```
===========================================
Reset Dispatch Manager Passwords to 1234
===========================================

Connecting to MongoDB...
✓ Connected to MongoDB successfully

Hashing password...
✓ Password hashed successfully

Finding all dispatch managers...
✓ Found 1 dispatch manager(s)

Dispatch Managers to be updated:
--------------------------------
1. Name: John Doe, Phone: 1234567890, Role: DISPATCH_MANAGER

Updating passwords...
✓ All passwords updated successfully

===========================================
✓ SUCCESS!
===========================================
Updated 1 dispatch manager password(s) to: 1234
Note: Users will be required to change their password on next login
```

### Step 3: Test Login with New Password

```bash
# Test login
curl -X POST http://localhost:8000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": 1234567890,
    "password": "1234"
  }'
```

## Alternative: Using the API Endpoint

If you prefer to use the API instead of the script:

1. **Login as Admin:**
```bash
curl -X POST http://localhost:8000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "YOUR_ADMIN_PHONE",
    "password": "YOUR_ADMIN_PASSWORD"
  }'
```

2. **Copy the accessToken from the response**

3. **Reset Dispatch Manager Passwords:**
```bash
curl -X POST http://localhost:8000/api/user/reset-all-dispatch-manager-passwords \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

## What Happens After Reset?

1. ✅ All Dispatch Manager passwords are set to `1234`
2. ✅ `isPasswordSet` flag is set to `false`
3. ✅ On next login, users will be forced to change their password
4. ✅ Login response will include: `"forcePasswordReset": true`

## Verification

To verify the passwords were reset:

```bash
# Try logging in with the new password (1234)
curl -X POST http://localhost:8000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": DISPATCH_MANAGER_PHONE,
    "password": "1234"
  }'
```

Expected response:
```json
{
  "status": "Success",
  "message": "Login successful - Password reset required",
  "data": {
    "user": { ... },
    "accessToken": "...",
    "isPasswordSet": false,
    "forcePasswordReset": true,
    "message": "Password reset required on first login"
  }
}
```

## Files Created/Modified

### New Files:
- ✅ `reset-dispatch-manager-passwords.js` - Standalone reset script
- ✅ `QUICK_TEST_DISPATCH_MANAGER_PASSWORD_RESET.md` - This file

### Modified Files:
- ✅ `controllers/user.controller.js` - Added reset function
- ✅ `routes/user.route.js` - Added API route

### Documentation:
- ✅ `RESET_DISPATCH_MANAGER_PASSWORDS.md` - Full documentation

## Need Help?

- Check the full documentation: `RESET_DISPATCH_MANAGER_PASSWORDS.md`
- List existing dispatch manager scripts: `ls -la | grep dispatch`
- Check MongoDB connection: Verify `MONGODB_URI` in `.env` file

## Default Settings

| Setting | Value |
|---------|-------|
| Default Password | `1234` |
| Force Password Change | Yes (`isPasswordSet: false`) |
| Allowed Roles | Super Admin, Admin |
| Targets | Users with role or jobTitle = DISPATCH_MANAGER |
| Active Users Only | Yes (isDisabled: false) |

