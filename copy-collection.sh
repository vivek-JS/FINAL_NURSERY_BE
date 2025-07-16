#!/bin/bash

# MongoDB Collection Copy Script
# Usage: ./copy-collection.sh

echo "=== MongoDB Collection Copy Tool ==="
echo ""

# Get source details
read -p "Enter source MongoDB connection string (e.g., mongodb://host:port/database): " SOURCE_CONNECTION
read -p "Enter source database name: " SOURCE_DB
read -p "Enter source collection name: " SOURCE_COLLECTION
read -p "Enter destination database name (default: nursery_production): " DEST_DB
DEST_DB=${DEST_DB:-nursery_production}

echo ""
echo "Source: $SOURCE_CONNECTION/$SOURCE_DB.$SOURCE_COLLECTION"
echo "Destination: localhost:27017/$DEST_DB.$SOURCE_COLLECTION"
echo ""

# Confirm before proceeding
read -p "Do you want to proceed? (y/N): " CONFIRM
if [[ $CONFIRM != "y" && $CONFIRM != "Y" ]]; then
    echo "Operation cancelled."
    exit 0
fi

echo ""
echo "Step 1: Dumping collection from source..."
mongodump --uri="$SOURCE_CONNECTION" --db="$SOURCE_DB" --collection="$SOURCE_COLLECTION" --out="./temp_dump"

if [ $? -eq 0 ]; then
    echo "✓ Dump completed successfully"
else
    echo "✗ Dump failed"
    exit 1
fi

echo ""
echo "Step 2: Restoring collection to destination..."
mongorestore --uri="mongodb://localhost:27017" --db="$DEST_DB" --collection="$SOURCE_COLLECTION" "./temp_dump/$SOURCE_DB/$SOURCE_COLLECTION.bson"

if [ $? -eq 0 ]; then
    echo "✓ Restore completed successfully"
else
    echo "✗ Restore failed"
    exit 1
fi

echo ""
echo "Step 3: Cleaning up temporary files..."
rm -rf "./temp_dump"

echo ""
echo "=== Collection copy completed successfully! ==="
echo "Collection '$SOURCE_COLLECTION' has been copied to database '$DEST_DB'" 