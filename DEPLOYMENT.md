# Nursery Management System - Deployment Guide

## Overview
This guide covers deploying the Nursery Management System using traditional hosting methods (VPS, dedicated server, or cloud hosting) without AWS dependencies.

## Prerequisites
- Node.js 18.x or higher
- MongoDB 6.0 or higher
- PM2 (for process management)
- Nginx (for reverse proxy)
- Git

## Environment Setup

### 1. Clone the Repository
```bash
git clone <repository-url>
cd FINAL_NURSERY_BE
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration
Create a `.env` file with the following variables:
```env
NODE_ENV=production
PORT=8000
MONGO_URL=mongodb://localhost:27017/nursery
JWT_SECRET=your-secret-key-here
ALLOWED_ORIGINS=http://localhost:3000,http://your-domain.com
```

## Deployment Options

### Option 1: PM2 Deployment (Recommended)
```bash
# Install PM2 globally
npm install -g pm2

# Start the application
pm2 start index.js --name "nursery-backend"

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
```

### Option 2: Docker Deployment
```bash
# Build and run with Docker Compose
docker-compose -f deployment/docker-compose.yml up -d
```

### Option 3: Direct Node.js
```bash
# Start the application directly
npm start
```

## Production Configuration

### Nginx Configuration
Create an Nginx configuration file:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### SSL Configuration (Optional)
```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com
```

## Monitoring and Maintenance

### Health Check
The application includes a health check endpoint:
```
GET /health
```

### Logs
```bash
# PM2 logs
pm2 logs nursery-backend

# Application logs
tail -f logs/app.log
```

### Backup
```bash
# Run backup script
./deployment/backup.sh backup
```

## Security Considerations

1. **Environment Variables**: Never commit sensitive data to version control
2. **Firewall**: Configure firewall to only allow necessary ports
3. **Updates**: Regularly update dependencies and system packages
4. **Monitoring**: Set up monitoring for uptime and performance
5. **Backups**: Regular database and file backups

## Troubleshooting

### Common Issues

1. **Port Already in Use**
   ```bash
   # Check what's using the port
   lsof -i :8000
   
   # Kill the process
   kill -9 <PID>
   ```

2. **MongoDB Connection Issues**
   ```bash
   # Check MongoDB status
   sudo systemctl status mongod
   
   # Restart MongoDB
   sudo systemctl restart mongod
   ```

3. **PM2 Issues**
   ```bash
   # Restart PM2
   pm2 restart nursery-backend
   
   # Reload PM2
   pm2 reload nursery-backend
   ```

## Performance Optimization

1. **Database Indexing**: Ensure proper MongoDB indexes
2. **Caching**: Implement Redis for session storage
3. **Compression**: Enable gzip compression in Nginx
4. **CDN**: Use CDN for static assets

## Support

For deployment issues, check:
1. Application logs
2. System logs
3. Network connectivity
4. Database connectivity
5. Environment configuration 