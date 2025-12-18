#!/bin/bash

# Quick MongoDB Backup Script
# Usage: ./quick-backup.sh

set -e

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/backups"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Generate timestamp for backup filename
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="nursery_backup_${TIMESTAMP}"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== MongoDB Quick Backup ===${NC}"
echo ""

# Try to get MongoDB URL from environment or use default
if [ -z "$MONGO_URL" ]; then
    # Try to read from .env file if it exists
    if [ -f "$SCRIPT_DIR/.env" ]; then
        MONGO_URL=$(grep -E "^MONGO_URL=" "$SCRIPT_DIR/.env" | cut -d '=' -f2- | tr -d '"' | tr -d "'" || echo "")
    fi
    
    # If still empty, try common defaults
    if [ -z "$MONGO_URL" ]; then
        MONGO_URL="mongodb://localhost:27017/nursery_production"
        echo -e "${YELLOW}Using default MongoDB URL: $MONGO_URL${NC}"
        echo -e "${YELLOW}Set MONGO_URL environment variable or update .env file to use custom URL${NC}"
    else
        echo -e "${GREEN}Using MongoDB URL from .env file${NC}"
    fi
else
    echo -e "${GREEN}Using MongoDB URL from environment variable${NC}"
fi

echo ""
echo "Backup location: $BACKUP_PATH"
echo ""

# Check if MongoDB tools are available
if ! command -v mongodump &> /dev/null; then
    echo -e "${YELLOW}Warning: mongodump not found. Trying mongosh...${NC}"
    
    if ! command -v mongosh &> /dev/null && ! command -v mongo &> /dev/null; then
        echo "Error: MongoDB tools (mongodump or mongosh) not found!"
        echo "Please install MongoDB Database Tools: https://www.mongodb.com/try/download/database-tools"
        exit 1
    fi
fi

# Create backup
echo -e "${GREEN}Creating backup...${NC}"

if mongodump --uri="$MONGO_URL" --out="$BACKUP_PATH" 2>&1; then
    echo -e "${GREEN}✓ Backup completed successfully${NC}"
else
    echo "Error: Backup failed!"
    exit 1
fi

# Compress backup
echo -e "${GREEN}Compressing backup...${NC}"
cd "$BACKUP_DIR"
tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME" 2>/dev/null || {
    # If tar fails, try zip
    zip -r "${BACKUP_NAME}.zip" "$BACKUP_NAME" 2>/dev/null || {
        echo -e "${YELLOW}Warning: Could not compress backup. Keeping uncompressed version.${NC}"
        exit 0
    }
    COMPRESSED_FILE="${BACKUP_NAME}.zip"
}

if [ -z "$COMPRESSED_FILE" ]; then
    COMPRESSED_FILE="${BACKUP_NAME}.tar.gz"
fi

# Remove uncompressed directory
rm -rf "$BACKUP_NAME"

# Display backup info
BACKUP_SIZE=$(du -h "$COMPRESSED_FILE" | cut -f1)
echo ""
echo -e "${GREEN}=== Backup Complete ===${NC}"
echo "Backup file: $BACKUP_DIR/$COMPRESSED_FILE"
echo "Backup size: $BACKUP_SIZE"
echo ""
echo "To restore this backup, use:"
echo "  tar -xzf $BACKUP_DIR/$COMPRESSED_FILE"
echo "  mongorestore --uri=\"$MONGO_URL\" $BACKUP_DIR/$BACKUP_NAME"
echo ""



