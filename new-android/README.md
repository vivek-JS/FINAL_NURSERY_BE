# New Android Login App

A simple, modern React Native login application built with Expo that can be compiled into an APK for Android devices.

## Features

- 🎨 **Modern UI Design** - Clean, professional login interface
- 📱 **Responsive Layout** - Optimized for all Android screen sizes
- 🔐 **Form Validation** - Email format validation and required field checks
- ⌨️ **Keyboard Handling** - Proper keyboard avoidance for better UX
- 🎭 **Loading States** - Visual feedback during login process
- 🌱 **Beautiful Styling** - Modern color scheme with shadows and animations

## Screenshots

The app features:
- Clean login form with email and password inputs
- Modern green color scheme (#10b981)
- Responsive design with proper spacing
- Loading states and form validation
- Professional typography and shadows

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Expo CLI
- Android Studio (for APK building)

## Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd new-android
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm start
   ```

## Development

- **Run on Android device/emulator**: `npm run android`
- **Run on iOS simulator**: `npm run ios`
- **Run on web**: `npm run web`

## Building APK

### Method 1: Using EAS Build (Recommended)

1. **Install EAS CLI**
   ```bash
   npm install -g @expo/eas-cli
   ```

2. **Login to Expo**
   ```bash
   eas login
   ```

3. **Configure EAS Build**
   ```bash
   eas build:configure
   ```

4. **Build APK for Android**
   ```bash
   eas build --platform android --profile preview
   ```

5. **Download and install APK**
   - The build will provide a download link
   - Download the APK file
   - Install on your Android device

### Method 2: Using Expo Build (Legacy)

1. **Build APK**
   ```bash
   expo build:android -t apk
   ```

2. **Download APK**
   - Follow the provided link to download
   - Install on your Android device

## Project Structure

```
new-android/
├── App.js                 # Main login component
├── app.json              # Expo configuration
├── eas.json              # EAS build configuration
├── package.json          # Dependencies
├── assets/               # Images and icons
└── README.md            # This file
```

## Customization

### Colors
The app uses a green color scheme. To change colors, modify the styles in `App.js`:
- Primary: `#10b981`
- Background: `#f8fafc`
- Text: `#1f2937`

### Logo
Replace the emoji logo (🌱) with your own image:
1. Add your logo image to the `assets/` folder
2. Update the `logoText` style in `App.js`
3. Or replace the Text component with an Image component

### API Integration
To connect to a real backend:
1. Replace the `handleLogin` function
2. Add your API endpoints
3. Implement proper error handling
4. Add authentication state management

## Troubleshooting

### Common Issues

1. **Build fails with EAS**
   - Ensure you're logged in: `eas login`
   - Check your internet connection
   - Verify app.json configuration

2. **APK won't install**
   - Enable "Install from unknown sources" in Android settings
   - Check if the APK is compatible with your Android version

3. **Development server issues**
   - Clear Metro cache: `npx expo start --clear`
   - Restart the development server

## Dependencies

- **expo**: ^53.0.0
- **react**: 18.2.0
- **react-native**: 0.76.3
- **react-native-safe-area-context**: ^4.8.2

## License

This project is open source and available under the [MIT License](LICENSE).

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review Expo documentation
3. Create an issue in the repository

---

**Happy coding! 🚀** 