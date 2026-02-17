#!/bin/bash

# MongoDB Setup Script for DigitalOcean
# This script helps automate MongoDB installation and configuration
# Usage: sudo bash setup-mongodb-digitalocean.sh

set -e  # Exit on error

echo "=========================================="
echo "MongoDB Setup for DigitalOcean"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root or with sudo${NC}"
    exit 1
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VER=$VERSION_ID
else
    echo -e "${RED}Cannot detect OS. This script supports Ubuntu 20.04 and 22.04${NC}"
    exit 1
fi

echo -e "${GREEN}Detected OS: $OS $VER${NC}"
echo ""

# Check if MongoDB is already installed
if command -v mongod &> /dev/null; then
    echo -e "${YELLOW}MongoDB is already installed${NC}"
    read -p "Do you want to reconfigure it? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

# Step 1: Update system
echo -e "${GREEN}Step 1: Updating system packages...${NC}"
apt update
apt upgrade -y

# Step 2: Install MongoDB
if ! command -v mongod &> /dev/null; then
    echo -e "${GREEN}Step 2: Installing MongoDB...${NC}"
    
    # Install dependencies
    apt install -y wget curl gnupg2 software-properties-common apt-transport-https ca-certificates lsb-release
    
    # Import MongoDB GPG key
    wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | apt-key add -
    
    # Add MongoDB repository based on Ubuntu version
    if [ "$VER" == "20.04" ]; then
        echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
    elif [ "$VER" == "22.04" ]; then
        echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
    else
        echo -e "${YELLOW}Warning: Unsupported Ubuntu version. Using focal (20.04) repository.${NC}"
        echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
    fi
    
    # Install MongoDB
    apt update
    apt install -y mongodb-org
    
    # Prevent MongoDB from auto-updating
    echo "mongodb-org hold" | dpkg --set-selections
    echo "mongodb-org-database hold" | dpkg --set-selections
    echo "mongodb-org-server hold" | dpkg --set-selections
    echo "mongodb-mongosh hold" | dpkg --set-selections
    echo "mongodb-org-mongos hold" | dpkg --set-selections
    echo "mongodb-org-tools hold" | dpkg --set-selections
    
    echo -e "${GREEN}MongoDB installed successfully!${NC}"
else
    echo -e "${GREEN}MongoDB is already installed, skipping installation...${NC}"
fi

# Step 3: Configure MongoDB
echo ""
echo -e "${GREEN}Step 3: Configuring MongoDB...${NC}"

# Get static IP (try to detect it)
STATIC_IP=$(hostname -I | awk '{print $1}')
echo -e "${YELLOW}Detected IP: $STATIC_IP${NC}"
read -p "Enter your static IP (or press Enter to use detected IP): " USER_IP
if [ ! -z "$USER_IP" ]; then
    STATIC_IP=$USER_IP
fi

# Backup original config
if [ ! -f /etc/mongod.conf.backup ]; then
    cp /etc/mongod.conf /etc/mongod.conf.backup
    echo -e "${GREEN}Original config backed up to /etc/mongod.conf.backup${NC}"
fi

# Configure MongoDB to bind to all interfaces
sed -i 's/bindIp: 127.0.0.1/bindIp: 0.0.0.0/' /etc/mongod.conf

# Enable authentication
if ! grep -q "authorization: enabled" /etc/mongod.conf; then
    # Check if security section exists
    if grep -q "^security:" /etc/mongod.conf; then
        sed -i '/^security:/a\  authorization: enabled' /etc/mongod.conf
    else
        echo "" >> /etc/mongod.conf
        echo "security:" >> /etc/mongod.conf
        echo "  authorization: enabled" >> /etc/mongod.conf
    fi
    echo -e "${GREEN}Authentication enabled${NC}"
fi

# Step 4: Start MongoDB
echo ""
echo -e "${GREEN}Step 4: Starting MongoDB service...${NC}"
systemctl daemon-reload
systemctl start mongod
systemctl enable mongod

# Wait for MongoDB to start
sleep 3

if systemctl is-active --quiet mongod; then
    echo -e "${GREEN}MongoDB is running!${NC}"
else
    echo -e "${RED}MongoDB failed to start. Check logs: sudo tail -f /var/log/mongodb/mongod.log${NC}"
    exit 1
fi

# Step 5: Create users
echo ""
echo -e "${GREEN}Step 5: Setting up MongoDB users...${NC}"
echo -e "${YELLOW}You will be prompted to create admin and application users.${NC}"
echo ""

# Prompt for admin password
read -sp "Enter password for MongoDB admin user: " ADMIN_PASS
echo ""
read -sp "Confirm admin password: " ADMIN_PASS_CONFIRM
echo ""

if [ "$ADMIN_PASS" != "$ADMIN_PASS_CONFIRM" ]; then
    echo -e "${RED}Passwords do not match!${NC}"
    exit 1
