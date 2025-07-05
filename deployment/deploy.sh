#!/bin/bash

# Production Deployment Script for Nursery Management System
# This script automates the deployment process with security checks

set -e

# Configuration
APP_NAME="nursery-backend"
DEPLOY_USER="nursery"
DEPLOY_PATH="/var/www/nursery-app"
BACKUP_BEFORE_DEPLOY=true
HEALTH_CHECK_URL="http://localhost:8080/health"
ROLLBACK_ON_FAILURE=true

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
}

warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

info() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $1${NC}"
}

# Function to check if running as root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        error "This script should not be run as root"
        exit 1
    fi
}

# Function to check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check if Docker is installed
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed"
        exit 1
    fi
    
    # Check if Docker Compose is installed
    if ! command -v docker-compose &> /dev/null; then
        error "Docker Compose is not installed"
        exit 1
    fi
    
    # Check if git is installed
    if ! command -v git &> /dev/null; then
        error "Git is not installed"
        exit 1
    fi
    
    # Check if environment file exists
    if [ ! -f ".env.production" ]; then
        error "Production environment file (.env.production) not found"
        exit 1
    fi
    
    log "Prerequisites check passed"
}

# Function to create backup before deployment
create_backup() {
    if [ "$BACKUP_BEFORE_DEPLOY" = "true" ]; then
        log "Creating backup before deployment..."
        
        if [ -f "deployment/backup.sh" ]; then
            chmod +x deployment/backup.sh
            ./deployment/backup.sh backup || warning "Backup failed, continuing with deployment"
        else
            warning "Backup script not found, skipping backup"
        fi
    fi
}

# Function to stop existing services
stop_services() {
    log "Stopping existing services..."
    
    # Stop Docker containers if running
    if docker-compose -f deployment/docker-compose.yml ps | grep -q "Up"; then
        docker-compose -f deployment/docker-compose.yml down
    fi
    
    # Stop PM2 processes if running
    if pm2 list | grep -q "$APP_NAME"; then
        pm2 stop "$APP_NAME" || true
    fi
    
    log "Services stopped"
}

# Function to pull latest code
pull_latest_code() {
    log "Pulling latest code from repository..."
    
    # Check if we're in a git repository
    if [ ! -d ".git" ]; then
        error "Not in a git repository"
        exit 1
    fi
    
    # Fetch latest changes
    git fetch origin
    
    # Check if there are any changes
    if [ "$(git rev-list HEAD...origin/main --count)" -eq 0 ]; then
        info "No new changes to deploy"
        exit 0
    fi
    
    # Pull latest changes
    git pull origin main
    
    log "Latest code pulled successfully"
}

# Function to install dependencies
install_dependencies() {
    log "Installing dependencies..."
    
    # Install npm dependencies
    npm ci --production
    
    log "Dependencies installed"
}

# Function to run security checks
run_security_checks() {
    log "Running security checks..."
    
    # Run npm audit
    if npm audit --audit-level=moderate; then
        log "Security audit passed"
    else
        warning "Security audit found vulnerabilities"
        read -p "Continue with deployment? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            error "Deployment aborted due to security vulnerabilities"
            exit 1
        fi
    fi
    
    # Check for sensitive data in code
    if grep -r "password\|secret\|key" . --exclude-dir=node_modules --exclude-dir=.git --exclude=*.md | grep -v ".env"; then
        warning "Potential sensitive data found in code"
    fi
}

# Function to build and deploy with Docker
deploy_with_docker() {
    log "Deploying with Docker Compose..."
    
    # Build and start services
    docker-compose -f deployment/docker-compose.yml up -d --build
    
    # Wait for services to be healthy
    log "Waiting for services to be healthy..."
    sleep 30
    
    # Check if services are running
    if docker-compose -f deployment/docker-compose.yml ps | grep -q "Up"; then
        log "Docker services started successfully"
    else
        error "Docker services failed to start"
        return 1
    fi
}

# Function to deploy with PM2
deploy_with_pm2() {
    log "Deploying with PM2..."
    
    # Start application with PM2
    pm2 start deployment/pm2.config.js --env production
    
    # Save PM2 configuration
    pm2 save
    
    # Wait for application to start
    log "Waiting for application to start..."
    sleep 10
    
    # Check if PM2 process is running
    if pm2 list | grep -q "$APP_NAME.*online"; then
        log "PM2 application started successfully"
    else
        error "PM2 application failed to start"
        return 1
    fi
}

