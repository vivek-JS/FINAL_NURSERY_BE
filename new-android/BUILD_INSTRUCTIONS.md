# Build APK Instructions

## Quick Build Commands

### 1. Install EAS CLI (if not already installed)
```bash
npm install -g @expo/eas-cli
```

### 2. Login to Expo
```bash
eas login
```

### 3. Build APK
```bash
npm run build:android
```

### 4. Alternative Build Commands
```bash
# Build preview APK
eas build --platform android --profile preview

# Build production APK
eas build --platform android --profile production

# Using npm scripts
npm run build:android-prod
```

## What Happens Next

1. **Build Process**: The build will take 10-15 minutes
2. **Download Link**: You'll get a download link when build completes
3. **Install APK**: Download and install on your Android device
4. **Enable Unknown Sources**: Make sure to enable "Install from unknown sources" in Android settings

## Troubleshooting

- **Build Fails**: Check your internet connection and Expo login status
- **APK Won't Install**: Enable unknown sources in Android settings
- **Need Help**: Check the main README.md for detailed instructions

## Development

- **Start Dev Server**: `npm start`
- **Run on Android**: `npm run android`
- **Run on iOS**: `npm run ios`
- **Clear Cache**: `npm run clear` 