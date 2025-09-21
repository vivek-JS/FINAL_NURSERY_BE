#!/bin/bash

echo "🚀 New Android Login App - APK Builder"
echo "======================================"

# Check if EAS CLI is installed
if ! command -v eas &> /dev/null; then
    echo "❌ EAS CLI not found. Installing..."
    npm install -g @expo/eas-cli
fi

# Check if user is logged in
echo "🔐 Checking Expo login status..."
if ! eas whoami &> /dev/null; then
    echo "❌ Not logged in to Expo. Please login first:"
    echo "   eas login"
    exit 1
fi

echo "✅ Logged in to Expo"

# Configure build if needed
if [ ! -f "eas.json" ]; then
    echo "⚙️  Configuring EAS build..."
    eas build:configure
fi

echo "🔨 Building APK for Android..."
echo "   This may take 10-15 minutes..."

# Build the APK
eas build --platform android --profile preview

echo ""
echo "🎉 Build completed!"
echo "📱 Download the APK from the link above and install on your Android device"
echo ""
echo "💡 Tips:"
echo "   - Enable 'Install from unknown sources' in Android settings"
echo "   - The APK will be compatible with Android 5.0+"
echo "   - You can also run 'npm run build:android' for future builds" 