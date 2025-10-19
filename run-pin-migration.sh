#!/bin/bash

# Migration Script Runner for Setting Sales & Dealer PIN to 1234
# Usage: ./run-pin-migration.sh

echo "🔐 Sales & Dealer PIN Migration Script"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "This script will:"
echo "  1. Set all SALES users' password to 1234"
echo "  2. Set all DEALER users' password to 1234"
echo "  3. Set isPasswordSet to false (force PIN change on login)"
echo ""
echo "⚠️  IMPORTANT: This will affect all SALES and DEALER users!"
echo ""

# Check if we're in the right directory
if [ ! -f "set-sales-dealer-pin-1234.js" ]; then
    echo "❌ Error: set-sales-dealer-pin-1234.js not found"
    echo "   Please run this script from FINAL_NURSERY_BE directory"
    exit 1
fi

# Ask for confirmation
read -p "Do you want to continue? (yes/no): " confirmation

if [ "$confirmation" != "yes" ]; then
    echo "❌ Migration cancelled"
    exit 0
fi

echo ""
echo "🔍 Step 1: Backup database (recommended)"
read -p "Create database backup first? (yes/no): " backup_choice

if [ "$backup_choice" = "yes" ]; then
    BACKUP_DIR="./backup-$(date +%Y%m%d-%H%M%S)"
    echo "📦 Creating backup in $BACKUP_DIR..."
    
    # Try to create backup (may fail if mongodump not in PATH)
    if command -v mongodump &> /dev/null; then
        mongodump --db nursery-management --out "$BACKUP_DIR"
        echo "✅ Backup created successfully"
    else
        echo "⚠️  mongodump command not found"
        echo "   Please create a backup manually before proceeding"
        read -p "Continue anyway? (yes/no): " continue_choice
        if [ "$continue_choice" != "yes" ]; then
            echo "❌ Migration cancelled"
            exit 0
        fi
    fi
fi

echo ""
echo "🚀 Step 2: Running migration..."
echo "═══════════════════════════════════════════════════════"
echo ""

# Run the migration
node set-sales-dealer-pin-1234.js

EXIT_CODE=$?

echo ""
echo "═══════════════════════════════════════════════════════"

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Migration completed successfully!"
    echo ""
    echo "📱 Next steps:"
    echo "  1. Test login on Android app"
    echo "  2. Use PIN: 1234"
    echo "  3. PIN change modal should appear"
    echo "  4. Set new PIN and access app"
    echo ""
    echo "📧 Don't forget to notify affected users!"
else
    echo "❌ Migration failed with exit code $EXIT_CODE"
    echo ""
    echo "🔄 If you created a backup, you can restore it with:"
    echo "   mongorestore --db nursery-management $BACKUP_DIR/nursery-management"
    exit 1
fi

