# DigitalOcean MongoDB Quick Reference

## Quick Setup Checklist

- [ ] Install MongoDB on DigitalOcean droplet
- [ ] Configure MongoDB to bind to static IP
- [ ] Enable authentication
- [ ] Create admin and application users
- [ ] Configure firewall (UFW)
- [ ] Test connection locally
- [ ] Update application .env file
- [ ] Test connection from application

## Connection String Format

```
mongodb://[username]:[password]@[STATIC_IP]:27017/[database]?authSource=[auth-database]
```

### Example:
```
mongodb://nursery_user:MySecurePass123!@159.203.123.45:27017/nursery_production?authSource=nursery_production
```

## Essential Commands

### On DigitalOcean Server

```bash
# Start MongoDB
sudo systemctl start mongod

# Stop MongoDB
sudo systemctl stop mongod

# Restart MongoDB
sudo systemctl restart mongod

# Check MongoDB status
sudo systemctl status mongod

# View MongoDB logs
sudo tail -f /var/log/mongodb/mongod.log

# Connect to MongoDB shell (local)
mongosh

# Connect with authentication
mongosh -u nursery_user -p YOUR_PASSWORD --authenticationDatabase nursery_production

# Check if MongoDB is listening
sudo netstat -tlnp | grep 27017
```

### Firewall Management

```bash
# Check firewall status
sudo ufw status

# Allow MongoDB from specific IP
sudo ufw allow from YOUR_APP_SERVER_IP to any port 27017

# Allow MongoDB from any IP (less secure)
sudo ufw allow 27017/tcp

# Enable firewall
sudo ufw enable
```

### MongoDB Configuration File

Location: `/etc/mongod.conf`

Key settings:
```yaml
net:
  port: 27017
  bindIp: 0.0.0.0  # or YOUR_STATIC_IP for better security

security:
  authorization: enabled
```

### Create Users (MongoDB Shell)

```javascript
// Admin user
use admin
db.createUser({
  user: "admin",
  pwd: "SECURE_PASSWORD",
  roles: [
    { role: "userAdminAnyDatabase", db: "admin" },
    { role: "readWriteAnyDatabase", db: "admin" }
  ]
})

// Application user
use nursery_production
db.createUser({
  user: "nursery_user",
  pwd: "SECURE_PASSWORD",
  roles: [
    { role: "readWrite", db: "nursery_production" },
    { role: "dbAdmin", db: "nursery_production" }
  ]
})
```

## Testing Connection

### From Local Machine

```bash
# Using test script
cd /Users/VivekP/Movies/ram/FINAL_NURSERY_BE
MONGO_URL="mongodb://nursery_user:PASSWORD@STATIC_IP:27017/nursery_production?authSource=nursery_production" node test-mongodb-digitalocean.js

# Using mongosh
mongosh "mongodb://nursery_user:PASSWORD@STATIC_IP:27017/nursery_production?authSource=nursery_production"

# Test port connectivity
telnet STATIC_IP 27017
# or
nc -zv STATIC_IP 27017
```

### From Application Server

Update `.env.production`:
```env
MONGO_URL=mongodb://nursery_user:PASSWORD@STATIC_IP:27017/nursery_production?authSource=nursery_production
```

Then test:
```bash
node test-mongodb-digitalocean.js
```

## Environment Variables

```env
NODE_ENV=production
PORT=8080
MONGO_URL=mongodb://nursery_user:PASSWORD@STATIC_IP:27017/nursery_production?authSource=nursery_production
MONGO_USER=nursery_user
MONGO_PASS=PASSWORD
MONGO_AUTH_SOURCE=nursery_production
JWT_SECRET=your_jwt_secret
REFRESH_TOKEN_SECRET=your_refresh_secret
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Connection refused | Check MongoDB service: `sudo systemctl status mongod` |
| Connection timeout | Check firewall: `sudo ufw status` |
| Authentication failed | Verify username/password and authSource |
| Port not accessible | Allow port in firewall: `sudo ufw allow 27017/tcp` |
| Can't bind to IP | Check `/etc/mongod.conf` bindIp setting |

## Security Best Practices

1. ✅ Use strong, unique passwords
2. ✅ Bind MongoDB to specific IP (not 0.0.0.0) when possible
3. ✅ Configure firewall to allow only trusted IPs
4. ✅ Enable MongoDB authentication
5. ✅ Use separate users for different applications
6. ✅ Regularly update MongoDB and system packages
7. ✅ Set up automated backups
8. ✅ Monitor MongoDB logs
9. ✅ Use SSL/TLS for production (optional but recommended)

## Backup Command

```bash
# Manual backup
mongodump --host localhost --port 27017 \
  --username admin \
  --password ADMIN_PASSWORD \
  --authenticationDatabase admin \
  --db nursery_production \
  --out /var/backups/mongodb/backup_$(date +%Y%m%d_%H%M%S)

# Restore backup
mongorestore --host localhost --port 27017 \
  --username admin \
  --password ADMIN_PASSWORD \
  --authenticationDatabase admin \
  --db nursery_production \
  /var/backups/mongodb/backup_TIMESTAMP/nursery_production
```





