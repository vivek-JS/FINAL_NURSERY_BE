# MongoDB Production Setup on DigitalOcean with Static IP

This guide will help you set up MongoDB on a DigitalOcean droplet with a static IP for production use.

## Prerequisites

- DigitalOcean droplet with Ubuntu 20.04 or later
- Static IP assigned to your droplet
- SSH access to your droplet
- Root or sudo access

## Step 1: SSH into Your DigitalOcean Droplet

```bash
ssh root@YOUR_STATIC_IP
# or
ssh root@YOUR_DROPLET_IP
```

## Step 2: Update System Packages

```bash
sudo apt update
sudo apt upgrade -y
```

## Step 3: Install MongoDB

### 3.1 Import MongoDB Public GPG Key

```bash
wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | sudo apt-key add -
```

### 3.2 Add MongoDB Repository

For Ubuntu 20.04 (Focal):
```bash
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
```

For Ubuntu 22.04 (Jammy):
```bash
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
```

### 3.3 Install MongoDB

```bash
sudo apt update
sudo apt install -y mongodb-org
```

### 3.4 Start and Enable MongoDB

```bash
sudo systemctl start mongod
sudo systemctl enable mongod
```

### 3.5 Verify MongoDB is Running

```bash
sudo systemctl status mongod
```

## Step 4: Configure MongoDB for Remote Access

### 4.1 Edit MongoDB Configuration

```bash
sudo nano /etc/mongod.conf
```

### 4.2 Update Network Interface Binding

Find the `net` section and update it to bind to all interfaces (or your specific static IP):

```yaml
net:
  port: 27017
  bindIp: 0.0.0.0  # Listen on all interfaces (or use YOUR_STATIC_IP for specific binding)
```

**Security Note:** For better security, you can bind to your specific static IP instead of `0.0.0.0`:
```yaml
net:
  port: 27017
  bindIp: YOUR_STATIC_IP,127.0.0.1
```

### 4.3 Enable Authentication

In the same file, find and update the `security` section:

```yaml
security:
  authorization: enabled
```

### 4.4 Restart MongoDB

```bash
sudo systemctl restart mongod
sudo systemctl status mongod
```

## Step 5: Configure Firewall (UFW)

### 5.1 Allow MongoDB Port (Only from Trusted IPs)

**Option A: Allow from specific IPs (Recommended)**
```bash
# Replace YOUR_APP_SERVER_IP with the IP of your application server
sudo ufw allow from YOUR_APP_SERVER_IP to any port 27017
```

**Option B: Allow from any IP (Less Secure - Only for Testing)**
```bash
sudo ufw allow 27017/tcp
```

**Option C: Allow SSH first (Important!)**
```bash
sudo ufw allow 22/tcp
sudo ufw enable
sudo ufw status
```

## Step 6: Create MongoDB Admin User

### 6.1 Connect to MongoDB Shell

```bash
mongosh
```

### 6.2 Create Admin User

```javascript
use admin
db.createUser({
  user: "admin",
  pwd: "YOUR_SECURE_ADMIN_PASSWORD",
  roles: [
    { role: "userAdminAnyDatabase", db: "admin" },
    { role: "readWriteAnyDatabase", db: "admin" },
    { role: "dbAdminAnyDatabase", db: "admin" },
    { role: "clusterAdmin", db: "admin" }
  ]
})
```

### 6.3 Create Application Database and User

```javascript
use nursery_production
db.createUser({
  user: "nursery_user",
  pwd: "YOUR_SECURE_NURSERY_PASSWORD",
  roles: [
    { role: "readWrite", db: "nursery_production" },
    { role: "dbAdmin", db: "nursery_production" }
  ]
})
```

### 6.4 Exit MongoDB Shell

```javascript
exit
```

### 6.5 Test Authentication

```bash
mongosh -u admin -p YOUR_SECURE_ADMIN_PASSWORD --authenticationDatabase admin
```

## Step 7: Update Your Application Configuration

### 7.1 Create Production Environment File

On your local machine, create or update `.env.production`:

```bash
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
cp env.production.example .env.production
```

### 7.2 Update Database Connection String

Edit `.env.production` and update the `MONGO_URL`:

```env
# Database Configuration
# Replace YOUR_STATIC_IP with your DigitalOcean static IP
# Replace YOUR_SECURE_NURSERY_PASSWORD with the password you set
MONGO_URL=mongodb://nursery_user:YOUR_SECURE_NURSERY_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=nursery_production

# Or if using admin user (less recommended for production):
# MONGO_URL=mongodb://admin:YOUR_SECURE_ADMIN_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=admin
```

**Connection String Format:**
```
mongodb://[username]:[password]@[static-ip]:27017/[database-name]?authSource=[auth-database]
```

**Example:**
```
mongodb://nursery_user:MySecurePass123!@159.203.123.45:27017/nursery_production?authSource=nursery_production
```

### 7.3 Complete Production Environment Configuration

Update the rest of your `.env.production` file:

