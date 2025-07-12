# RAM Biotech Modern - APK Build Crash Troubleshooting Guide

## Overview
This guide addresses common issues that can cause APK builds to crash and provides solutions to fix them.

## Fixes Applied

### 1. ProGuard Configuration Issues
**Problem:** ProGuard was minifying critical classes causing runtime crashes.
**Solution:** Added comprehensive ProGuard rules in `android/proguard-rules.pro`:
- Keep React Native classes
- Keep Expo classes  
- Keep AsyncStorage classes
- Keep navigation libraries
- Keep all model classes
- Keep font assets

### 2. Network Security Configuration
**Problem:** HTTPS connections might fail due to network security policies.
**Solution:** Added network security configuration in `android/network_security_config.xml`:
- Allow HTTPS connections to your backend
- Proper certificate validation
- Development mode support for localhost

### 3. Improved Error Handling
**Problem:** Unhandled errors causing crashes during authentication and API calls.
**Solution:** Enhanced error handling in:
- `contexts/AuthContext.tsx` - Added timeouts and better error recovery
- `lib/api/index.ts` - Added comprehensive error handling and retry logic
- `app/_layout.tsx` - Added proper font loading error handling

### 4. Font Loading Issues
**Problem:** Custom fonts might fail to load in production builds.
**Solution:** Added robust font loading with error fallbacks in the root layout.

## Build Commands

### For Testing (APK)
```bash
# Build APK for testing
eas build --platform android --profile preview

# Or using local build
npx expo run:android --variant release
```

### For Production (AAB)
```bash
# Build AAB for Play Store
eas build --platform android --profile production
```

## Common Issues and Solutions

### 1. App Crashes on Startup
**Symptoms:** App crashes immediately after launch
**Possible Causes:**
- ProGuard minification issues
- Font loading problems
- Network configuration issues

**Solutions:**
- Check the ProGuard rules are properly configured
- Verify font files exist in `assets/fonts/`
- Check network connectivity

### 2. Authentication Failures
**Symptoms:** Login/logout not working, token refresh failures
**Possible Causes:**
- Network security blocking HTTPS
- AsyncStorage permissions
- API endpoint connectivity

**Solutions:**
- Verify network security config
- Check backend API is accessible
- Clear app storage and retry

### 3. White Screen / Infinite Loading
**Symptoms:** App shows white screen or loading indefinitely
**Possible Causes:**
- Font loading failures
- Navigation issues
- AsyncStorage problems

**Solutions:**
- Check font loading error handling
- Clear AsyncStorage data
- Restart the app

## Debug Commands

### Check Logs
```bash
# Android logs
adb logcat | grep -i "ReactNativeJS\|ExponentJS\|expo"

# React Native logs
npx react-native log-android
```

### Clear Cache
```bash
# Clear React Native cache
npx react-native start --reset-cache

# Clear Expo cache
npx expo start --clear
```

### Debug Build
```bash
# Create debug build for testing
eas build --platform android --profile development --local
```

## Production Checklist

Before building for production:

- [ ] Test app in development mode
- [ ] Verify all fonts load correctly
- [ ] Test authentication flow
- [ ] Test network connectivity
- [ ] Check all API endpoints work
- [ ] Verify ProGuard rules don't break functionality
- [ ] Test on multiple devices/Android versions

## Environment Variables

Ensure these are properly configured:

```bash
# In your .env or build configuration
API_URL=https://final-nursery-be-1.onrender.com/api/v1
ENVIRONMENT=production
```

## Build Configuration Files

Key files that were modified:
- `app.json` - Added Android build configuration
- `android/proguard-rules.pro` - ProGuard rules
- `android/network_security_config.xml` - Network security
- `contexts/AuthContext.tsx` - Enhanced error handling
- `lib/api/index.ts` - Improved API error handling
- `app/_layout.tsx` - Font loading fixes

## Getting Help

If you continue to experience crashes:

1. Check the console logs for specific error messages
2. Test on different devices/Android versions
3. Try building with different EAS profiles
4. Review the ProGuard rules for your specific use case
5. Check network connectivity and API endpoints

## Next Steps

1. **Test the fixes:**
   ```bash
   eas build --platform android --profile preview
   ```

2. **Install and test the APK:**
   - Download the APK from EAS
   - Install on a test device
   - Test all major features

3. **Monitor for issues:**
   - Check app logs during testing
   - Test authentication flow
   - Verify API calls work properly

4. **Production build:**
   ```bash
   eas build --platform android --profile production
   ```

The fixes address the most common causes of APK crashes. Most issues should be resolved with these changes. 