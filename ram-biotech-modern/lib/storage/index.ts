import AsyncStorage from '@react-native-async-storage/async-storage';
import { User } from '../types';

// Storage Keys
const STORAGE_KEYS = {
  AUTH_TOKEN: 'auth_token',
  USER_DATA: 'user_data',
  REFRESH_TOKEN: 'refresh_token',
  REMEMBER_ME: 'remember_me',
  USER_PREFERENCES: 'user_preferences',
  OFFLINE_DATA: 'offline_data',
} as const;

// Storage Service Class
class StorageService {
  // Token Management
  async setAuthToken(token: string): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, token);
    } catch (error) {
      console.error('Error saving auth token:', error);
      throw new Error('Failed to save authentication token');
    }
  }

  async getAuthToken(): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    } catch (error) {
      console.error('Error retrieving auth token:', error);
      return null;
    }
  }

  async removeAuthToken(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    } catch (error) {
      console.error('Error removing auth token:', error);
      throw new Error('Failed to remove authentication token');
    }
  }

  // Refresh Token Management
  async setRefreshToken(token: string): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, token);
    } catch (error) {
      console.error('Error saving refresh token:', error);
      throw new Error('Failed to save refresh token');
    }
  }

  async getRefreshToken(): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    } catch (error) {
      console.error('Error retrieving refresh token:', error);
      return null;
    }
  }

  async removeRefreshToken(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
    } catch (error) {
      console.error('Error removing refresh token:', error);
      throw new Error('Failed to remove refresh token');
    }
  }

  // User Data Management
  async setUserData(user: User): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(user));
    } catch (error) {
      console.error('Error saving user data:', error);
      throw new Error('Failed to save user data');
    }
  }

  async getUserData(): Promise<User | null> {
    try {
      const userData = await AsyncStorage.getItem(STORAGE_KEYS.USER_DATA);
      return userData ? JSON.parse(userData) : null;
    } catch (error) {
      console.error('Error retrieving user data:', error);
      return null;
    }
  }

  async removeUserData(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEYS.USER_DATA);
    } catch (error) {
      console.error('Error removing user data:', error);
      throw new Error('Failed to remove user data');
    }
  }

  // Remember Me Functionality
  async setRememberMe(remember: boolean): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.REMEMBER_ME, remember.toString());
    } catch (error) {
      console.error('Error saving remember me preference:', error);
      throw new Error('Failed to save remember me preference');
    }
  }

  async getRememberMe(): Promise<boolean> {
    try {
      const rememberMe = await AsyncStorage.getItem(STORAGE_KEYS.REMEMBER_ME);
      return rememberMe === 'true';
    } catch (error) {
      console.error('Error retrieving remember me preference:', error);
      return false;
    }
  }

  // User Preferences Management
  async setUserPreferences(preferences: Record<string, any>): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.USER_PREFERENCES, JSON.stringify(preferences));
    } catch (error) {
      console.error('Error saving user preferences:', error);
      throw new Error('Failed to save user preferences');
    }
  }

  async getUserPreferences(): Promise<Record<string, any> | null> {
    try {
      const preferences = await AsyncStorage.getItem(STORAGE_KEYS.USER_PREFERENCES);
      return preferences ? JSON.parse(preferences) : null;
    } catch (error) {
      console.error('Error retrieving user preferences:', error);
      return null;
    }
  }

  async removeUserPreferences(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEYS.USER_PREFERENCES);
    } catch (error) {
      console.error('Error removing user preferences:', error);
      throw new Error('Failed to remove user preferences');
    }
  }

  // Offline Data Management
  async setOfflineData(data: Record<string, any>): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.OFFLINE_DATA, JSON.stringify(data));
    } catch (error) {
      console.error('Error saving offline data:', error);
      throw new Error('Failed to save offline data');
    }
  }

  async getOfflineData(): Promise<Record<string, any> | null> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.OFFLINE_DATA);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error retrieving offline data:', error);
      return null;
    }
  }

  async removeOfflineData(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEYS.OFFLINE_DATA);
    } catch (error) {
      console.error('Error removing offline data:', error);
      throw new Error('Failed to remove offline data');
    }
  }

  // Clear All Data
  async clearAll(): Promise<void> {
    try {
      await AsyncStorage.multiRemove([
        STORAGE_KEYS.AUTH_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
        STORAGE_KEYS.USER_DATA,
        STORAGE_KEYS.USER_PREFERENCES,
        STORAGE_KEYS.OFFLINE_DATA,
      ]);
    } catch (error) {
      console.error('Error clearing all data:', error);
      throw new Error('Failed to clear all data');
    }
  }

  // Clear Auth Data Only
  async clearAuthData(): Promise<void> {
    try {
      await AsyncStorage.multiRemove([
        STORAGE_KEYS.AUTH_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
        STORAGE_KEYS.USER_DATA,
      ]);
    } catch (error) {
      console.error('Error clearing auth data:', error);
      throw new Error('Failed to clear authentication data');
    }
  }

  // Generic Storage Methods
  async setItem(key: string, value: string): Promise<void> {
    try {
      await AsyncStorage.setItem(key, value);
    } catch (error) {
      console.error(`Error saving item with key ${key}:`, error);
      throw new Error(`Failed to save item with key ${key}`);
    }
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(key);
    } catch (error) {
      console.error(`Error retrieving item with key ${key}:`, error);
      return null;
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key);
    } catch (error) {
      console.error(`Error removing item with key ${key}:`, error);
      throw new Error(`Failed to remove item with key ${key}`);
    }
  }

  // Utility Methods
  async getAllKeys(): Promise<string[]> {
    try {
      return await AsyncStorage.getAllKeys();
    } catch (error) {
      console.error('Error retrieving all keys:', error);
      return [];
    }
  }

  async hasKey(key: string): Promise<boolean> {
    try {
      const keys = await this.getAllKeys();
      return keys.includes(key);
    } catch (error) {
      console.error(`Error checking if key ${key} exists:`, error);
      return false;
    }
  }

  async getStorageSize(): Promise<number> {
    try {
      const keys = await this.getAllKeys();
      let totalSize = 0;
      
      for (const key of keys) {
        const value = await AsyncStorage.getItem(key);
        if (value) {
          totalSize += new Blob([value]).size;
        }
      }
      
      return totalSize;
    } catch (error) {
      console.error('Error calculating storage size:', error);
      return 0;
    }
  }

  // Backup and Restore
  async backupData(): Promise<Record<string, string>> {
    try {
      const keys = await this.getAllKeys();
      const backup: Record<string, string> = {};
      
      for (const key of keys) {
        const value = await AsyncStorage.getItem(key);
        if (value !== null) {
          backup[key] = value;
        }
      }
      
      return backup;
    } catch (error) {
      console.error('Error backing up data:', error);
      throw new Error('Failed to backup data');
    }
  }

  async restoreData(backup: Record<string, string>): Promise<void> {
    try {
      const keyValuePairs = Object.entries(backup);
      await AsyncStorage.multiSet(keyValuePairs);
    } catch (error) {
      console.error('Error restoring data:', error);
      throw new Error('Failed to restore data');
    }
  }
}

// Export singleton instance
export const storageService = new StorageService();
export default storageService;
export { STORAGE_KEYS }; 