fi

# Prompt for application user password
read -sp "Enter password for nursery_user (application user): " NURSERY_PASS
echo ""
read -sp "Confirm nursery_user password: " NURSERY_PASS_CONFIRM
echo ""

if [ "$NURSERY_PASS" != "$NURSERY_PASS_CONFIRM" ]; then
    echo -e "${RED}Passwords do not match!${NC}"
    exit 1
fi

# Create admin user
echo ""
echo -e "${GREEN}Creating admin user...${NC}"
mongosh admin --eval "
db.createUser({
  user: 'admin',
  pwd: '$ADMIN_PASS',
  roles: [
    { role: 'userAdminAnyDatabase', db: 'admin' },
    { role: 'readWriteAnyDatabase', db: 'admin' },
    { role: 'dbAdminAnyDatabase', db: 'admin' },
    { role: 'clusterAdmin', db: 'admin' }
  ]
})" --quiet

# Restart MongoDB to enable authentication
systemctl restart mongod
sleep 3

# Create application database and user
echo -e "${GREEN}Creating application database and user...${NC}"
mongosh admin -u admin -p "$ADMIN_PASS" --authenticationDatabase admin --eval "
use nursery_production
db.createUser({
  user: 'nursery_user',
  pwd: '$NURSERY_PASS',
  roles: [
    { role: 'readWrite', db: 'nursery_production' },
    { role: 'dbAdmin', db: 'nursery_production' }
  ]
})" --quiet

# Step 6: Configure firewall
echo ""
echo -e "${GREEN}Step 6: Configuring firewall...${NC}"

if command -v ufw &> /dev/null; then
    # Check if UFW is enabled
    if ufw status | grep -q "Status: active"; then
        echo -e "${YELLOW}UFW is already active${NC}"
    else
        echo -e "${YELLOW}Enabling UFW...${NC}"
        ufw --force enable
    fi
    
    # Ensure SSH is allowed
    ufw allow 22/tcp
    
    # Ask about MongoDB access
    echo ""
    read -p "Allow MongoDB (port 27017) from specific IP? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -p "Enter the IP address to allow: " ALLOWED_IP
        ufw allow from $ALLOWED_IP to any port 27017
        echo -e "${GREEN}MongoDB access allowed from $ALLOWED_IP${NC}"
    else
        read -p "Allow MongoDB from any IP? (y/n - not recommended) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            ufw allow 27017/tcp
            echo -e "${YELLOW}MongoDB access allowed from any IP (less secure)${NC}"
        fi
    fi
    
    ufw status
else
    echo -e "${YELLOW}UFW is not installed. Consider installing it for better security.${NC}"
fi

# Step 7: Test connection
echo ""
echo -e "${GREEN}Step 7: Testing MongoDB connection...${NC}"
if mongosh admin -u admin -p "$ADMIN_PASS" --authenticationDatabase admin --eval "db.adminCommand('ping')" --quiet > /dev/null 2>&1; then
    echo -e "${GREEN}✅ MongoDB connection test successful!${NC}"
else
    echo -e "${RED}❌ MongoDB connection test failed${NC}"
    exit 1
fi

# Step 8: Display connection information
echo ""
echo "=========================================="
echo -e "${GREEN}Setup Complete!${NC}"
echo "=========================================="
echo ""
echo -e "${YELLOW}MongoDB Connection Information:${NC}"
echo "  Static IP: $STATIC_IP"
echo "  Port: 27017"
echo "  Database: nursery_production"
echo ""
echo -e "${YELLOW}Connection String (save this securely):${NC}"
echo "mongodb://nursery_user:****@$STATIC_IP:27017/nursery_production?authSource=nursery_production"
echo ""
echo -e "${YELLOW}Full connection string for .env file:${NC}"
echo "MONGO_URL=mongodb://nursery_user:$NURSERY_PASS@$STATIC_IP:27017/nursery_production?authSource=nursery_production"
echo ""
echo -e "${YELLOW}Credentials (save securely):${NC}"
echo "  Admin User: admin"
echo "  Admin Password: [saved above]"
echo "  App User: nursery_user"
echo "  App Password: [saved above]"
echo ""
echo -e "${GREEN}Next Steps:${NC}"
echo "  1. Save the connection string and passwords securely"
echo "  2. Update your application .env file with MONGO_URL"
echo "  3. Test connection from your application server"
echo "  4. Set up automated backups"
echo ""
echo -e "${YELLOW}Useful Commands:${NC}"
echo "  Check status: sudo systemctl status mongod"
echo "  View logs: sudo tail -f /var/log/mongodb/mongod.log"
echo "  Connect: mongosh -u nursery_user -p [password] --authenticationDatabase nursery_production"
echo ""
echo "=========================================="





