import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Alert } from 'react-native';
import { apiService } from '../lib/api';
import { storageService } from '../lib/storage';
import { User, AuthState, LoginCredentials, RegisterCredentials } from '../lib/types';
import { handleApiError } from '../lib/utils';

interface AuthContextType {
  // State
  user: User | null;
  isLogged: boolean;
  loading: boolean;
  
  // Actions
  login: (credentials: LoginCredentials) => Promise<void>;
  register: (userData: RegisterCredentials) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (userData: Partial<User>) => Promise<void>;
  updatePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  checkAuthState: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    isLogged: false,
    loading: true,
    token: null,
  });

  // Check authentication state on app start
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        console.log('🚀 Initializing authentication...');
        await checkAuthState();
      } catch (error) {
        console.error('❌ Failed to initialize auth state:', error);
        // Always ensure we set loading to false even if auth check fails
        setAuthState(prev => ({ 
          ...prev, 
          loading: false,
          isLogged: false,
          user: null,
          token: null 
        }));
      }
    };
    
    initializeAuth();
  }, []);

  const checkAuthState = async () => {
    try {
      console.log('🔍 Checking auth state...');
      setAuthState(prev => ({ ...prev, loading: true }));
      
      // Add timeout to prevent hanging
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Auth check timeout')), 10000)
      );
      
      const authCheck = async () => {
        try {
          const token = await storageService.getAuthToken();
          const userData = await storageService.getUserData();
          
          console.log('🔑 Auth data check - token:', !!token, 'userData:', !!userData);
          
          if (token && userData) {
            try {
              // Verify token is still valid by fetching current user
              const response = await apiService.getCurrentUser();
              
              if (response?.status === 'Success' && response?.data) {
                console.log('✅ Token is valid, user authenticated:', response.data.name);
                setAuthState({
                  user: response.data,
                  isLogged: true,
                  loading: false,
                  token,
                });
                
                // Update stored user data if it's different
                if (JSON.stringify(userData) !== JSON.stringify(response.data)) {
                  await storageService.setUserData(response.data);
                }
              } else {
                throw new Error('Invalid user data received');
              }
            } catch (error) {
              console.error('❌ Token validation failed:', error);
              // Token is invalid, clear auth data
              await clearAuthData();
            }
          } else {
            console.log('❌ No valid auth data found');
            // No token or user data found
            setAuthState({
              user: null,
              isLogged: false,
              loading: false,
              token: null,
            });
          }
        } catch (error) {
          console.error('❌ Auth check error:', error);
          await clearAuthData();
        }
      };
      
      await Promise.race([authCheck(), timeout]);
    } catch (error) {
      console.error('❌ Auth state check failed:', error);
      await clearAuthData();
    }
  };

  const login = async (credentials: LoginCredentials) => {
    try {
      console.log('🔐 Login attempt started for:', credentials.phoneNumber);
      setAuthState(prev => ({ ...prev, loading: true }));
      
      // Add timeout for login request
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Login timeout')), 30000)
      );
      
      const loginRequest = async () => {
        const response = await apiService.login(credentials);
        console.log('📡 Login response status:', response?.status);
        
        if (response?.status === 'Success' && response?.data) {
          const { user, accessToken, refreshToken } = response.data;
          
          if (!user || !accessToken) {
            throw new Error('Invalid login response data');
          }
          
          console.log('✅ Login successful for user:', user.name);
          
          // Store auth data with error handling
          try {
            await storageService.setAuthToken(accessToken);
            if (refreshToken) {
              await storageService.setRefreshToken(refreshToken);
            }
            await storageService.setUserData(user);
          } catch (storageError) {
            console.error('❌ Failed to store auth data:', storageError);
            throw new Error('Failed to store authentication data');
          }
          
          const newAuthState = {
            user,
            isLogged: true,
            loading: false,
            token: accessToken,
          };
          
          setAuthState(newAuthState);
          console.log('✅ Auth state updated successfully');
        } else {
          throw new Error(response?.message || 'Login failed - invalid response');
        }
      };
      
      await Promise.race([loginRequest(), timeout]);
    } catch (error) {
      console.error('❌ Login error:', error);
      setAuthState(prev => ({ ...prev, loading: false }));
      const errorMessage = handleApiError(error);
      Alert.alert('Login Failed', errorMessage);
      throw error;
    }
  };

  const register = async (userData: RegisterCredentials) => {
    try {
      console.log('📝 Registration attempt started');
      setAuthState(prev => ({ ...prev, loading: true }));
      
      // Add timeout for registration request
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Registration timeout')), 30000)
      );
      
      const registerRequest = async () => {
        const response = await apiService.register(userData);
        
        if (response?.status === 'Success' && response?.data) {
          const { user, accessToken, refreshToken } = response.data;
          
          if (!user || !accessToken) {
            throw new Error('Invalid registration response data');
          }
          
          // Store auth data with error handling
          try {
            await storageService.setAuthToken(accessToken);
            if (refreshToken) {
              await storageService.setRefreshToken(refreshToken);
            }
            await storageService.setUserData(user);
          } catch (storageError) {
            console.error('❌ Failed to store auth data:', storageError);
            throw new Error('Failed to store authentication data');
          }
          
          setAuthState({
            user,
            isLogged: true,
            loading: false,
            token: accessToken,
          });
          
          Alert.alert('Success', 'Account created successfully!');
        } else {
          throw new Error(response?.message || 'Registration failed');
        }
      };
      
      await Promise.race([registerRequest(), timeout]);
    } catch (error) {
      console.error('❌ Registration error:', error);
      setAuthState(prev => ({ ...prev, loading: false }));
      const errorMessage = handleApiError(error);
      Alert.alert('Registration Failed', errorMessage);
      throw error;
    }
  };

  const logout = async () => {
    try {
      console.log('🚪 Logout initiated');
      setAuthState(prev => ({ ...prev, loading: true }));
      
      // Call logout endpoint with timeout
      try {
        const timeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Logout timeout')), 10000)
        );
        
        await Promise.race([apiService.logout(), timeout]);
        console.log('✅ Logout API call successful');
      } catch (error) {
        console.error('❌ Logout API call failed:', error);
        // Continue with local logout even if API call fails
      }
      
      // Clear auth data
      await clearAuthData();
      
      Alert.alert('Success', 'You have been logged out successfully');
    } catch (error) {
      console.error('❌ Logout error:', error);
      // Force logout even if there's an error
      await clearAuthData();
    }
  };

  const updateUser = async (userData: Partial<User>) => {
    try {
      if (!authState.user) {
        throw new Error('No user logged in');
      }
      
      console.log('👤 Updating user profile');
      setAuthState(prev => ({ ...prev, loading: true }));
      
      const response = await apiService.updateUser(authState.user._id, userData);
      
      if (response?.status === 'Success' && response?.data) {
        const updatedUser = response.data;
        
        // Update stored user data
        await storageService.setUserData(updatedUser);
        
        setAuthState(prev => ({
          ...prev,
          user: updatedUser,
          loading: false,
        }));
        
        Alert.alert('Success', 'Profile updated successfully');
      } else {
        throw new Error(response?.message || 'Update failed');
      }
    } catch (error) {
      console.error('❌ Update user error:', error);
      setAuthState(prev => ({ ...prev, loading: false }));
      const errorMessage = handleApiError(error);
      Alert.alert('Update Failed', errorMessage);
      throw error;
    }
  };

  const updatePassword = async (oldPassword: string, newPassword: string) => {
    try {
      console.log('🔒 Updating password');
      setAuthState(prev => ({ ...prev, loading: true }));
      
      const response = await apiService.updatePassword(oldPassword, newPassword);
      
      if (response?.status === 'Success') {
        setAuthState(prev => ({ ...prev, loading: false }));
        Alert.alert('Success', 'Password updated successfully');
      } else {
        throw new Error(response?.message || 'Password update failed');
      }
    } catch (error) {
      console.error('❌ Update password error:', error);
      setAuthState(prev => ({ ...prev, loading: false }));
      const errorMessage = handleApiError(error);
      Alert.alert('Password Update Failed', errorMessage);
      throw error;
    }
  };

  const clearAuthData = async () => {
    try {
      console.log('🧹 Clearing auth data');
      await storageService.clearAuthData();
      setAuthState({
        user: null,
        isLogged: false,
        loading: false,
        token: null,
      });
      console.log('✅ Auth data cleared successfully');
    } catch (error) {
      console.error('❌ Error clearing auth data:', error);
      // Still update state even if storage clearing fails
      setAuthState({
        user: null,
        isLogged: false,
        loading: false,
        token: null,
      });
    }
  };

  const contextValue: AuthContextType = {
    user: authState.user,
    isLogged: authState.isLogged,
    loading: authState.loading,
    login,
    register,
    logout,
    updateUser,
    updatePassword,
    checkAuthState,
  };

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}; 