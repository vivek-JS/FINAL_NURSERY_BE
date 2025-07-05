# 🚀 Production Deployment Guide for Nursery Management System

## 📋 Overview

This guide provides step-by-step instructions for deploying your Nursery Management System backend to production with enterprise-grade security measures.

## 🎯 Prerequisites

### Server Requirements
- **OS**: Ubuntu 20.04 LTS or later
- **RAM**: Minimum 4GB (8GB recommended)
- **Storage**: Minimum 50GB SSD
- **CPU**: 2 cores minimum (4 cores recommended)
- **Network**: Stable internet connection

### Domain & SSL
- Registered domain name
- DNS access for domain configuration
- SSL certificate (Let's Encrypt recommended)

## 🔧 Step 1: Server Setup

### 1.1 Initial Server Configuration

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y curl wget git nginx certbot python3-certbot-nginx ufw fail2ban

# Install Docker and Docker Compose
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
sudo npm install -g pm2
```

### 1.2 Firewall Configuration

```bash
# Configure UFW firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable

# Verify firewall status
sudo ufw status
```

### 1.3 Create Application User

```bash
# Create dedicated user for the application
sudo adduser nursery
sudo usermod -aG docker nursery
sudo usermod -aG sudo nursery

# Switch to nursery user
sudo su - nursery
```

## 🔐 Step 2: Security Configuration

### 2.1 SSH Security

```bash
# Edit SSH configuration
sudo nano /etc/ssh/sshd_config

# Add/modify these lines:
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers nursery

# Restart SSH service
sudo systemctl restart sshd
```

### 2.2 Fail2ban Configuration

```bash
# Configure fail2ban for SSH protection
sudo nano /etc/fail2ban/jail.local

# Add this configuration:
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
findtime = 600

# Restart fail2ban
sudo systemctl restart fail2ban
```

## 🗄️ Step 3: Database Setup

### 3.1 MongoDB Installation

```bash
# Import MongoDB public key
wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | sudo apt-key add -

# Add MongoDB repository
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list

# Install MongoDB
sudo apt update
sudo apt install -y mongodb-org

# Start and enable MongoDB
sudo systemctl start mongod
sudo systemctl enable mongod
```

### 3.2 MongoDB Security Configuration

```bash
# Create MongoDB admin user
mongosh admin --eval "
db.createUser({
  user: 'admin',
  pwd: 'your_secure_admin_password',
  roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }]
})"

# Create application database and user
mongosh admin -u admin -p your_secure_admin_password --eval "
use nursery_production
db.createUser({
  user: 'nursery_user',
  pwd: 'your_secure_nursery_password',
  roles: [
    { role: 'readWrite', db: 'nursery_production' },
    { role: 'dbAdmin', db: 'nursery_production' }
  ]
})"
```

## 📁 Step 4: Application Deployment

### 4.1 Clone Repository

```bash
# Clone the repository
git clone git@github.com:vivek-JS/FINAL_NURSERY_BE.git
cd FINAL_NURSERY_BE

# Create necessary directories
sudo mkdir -p /var/uploads/nursery-app
sudo mkdir -p /var/log/nursery-app
sudo mkdir -p /var/backups/nursery-app
sudo chown -R nursery:nursery /var/uploads/nursery-app
sudo chown -R nursery:nursery /var/log/nursery-app
sudo chown -R nursery:nursery /var/backups/nursery-app
```

### 4.2 Environment Configuration

```bash
# Copy environment template
cp env.production.example .env.production

# Edit environment file with your values
nano .env.production
```

**Required environment variables:**
```bash
NODE_ENV=production
PORT=8080
MONGO_URL=mongodb://nursery_user:your_secure_nursery_password@localhost:27017/nursery_production?authSource=nursery_production
JWT_SECRET=your_super_secure_jwt_secret_key_here_make_it_long_and_random
REFRESH_TOKEN_SECRET=your_super_secure_refresh_token_secret_key_here
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

### 4.3 Deploy with Docker (Recommended)

```bash
# Make deployment scripts executable
chmod +x deployment/deploy.sh
chmod +x deployment/backup.sh

# Deploy using Docker Compose
docker-compose -f deployment/docker-compose.yml up -d --build

# Check service status
docker-compose -f deployment/docker-compose.yml ps
```

### 4.4 Deploy with PM2 (Alternative)

```bash
# Install dependencies
npm ci --production

# Start application with PM2
pm2 start deployment/pm2.config.js --env production

# Save PM2 configuration
pm2 save
pm2 startup
```

## 🌐 Step 5: Nginx Configuration

### 5.1 Configure Nginx

```bash
# Copy Nginx configuration
sudo cp deployment/nginx.conf /etc/nginx/sites-available/nursery-app

# Edit configuration with your domain
sudo nano /etc/nginx/sites-available/nursery-app

# Enable the site
sudo ln -s /etc/nginx/sites-available/nursery-app /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

### 5.2 SSL Certificate Setup

```bash
# Get SSL certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Set up auto-renewal
sudo crontab -e
# Add this line: 0 12 * * * /usr/bin/certbot renew --quiet
```

## 🔍 Step 6: Verification & Testing

### 6.1 Health Check

```bash
# Test basic health check
curl http://localhost:8080/health