# Function to perform health check
perform_health_check() {
    log "Performing health check..."
    
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -f "$HEALTH_CHECK_URL" >/dev/null 2>&1; then
            log "Health check passed"
            return 0
        fi
        
        info "Health check attempt $attempt/$max_attempts failed, retrying in 10 seconds..."
        sleep 10
        ((attempt++))
    done
    
    error "Health check failed after $max_attempts attempts"
    return 1
}

# Function to rollback deployment
rollback_deployment() {
    if [ "$ROLLBACK_ON_FAILURE" = "true" ]; then
        warning "Rolling back deployment..."
        
        # Stop current deployment
        stop_services
        
        # Restart previous version
        if [ -f "deployment/pm2.config.js" ]; then
            pm2 start deployment/pm2.config.js --env production || true
        fi
        
        warning "Rollback completed"
    fi
}

# Function to update Nginx configuration
update_nginx() {
    log "Updating Nginx configuration..."
    
    # Copy Nginx configuration
    if [ -f "deployment/nginx.conf" ]; then
        sudo cp deployment/nginx.conf /etc/nginx/sites-available/nursery-app
        
        # Enable site if not already enabled
        if [ ! -L /etc/nginx/sites-enabled/nursery-app ]; then
            sudo ln -s /etc/nginx/sites-available/nursery-app /etc/nginx/sites-enabled/
        fi
        
        # Test Nginx configuration
        if sudo nginx -t; then
            sudo systemctl reload nginx
            log "Nginx configuration updated"
        else
            error "Nginx configuration test failed"
            return 1
        fi
    fi
}

# Function to set up SSL certificate
setup_ssl() {
    log "Setting up SSL certificate..."
    
    # Check if domain is configured
    if [ -n "$DOMAIN" ]; then
        # Install certbot if not installed
        if ! command -v certbot &> /dev/null; then
            sudo apt update
            sudo apt install -y certbot python3-certbot-nginx
        fi
        
        # Get SSL certificate
        sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$SSL_EMAIL" || warning "SSL certificate setup failed"
    else
        warning "Domain not configured, skipping SSL setup"
    fi
}

# Function to run post-deployment tasks
post_deployment_tasks() {
    log "Running post-deployment tasks..."
    
    # Set up log rotation
    if [ ! -f "/etc/logrotate.d/nursery-app" ]; then
        sudo tee /etc/logrotate.d/nursery-app > /dev/null <<EOF
/var/log/nursery-app/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 nursery nursery
    postrotate
        pm2 reloadLogs
    endscript
}
EOF
    fi
    
    # Set up monitoring
    if command -v prometheus &> /dev/null; then
        log "Prometheus monitoring is available"
    fi
    
    log "Post-deployment tasks completed"
}

# Function to display deployment summary
deployment_summary() {
    log "=== Deployment Summary ==="
    info "Application: $APP_NAME"
    info "Deployment Path: $DEPLOY_PATH"
    info "Health Check URL: $HEALTH_CHECK_URL"
    
    # Display service status
    if command -v docker-compose &> /dev/null; then
        info "Docker Services Status:"
        docker-compose -f deployment/docker-compose.yml ps
    fi
    
    if command -v pm2 &> /dev/null; then
        info "PM2 Status:"
        pm2 list
    fi
    
    log "=== Deployment Completed Successfully ==="
}

# Main deployment function
main() {
    log "Starting production deployment..."
    
    # Check if running as root
    check_root
    
    # Check prerequisites
    check_prerequisites
    
    # Create backup
    create_backup
    
    # Stop existing services
    stop_services
    
    # Pull latest code
    pull_latest_code
    
    # Install dependencies
    install_dependencies
    
    # Run security checks
    run_security_checks
    
    # Deploy application
    if [ "$DEPLOY_METHOD" = "docker" ]; then
        deploy_with_docker || { rollback_deployment; exit 1; }
    else
        deploy_with_pm2 || { rollback_deployment; exit 1; }
    fi
    
    # Perform health check
    perform_health_check || { rollback_deployment; exit 1; }
    
    # Update Nginx
    update_nginx
    
    # Setup SSL
    setup_ssl
    
    # Post-deployment tasks
    post_deployment_tasks
    
    # Display summary
    deployment_summary
}

# Handle script arguments
case "${1:-deploy}" in
    "deploy")
        main
        ;;
    "rollback")
        rollback_deployment
        ;;
    "health")
        perform_health_check
        ;;
    "status")
        if command -v docker-compose &> /dev/null; then
            docker-compose -f deployment/docker-compose.yml ps
        fi
        if command -v pm2 &> /dev/null; then
            pm2 list
        fi
        ;;
    *)
        echo "Usage: $0 {deploy|rollback|health|status}"
        exit 1
        ;;
esac 