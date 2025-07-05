#!/bin/bash

# MongoDB Backup Script for Nursery Management System
# This script creates encrypted, compressed backups of the MongoDB database

set -e

# Configuration
BACKUP_DIR="/backups"
MONGO_URL="${MONGO_URL:-mongodb://localhost:27017/nursery_production}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-your-backup-encryption-key}"
COMPRESS_BACKUP="${COMPRESS_BACKUP:-true}"
UPLOAD_TO_S3="${UPLOAD_TO_S3:-false}"
S3_BUCKET="${S3_BUCKET:-nursery-backups}"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Generate timestamp for backup filename
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="nursery_backup_${TIMESTAMP}"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
}

warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

# Function to clean old backups
cleanup_old_backups() {
    log "Cleaning up backups older than $BACKUP_RETENTION_DAYS days..."
    
    find "$BACKUP_DIR" -name "nursery_backup_*.gz" -type f -mtime +$BACKUP_RETENTION_DAYS -delete
    find "$BACKUP_DIR" -name "nursery_backup_*.enc" -type f -mtime +$BACKUP_RETENTION_DAYS -delete
    
    log "Cleanup completed"
}

# Function to upload to S3 (if configured)
upload_to_s3() {
    if [ "$UPLOAD_TO_S3" = "true" ]; then
        if command -v aws &> /dev/null; then
            log "Uploading backup to S3..."
            aws s3 cp "$BACKUP_PATH.gz.enc" "s3://$S3_BUCKET/"
            log "Upload completed"
        else
            warning "AWS CLI not found, skipping S3 upload"
        fi
    fi
}

# Function to verify backup integrity
verify_backup() {
    log "Verifying backup integrity..."
    
    # Test if the backup can be read
    if [ "$COMPRESS_BACKUP" = "true" ]; then
        if gzip -t "$BACKUP_PATH.gz.enc" 2>/dev/null; then
            log "Backup verification successful"
        else
            error "Backup verification failed"
            exit 1
        fi
    else
        if [ -s "$BACKUP_PATH" ]; then
            log "Backup verification successful"
        else
            error "Backup verification failed"
            exit 1
        fi
    fi
}

# Function to send notification (if configured)
send_notification() {
    if [ -n "$NOTIFICATION_WEBHOOK" ]; then
        log "Sending notification..."
        curl -X POST "$NOTIFICATION_WEBHOOK" \
            -H "Content-Type: application/json" \
            -d "{\"text\":\"Nursery backup completed: $BACKUP_NAME\"}" \
            --silent --output /dev/null || warning "Failed to send notification"
    fi
}

# Main backup process
main() {
    log "Starting MongoDB backup process..."
    
    # Check if MongoDB is accessible
    if ! mongosh "$MONGO_URL" --eval "db.adminCommand('ping')" --quiet >/dev/null 2>&1; then
        error "Cannot connect to MongoDB"
        exit 1
    fi
    
    # Create backup
    log "Creating backup: $BACKUP_NAME"
    
    if mongodump --uri="$MONGO_URL" --out="$BACKUP_PATH" --quiet; then
        log "MongoDB dump completed successfully"
    else
        error "MongoDB dump failed"
        exit 1
    fi
    
    # Compress backup if enabled
    if [ "$COMPRESS_BACKUP" = "true" ]; then
        log "Compressing backup..."
        tar -czf "$BACKUP_PATH.tar.gz" -C "$BACKUP_PATH" .
        rm -rf "$BACKUP_PATH"
        BACKUP_PATH="$BACKUP_PATH.tar.gz"
        log "Compression completed"
    fi
    
    # Encrypt backup
    log "Encrypting backup..."
    openssl enc -aes-256-cbc -salt -in "$BACKUP_PATH" -out "$BACKUP_PATH.enc" -k "$ENCRYPTION_KEY"
    rm "$BACKUP_PATH"
    BACKUP_PATH="$BACKUP_PATH.enc"
    log "Encryption completed"
    
    # Verify backup
    verify_backup
    
    # Upload to S3
    upload_to_s3
    
    # Clean up old backups
    cleanup_old_backups
    
    # Send notification
    send_notification
    
    log "Backup process completed successfully: $BACKUP_PATH"
    
    # Display backup size
    BACKUP_SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
    log "Backup size: $BACKUP_SIZE"
}

# Handle script arguments
case "${1:-backup}" in
    "backup")
        main
        ;;
    "restore")
        if [ -z "$2" ]; then
            error "Please specify backup file to restore"
            exit 1
        fi
        log "Restore functionality not implemented in this script"
        ;;
    "list")
        log "Available backups:"
        ls -lh "$BACKUP_DIR"/nursery_backup_* 2>/dev/null || warning "No backups found"
        ;;
    "cleanup")
        cleanup_old_backups
        ;;
    *)
        echo "Usage: $0 {backup|restore <file>|list|cleanup}"
        exit 1
        ;;
esac 