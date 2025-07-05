# MongoDB Setup Guide

## Option 1: MongoDB Atlas (Recommended - Easiest)

1. Go to [MongoDB Atlas](https://www.mongodb.com/atlas)
2. Create a free account
3. Create a new cluster (free tier)
4. Create a database user with username and password
5. Get your connection string
6. Update the .env file with your Atlas connection string

## Option 2: Local MongoDB Installation

If you want to install MongoDB locally:

1. Fix Homebrew permissions:
   ```bash
   sudo chown -R VivekP /opt/homebrew
   ```

2. Install MongoDB:
   ```bash
   brew tap mongodb/brew
   brew install mongodb-community
   ```

3. Start MongoDB service:
   ```bash
   brew services start mongodb/brew/mongodb-community
   ```

## Option 3: Docker (Alternative)

If you have Docker installed:
```bash
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

## Current Status
- ✅ .env file created with PORT=8080
- ❌ MongoDB not running
- ❌ Application cannot start due to database connection failure

## Next Steps
Choose one of the options above to get MongoDB running, then run:
```bash
npm start
``` 