```env
NODE_ENV=production
PORT=8080

# Database Configuration
MONGO_URL=mongodb://nursery_user:YOUR_SECURE_NURSERY_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=nursery_production
MONGO_USER=nursery_user
MONGO_PASS=YOUR_SECURE_NURSERY_PASSWORD
MONGO_AUTH_SOURCE=nursery_production

# JWT Configuration
JWT_SECRET=your_super_secure_jwt_secret_key_here_make_it_long_and_random
REFRESH_TOKEN_SECRET=your_super_secure_refresh_token_secret_key_here
ACCESS_TOKEN_EXPIRY=1d
REFRESH_TOKEN_EXPIRY=7d

# Security Configuration
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
SESSION_SECRET=your_session_secret_key_here
```

## Step 8: Test Connection from Your Local Machine

### 8.1 Test Connection Script

You can use the existing test script:

```bash
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
MONGO_URL="mongodb://nursery_user:YOUR_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=nursery_production" node test-mongo-connection.js
```

Or update your `.env` file temporarily and run:

```bash
# Temporarily update .env for testing
node test-mongo-connection.js
```

## Step 9: Additional Security Hardening (Recommended)

### 9.1 Configure MongoDB to Require TLS/SSL (Optional but Recommended)

For production, consider setting up TLS/SSL encryption. This requires SSL certificates.

### 9.2 Set Up IP Whitelist in MongoDB (Additional Layer)

You can configure MongoDB to only accept connections from specific IPs by modifying the firewall rules (Step 5) instead of binding to all interfaces.

### 9.3 Regular Backups

Set up automated backups:

```bash
# Create backup script
sudo nano /usr/local/bin/mongodb-backup.sh
```

Add this content:

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/mongodb"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

mongodump --host localhost --port 27017 \
  --username admin \
  --password YOUR_ADMIN_PASSWORD \
  --authenticationDatabase admin \
  --db nursery_production \
  --out $BACKUP_DIR/backup_$DATE

# Keep only last 7 days of backups
find $BACKUP_DIR -type d -mtime +7 -exec rm -rf {} \;
```

Make it executable:
```bash
sudo chmod +x /usr/local/bin/mongodb-backup.sh
```

Add to crontab for daily backups at 2 AM:
```bash
sudo crontab -e
# Add this line:
0 2 * * * /usr/local/bin/mongodb-backup.sh
```

## Step 10: Monitoring and Maintenance

### 10.1 Check MongoDB Status

```bash
sudo systemctl status mongod
```

### 10.2 View MongoDB Logs

```bash
sudo tail -f /var/log/mongodb/mongod.log
```

### 10.3 Connect to MongoDB Remotely (for management)

```bash
mongosh "mongodb://admin:YOUR_ADMIN_PASSWORD@YOUR_STATIC_IP:27017/admin?authSource=admin"
```

## Troubleshooting

### Connection Refused

1. **Check if MongoDB is running:**
   ```bash
   sudo systemctl status mongod
   ```

2. **Check if MongoDB is listening on the correct interface:**
   ```bash
   sudo netstat -tlnp | grep 27017
   ```

3. **Check firewall rules:**
   ```bash
   sudo ufw status
   ```

4. **Check MongoDB bind IP configuration:**
   ```bash
   sudo cat /etc/mongod.conf | grep bindIp
   ```

### Authentication Failed

1. **Verify username and password:**
   ```bash
   mongosh -u nursery_user -p YOUR_PASSWORD --authenticationDatabase nursery_production
   ```

2. **Check if authentication is enabled:**
   ```bash
   sudo cat /etc/mongod.conf | grep authorization
   ```

### Connection Timeout

1. **Check if your application server's IP is whitelisted in the firewall:**
   ```bash
   sudo ufw status
   ```

2. **Test connection from your application server:**
   ```bash
   telnet YOUR_STATIC_IP 27017
   # or
   nc -zv YOUR_STATIC_IP 27017
   ```

## Quick Reference: Connection Strings

### From Application Server

```env
MONGO_URL=mongodb://nursery_user:YOUR_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=nursery_production
```

### From Local Machine (for testing)

```bash
mongosh "mongodb://nursery_user:YOUR_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=nursery_production"
```

### With Connection Options (Recommended)

```env
MONGO_URL=mongodb://nursery_user:YOUR_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=nursery_production&retryWrites=true&w=majority&serverSelectionTimeoutMS=5000&socketTimeoutMS=45000
```

## Security Checklist

- [ ] MongoDB authentication enabled
- [ ] Strong passwords set for all users
- [ ] Firewall configured to only allow connections from trusted IPs
- [ ] MongoDB bound to specific IP (not 0.0.0.0) if possible
- [ ] Regular backups configured
- [ ] MongoDB logs being monitored
- [ ] System updates applied
- [ ] SSH key-based authentication enabled (not password)
- [ ] Fail2ban configured for SSH protection

## Next Steps

1. Update your application's environment variables with the new connection string
2. Test the connection from your application server
3. Set up monitoring and alerting
4. Configure automated backups
5. Document your MongoDB credentials securely
6. Consider setting up MongoDB replica set for high availability (production best practice)




