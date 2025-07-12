# RAM Biotech Modern - React Native App

A modern, production-ready React Native application for nursery management with advanced features and contemporary design patterns.

## Features

- **Modern Architecture**: Built with Expo Router, TypeScript, and modern React patterns
- **Authentication**: JWT-based authentication with secure token management
- **Beautiful UI**: Modern design with Tailwind CSS (NativeWind) and custom components
- **Navigation**: Tab-based navigation with Home, Create, Dispatched, and Profile screens
- **State Management**: Context API for global state management
- **API Integration**: Robust API service with automatic token refresh
- **Production Ready**: EAS Build configuration for production deployment
- **Type Safety**: Full TypeScript support for better code quality

## Technology Stack

- **Framework**: Expo (React Native)
- **Language**: TypeScript
- **Styling**: NativeWind (Tailwind CSS for React Native)
- **Navigation**: Expo Router
- **Icons**: Lucide React Native
- **Storage**: AsyncStorage
- **HTTP Client**: Axios
- **Fonts**: Poppins font family
- **Build**: EAS Build

## Project Structure

```
ram-biotech-modern/
├── app/                    # App screens and navigation
│   ├── (auth)/            # Authentication screens
│   ├── (tabs)/            # Tab navigation screens
│   ├── _layout.tsx        # Root layout
│   └── index.tsx          # Main entry point
├── assets/                # Static assets
│   └── fonts/            # Poppins font files
├── components/            # Reusable UI components
│   ├── Button.tsx
│   ├── Input.tsx
│   └── Card.tsx
├── contexts/              # React contexts
│   └── AuthContext.tsx   # Authentication context
├── lib/                   # Utilities and services
│   ├── api/              # API service
│   ├── storage/          # Storage service
│   ├── types/            # TypeScript types
│   └── utils/            # Utility functions
├── eas.json              # EAS Build configuration
├── app.json              # Expo configuration
├── babel.config.js       # Babel configuration
└── tailwind.config.js    # Tailwind CSS configuration
```

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Expo CLI (`npm install -g @expo/cli`)
- EAS CLI (`npm install -g eas-cli`)

### Installation

1. **Navigate to the project directory**
   ```bash
   cd ram-biotech-modern
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   - The app is configured to use `http://localhost:8000/api/v1` for development
   - For production, update the API URL in `lib/api/index.ts`

4. **Start the development server**
   ```bash
   npm start
   ```

5. **Run on device/simulator**
   ```bash
   # For Android
   npm run android
   
   # For iOS
   npm run ios
   
   # For web
   npm run web
   ```

## Development

### Available Scripts

- `npm start` - Start the Expo development server
- `npm run android` - Run on Android device/emulator
- `npm run ios` - Run on iOS simulator
- `npm run web` - Run on web browser
- `npm run lint` - Run ESLint
- `npm run type-check` - Run TypeScript type checking

### API Configuration

The app connects to a backend API. Update the configuration in `lib/api/index.ts`:

```typescript
const API_CONFIG = {
  baseURL: process.env.NODE_ENV === 'development'
    ? 'http://localhost:8000/api/v1'
    : 'https://your-production-api.com/api/v1',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
};
```

### Authentication

The app uses JWT authentication with the following flow:
1. User signs in with email/password
2. Backend returns JWT token and refresh token
3. Tokens are stored in AsyncStorage
4. API requests include Bearer token in headers
5. Automatic token refresh on expiry

### Storage

User data and tokens are stored locally using AsyncStorage:
- `auth_token` - JWT access token
- `refresh_token` - JWT refresh token
- `user_data` - User profile information

## Screens

### Authentication
- **Sign In**: Email/password login with validation
- **Sign Up**: User registration with form validation

### Main App (Tab Navigation)
- **Home**: Dashboard with statistics and quick actions
- **Create**: Options to create places, plantations, dispatches
- **Dispatched**: List of dispatch orders with status tracking
- **Profile**: User profile and settings

## Components

### Button Component
Modern button with multiple variants:
- Primary, Secondary, Outline, Ghost
- Loading states
- Size variants (sm, md, lg)
- Full width support

### Input Component
Advanced input field with:
- Label and placeholder support
- Error state handling
- Password visibility toggle
- Validation integration

### Card Component
Flexible card component with:
- Multiple variants (default, outlined, elevated)
- Image support
- Clickable actions
- Custom styling

## Production Deployment

### EAS Build Configuration

The app includes EAS Build configuration for production deployment:

```json
{
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    },
    "production": {
      "android": {
        "buildType": "aab"
      }
    }
  }
}
```

### Build Commands

```bash
# Development build
eas build --profile development

# Preview build (APK for testing)
eas build --profile preview

# Production build
eas build --profile production

# Build for specific platform
eas build --platform android --profile production
eas build --platform ios --profile production
```

### Deployment Steps

1. **Configure EAS Project**
   ```bash
   eas build:configure
   ```

2. **Update app.json**
   - Set appropriate bundle identifier
   - Configure permissions
   - Update version numbers

3. **Build for Production**
   ```bash
   eas build --platform all --profile production
   ```

4. **Submit to App Stores**
   ```bash
   eas submit --platform android
   eas submit --platform ios
   ```

## Environment Configuration

### Development
- API Base URL: `http://localhost:8000/api/v1`
- Debug mode enabled
- Development-specific configurations

### Production
- API Base URL: Configure in `lib/api/index.ts`
- Production optimizations enabled
- Minification and obfuscation

## Features Overview

### Modern UI/UX
- Clean, modern design with consistent styling
- Smooth animations and transitions
- Responsive layout for different screen sizes
- Accessibility features

### Navigation
- Tab-based navigation with icons
- Stack navigation for authentication
- Deep linking support
- Type-safe navigation

### State Management
- Context API for global state
- Local state management with hooks
- Persistent storage integration

### API Integration
- Axios-based HTTP client
- Automatic token refresh
- Error handling and retry logic
- Request/response interceptors

### Form Handling
- Comprehensive form validation
- Real-time error feedback
- Accessible form controls
- Type-safe form data

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License.

## Support

For support and questions:
- Create an issue in the repository
- Contact the development team
- Check the documentation

## Version History

- **v1.0.0** - Initial release with core features
  - Authentication system
  - Tab navigation
  - Modern UI components
  - API integration
  - Production build setup

---

**RAM Biotech Modern** - Built with ❤️ using React Native and Expo 