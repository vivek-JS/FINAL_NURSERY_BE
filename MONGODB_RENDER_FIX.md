# MongoDB Connection Fix for Render Deployment

## Problem
You're getting this error on Render:
```
ERROR 💥 {
  statusCode: 500,
  status: 'error',
  message: 'Operation `users.findOne()` buffering timed out after 10000ms'
}
```

## Root Cause
The MongoDB connection is timing out because:
1. Using `localhost` in MongoDB URL (won't work on cloud)
2. MongoDB Atlas IP whitelist doesn't include Render's IP
3. Incorrect connection string format

## Solutions

### Solution 1: Use MongoDB Atlas (Recommended)

#### Step 1: Create MongoDB Atlas Cluster
1. Go to [MongoDB Atlas](https://cloud.mongodb.com/)
2. Create a free account/cluster
3. Get your connection string

#### Step 2: Update Render Environment Variables
In your Render dashboard:
1. Go to your service → Environment
2. Add/update these variables:

```
MONGO_URL=mongodb+srv://username:password@cluster.mongodb.net/nursery_production?retryWrites=true&w=majority
NODE_ENV=production
PORT=10000
JWT_SECRET=your_super_secure_jwt_secret_key_here
```

#### Step 3: Whitelist Render's IP in MongoDB Atlas
1. In MongoDB Atlas → Network Access
2. Add IP: `0.0.0.0/0` (for testing)
3. Or get Render's specific IP range

### Solution 2: Test Connection Locally

Run this command to test your MongoDB connection:
```bash
node test-mongo-connection.js
```

### Solution 3: Use MongoDB Atlas Connection String Format

Your connection string should look like:
```
mongodb+srv://username:password@cluster.mongodb.net/database_name?retryWrites=true&w=majority
```

NOT:
```
mongodb://localhost:27017/database_name
```

## Environment Variables for Render

Make sure these are set in your Render environment:

```env
NODE_ENV=production
PORT=10000
MONGO_URL=mongodb+srv://your_username:your_password@your_cluster.mongodb.net/nursery_production?retryWrites=true&w=majority
JWT_SECRET=your_super_secure_jwt_secret_key_here
REFRESH_TOKEN_SECRET=your_super_secure_refresh_token_secret_key_here
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d
```

## Common Issues and Fixes

### Issue 1: Authentication Failed
- Check username/password in connection string
- Ensure user has proper permissions in MongoDB Atlas

### Issue 2: Network Timeout
- Add `0.0.0.0/0` to MongoDB Atlas IP whitelist
- Check if connection string is correct

### Issue 3: Database Not Found
- Ensure database name is correct in connection string
- Create database if it doesn't exist

## Testing

After making changes:
1. Redeploy your service on Render
2. Check the logs for connection success
3. Test your API endpoints

## Alternative: Use MongoDB Atlas Free Tier

If you don't have MongoDB Atlas:
1. Sign up at [MongoDB Atlas](https://cloud.mongodb.com/)
2. Create a free cluster (M0)
3. Get your connection string
4. Update Render environment variables
5. Whitelist IP addresses

This will give you a reliable cloud MongoDB database that works perfectly with Render. 