# Test detailed health check
curl http://localhost:8080/health/detailed

# Test through Nginx
curl https://yourdomain.com/health
```

### 6.2 Security Testing

```bash
# Test security headers
curl -I https://yourdomain.com/api/v1/user/login

# Test rate limiting
ab -n 1000 -c 10 https://yourdomain.com/api/v1/user/login

# Test SSL configuration
npx ssl-checker yourdomain.com
```

### 6.3 API Testing

```bash
# Test login endpoint
curl -X POST https://yourdomain.com/api/v1/user/login \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"7588686452","password":"432100"}'
```

## 📊 Step 7: Monitoring Setup

### 7.1 Application Monitoring

```bash
# PM2 monitoring (if using PM2)
pm2 monit

# Docker monitoring (if using Docker)
docker stats

# Set up log monitoring
sudo tail -f /var/log/nursery-app/app.log
```

### 7.2 System Monitoring

```bash
# Install monitoring tools
sudo apt install -y htop iotop nethogs

# Monitor system resources
htop
```

## 🔄 Step 8: Backup Configuration

### 8.1 Automated Backups

```bash
# Test backup script
./deployment/backup.sh backup

# Set up automated backups
sudo crontab -e
# Add this line for daily backups at 2 AM: 0 2 * * * /var/www/nursery-app/deployment/backup.sh backup
```

### 8.2 Backup Verification

```bash
# List available backups
./deployment/backup.sh list

# Verify backup integrity
./deployment/backup.sh verify
```

## 🚨 Step 9: Incident Response

### 9.1 Emergency Procedures

```bash
# Quick rollback
./deployment/deploy.sh rollback

# Emergency restart
pm2 restart all
# or
docker-compose -f deployment/docker-compose.yml restart

# Check logs for issues
pm2 logs
# or
docker-compose -f deployment/docker-compose.yml logs
```

### 9.2 Monitoring Alerts

Set up monitoring for:
- Application downtime
- High memory usage
- Database connection issues
- SSL certificate expiration
- Failed login attempts

## 🔧 Step 10: Maintenance

### 10.1 Regular Updates

```bash
# Weekly system updates
sudo apt update && sudo apt upgrade -y

# Monthly application updates
cd /var/www/nursery-app
git pull origin main
./deployment/deploy.sh deploy

# Quarterly security audits
npm audit --audit-level=moderate
```

### 10.2 Performance Optimization

```bash
# Monitor performance
pm2 monit
# or
docker stats

# Optimize database
mongosh --eval "db.runCommand({compact: 'collection_name'})"

# Clean up old logs
sudo find /var/log/nursery-app -name "*.log" -mtime +30 -delete
```

## 📞 Support & Troubleshooting

### Common Issues

1. **Application won't start**
   - Check environment variables
   - Verify database connection
   - Check logs: `pm2 logs` or `docker-compose logs`

2. **SSL certificate issues**
   - Verify domain DNS settings
   - Check certificate renewal: `sudo certbot certificates`
   - Manual renewal: `sudo certbot renew`

3. **Database connection issues**
   - Verify MongoDB is running: `sudo systemctl status mongod`
   - Check authentication: `mongosh --eval "db.adminCommand('ping')"`
   - Verify connection string in environment file

4. **Performance issues**
   - Monitor resource usage: `htop`, `docker stats`
   - Check database performance: `mongosh --eval "db.currentOp()"`
   - Review application logs for errors

### Emergency Contacts

- **System Administrator**: [Your Contact]
- **Database Administrator**: [Your Contact]
- **Security Team**: [Your Contact]

## ✅ Deployment Checklist

- [ ] Server setup completed
- [ ] Security measures implemented
- [ ] Database configured and secured
- [ ] Application deployed successfully
- [ ] SSL certificate installed
- [ ] Health checks passing
- [ ] Monitoring configured
- [ ] Backups automated
- [ ] Documentation updated
- [ ] Team trained on procedures

## 🎉 Deployment Complete!

Your Nursery Management System is now deployed with enterprise-grade security measures. The system includes:

- ✅ **Security**: SSL/TLS, rate limiting, input validation, security headers
- ✅ **Monitoring**: Health checks, performance monitoring, log management
- ✅ **Backup**: Automated encrypted backups with retention policies
- ✅ **Scalability**: Docker containerization with load balancing support
- ✅ **Maintenance**: Automated updates and rollback procedures

**Next Steps:**
1. Update your frontend applications to use the new production URL
2. Set up monitoring alerts
3. Schedule regular security audits
4. Train your team on the new deployment procedures
5. Document any custom configurations

**Production URL**: `https://yourdomain.com`
**Health Check**: `https://yourdomain.com/health`
**API Documentation**: `https://yourdomain.com/api/v1` 