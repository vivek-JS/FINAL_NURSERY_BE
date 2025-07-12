import React, { useEffect, useState } from 'react';
import { useFonts } from 'expo-font';
import { SplashScreen, Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import ErrorBoundary from '../components/ErrorBoundary';
import { View, Text, StyleSheet } from 'react-native';

SplashScreen.preventAutoHideAsync();

// Loading component
const LoadingScreen = () => (
  <View style={styles.loadingContainer}>
    <Text style={styles.loadingText}>Loading...</Text>
  </View>
);

// Error fallback component
const ErrorFallback = ({ error }: { error: Error }) => (
  <View style={styles.errorContainer}>
    <Text style={styles.errorTitle}>Something went wrong</Text>
    <Text style={styles.errorMessage}>
      {error.message || 'An unexpected error occurred'}
    </Text>
    <Text style={styles.errorDetails}>
      Please restart the app or contact support if the problem persists.
    </Text>
  </View>
);

function RootLayoutNav() {
  const { isLogged, loading } = useAuth();
  const router = useRouter();
  const [navigationReady, setNavigationReady] = useState(false);

  useEffect(() => {
    const handleNavigation = async () => {
      try {
        console.log('🧭 Navigation effect - isLogged:', isLogged, 'loading:', loading);
        
        if (!loading && !navigationReady) {
          // Add a small delay to ensure everything is ready
          await new Promise(resolve => setTimeout(resolve, 100));
          
          if (isLogged) {
            console.log('✅ User is logged in, redirecting to home');
            router.replace('/(tabs)/home');
          } else {
            console.log('❌ User is not logged in, redirecting to sign-in');
            router.replace('/(auth)/sign-in');
          }
          
          setNavigationReady(true);
        }
      } catch (error) {
        console.error('❌ Navigation error:', error);
        // Fallback to sign-in on navigation error
        router.replace('/(auth)/sign-in');
      }
    };
    
    handleNavigation();
  }, [isLogged, loading, router, navigationReady]);

  console.log('🎯 RootLayoutNav render - isLogged:', isLogged, 'loading:', loading);

  // Show loading screen while auth is loading
  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="index" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontsError] = useFonts({
    'Poppins-Thin': require('../assets/fonts/Poppins-Thin.ttf'),
    'Poppins-Light': require('../assets/fonts/Poppins-Light.ttf'),
    'Poppins-Regular': require('../assets/fonts/Poppins-Regular.ttf'),
    'Poppins-Medium': require('../assets/fonts/Poppins-Medium.ttf'),
    'Poppins-SemiBold': require('../assets/fonts/Poppins-SemiBold.ttf'),
    'Poppins-Bold': require('../assets/fonts/Poppins-Bold.ttf'),
    'Poppins-ExtraBold': require('../assets/fonts/Poppins-ExtraBold.ttf'),
    'Poppins-Black': require('../assets/fonts/Poppins-Black.ttf'),
  });

  useEffect(() => {
    const hideSplash = async () => {
      try {
        if (fontsLoaded || fontsError) {
          console.log('🎨 Fonts loaded:', fontsLoaded, 'Error:', !!fontsError);
          await SplashScreen.hideAsync();
        }
      } catch (error) {
        console.error('❌ Error hiding splash screen:', error);
        // Hide splash screen anyway to prevent indefinite loading
        try {
          await SplashScreen.hideAsync();
        } catch (splashError) {
          console.error('❌ Failed to hide splash screen:', splashError);
        }
      }
    };
    
    hideSplash();
  }, [fontsLoaded, fontsError]);

  // Show error screen if fonts failed to load
  if (fontsError) {
    return <ErrorFallback error={fontsError} />;
  }

  // Show loading screen while fonts are loading
  if (!fontsLoaded) {
    return <LoadingScreen />;
  }

  return (
    <ErrorBoundary>
      <AuthProvider>
        <RootLayoutNav />
        <StatusBar style="light" />
      </AuthProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#3B82F6',
  },
  loadingText: {
    fontSize: 18,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    padding: 20,
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#DC2626',
    marginBottom: 10,
    textAlign: 'center',
  },
  errorMessage: {
    fontSize: 16,
    color: '#374151',
    textAlign: 'center',
    marginBottom: 20,
  },
  errorDetails: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },
}); 