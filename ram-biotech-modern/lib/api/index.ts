import axios, { AxiosInstance, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { storageService } from '../storage';
import { ApiResponse, User, LoginCredentials, RegisterCredentials, LoginResponse, RegisterResponse } from '../types';
import { handleApiError } from '../utils';
import { getApiConfig } from './config';

// Extend axios config to include retry property
interface ExtendedAxiosRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

// Get API configuration
const apiConfig = getApiConfig();

// Create axios instance with enhanced configuration
const apiClient: AxiosInstance = axios.create({
  ...apiConfig,
  timeout: 30000, // 30 second timeout
});

// Request interceptor - Add auth token with error handling
apiClient.interceptors.request.use(
  async (config) => {
    try {
      const token = await storageService.getAuthToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      
      // Add request ID for debugging
      const requestId = Math.random().toString(36).substr(2, 9);
      config.headers['X-Request-ID'] = requestId;
      
      console.log(`🌐 API Request [${requestId}]:`, config.method?.toUpperCase(), config.url);
      
      return config;
    } catch (error) {
      console.error('❌ Error in request interceptor:', error);
      return config;
    }
  },
  (error) => {
    console.error('❌ Request interceptor error:', error);
    return Promise.reject(error);
  }
);

// Response interceptor - Handle token refresh and errors
apiClient.interceptors.response.use(
  (response) => {
    const requestId = response.config.headers['X-Request-ID'];
    console.log(`✅ API Response [${requestId}]:`, response.status, response.config.url);
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as ExtendedAxiosRequestConfig;
    const requestId = originalRequest?.headers['X-Request-ID'];
    
    console.error(`❌ API Error [${requestId}]:`, error.response?.status, error.message);
    
    // Handle 401 errors with token refresh
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true;
      
      try {
        console.log('🔄 Attempting token refresh...');
        const refreshToken = await storageService.getRefreshToken();
        
        if (refreshToken) {
          const response = await axios.post(`${apiConfig.baseURL}/user/refresh`, {
            refreshToken,
          }, {
            timeout: 10000, // 10 second timeout for refresh
          });
          
          if (response.data?.accessToken) {
            const { accessToken, refreshToken: newRefreshToken } = response.data;
            
            await storageService.setAuthToken(accessToken);
            if (newRefreshToken) {
              await storageService.setRefreshToken(newRefreshToken);
            }
            
            // Retry the original request
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${accessToken}`;
            }
            
            console.log('✅ Token refresh successful, retrying request');
            return apiClient(originalRequest);
          }
        }
      } catch (refreshError) {
        console.error('❌ Token refresh failed:', refreshError);
        await storageService.clearAuthData();
        // Don't throw here, let the original error be handled
      }
    }
    
    // Handle network errors
    if (error.code === 'ECONNABORTED') {
      console.error('❌ Request timeout');
      error.message = 'Request timeout. Please check your internet connection.';
    } else if (error.code === 'NETWORK_ERROR') {
      console.error('❌ Network error');
      error.message = 'Network error. Please check your internet connection.';
    } else if (!error.response) {
      console.error('❌ No response received');
      error.message = 'No response from server. Please check your internet connection.';
    }
    
    return Promise.reject(error);
  }
);

// API Service Class with improved error handling
class ApiService {
  private async safeRequest<T>(
    requestFn: () => Promise<AxiosResponse>,
    operationName: string
  ): Promise<ApiResponse<T>> {
    try {
      const response = await requestFn();
      
      if (!response.data) {
        throw new Error(`${operationName} failed: No data received`);
      }
      
      return response.data;
    } catch (error) {
      console.error(`❌ ${operationName} error:`, error);
      
      // Enhanced error handling
      if (error instanceof AxiosError) {
        if (error.response?.data?.message) {
          throw new Error(error.response.data.message);
        } else if (error.response?.status === 500) {
          throw new Error('Server error. Please try again later.');
        } else if (error.response?.status === 404) {
          throw new Error('Resource not found.');
        } else if (error.response?.status === 403) {
          throw new Error('Access denied. Please check your permissions.');
        }
      }
      
      if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout. Please check your internet connection.');
      } else if (error.code === 'NETWORK_ERROR') {
        throw new Error('Network error. Please check your internet connection.');
      }
      
      throw new Error(error.message || `${operationName} failed`);
    }
  }

  // Authentication endpoints
  async login(credentials: LoginCredentials): Promise<ApiResponse<LoginResponse>> {
    return this.safeRequest(
      () => apiClient.post('/user/login', credentials),
      'Login'
    );
  }

  async register(userData: RegisterCredentials): Promise<ApiResponse<RegisterResponse>> {
    return this.safeRequest(
      () => apiClient.post('/user/register', userData),
      'Registration'
    );
  }

  async logout(): Promise<ApiResponse<null>> {
    return this.safeRequest(
      () => apiClient.post('/user/logout'),
      'Logout'
    );
  }

  async refreshToken(refreshToken: string): Promise<ApiResponse<{ accessToken: string; refreshToken: string }>> {
    return this.safeRequest(
      () => apiClient.post('/user/refresh', { refreshToken }),
      'Token refresh'
    );
  }

  async getCurrentUser(): Promise<ApiResponse<User>> {
    return this.safeRequest(
      () => apiClient.get('/user/me'),
      'Get current user'
    );
  }

  async updateUser(userId: string, userData: Partial<User>): Promise<ApiResponse<User>> {
    return this.safeRequest(
      () => apiClient.put(`/user/${userId}`, userData),
      'Update user'
    );
  }

  async updatePassword(oldPassword: string, newPassword: string): Promise<ApiResponse<null>> {
    return this.safeRequest(
      () => apiClient.put('/user/password', { oldPassword, newPassword }),
      'Update password'
    );
  }

  // Places endpoints
  async getPlaces(page: number = 1, limit: number = 10): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/places?page=${page}&limit=${limit}`),
      'Get places'
    );
  }

  async getPlace(id: string): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/places/${id}`),
      'Get place'
    );
  }

  async createPlace(placeData: any): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.post('/places', placeData),
      'Create place'
    );
  }

  async updatePlace(id: string, placeData: any): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.put(`/places/${id}`, placeData),
      'Update place'
    );
  }

  async deletePlace(id: string): Promise<ApiResponse<null>> {
    return this.safeRequest(
      () => apiClient.delete(`/places/${id}`),
      'Delete place'
    );
  }

  // Plantations endpoints
  async getPlantations(page: number = 1, limit: number = 10): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/plantations?page=${page}&limit=${limit}`),
      'Get plantations'
    );
  }

  async getPlantation(id: string): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/plantations/${id}`),
      'Get plantation'
    );
  }

  async createPlantation(plantationData: any): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.post('/plantations', plantationData),
      'Create plantation'
    );
  }

  async updatePlantation(id: string, plantationData: any): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.put(`/plantations/${id}`, plantationData),
      'Update plantation'
    );
  }

  async deletePlantation(id: string): Promise<ApiResponse<null>> {
    return this.safeRequest(
      () => apiClient.delete(`/plantations/${id}`),
      'Delete plantation'
    );
  }

  // Batches endpoints
  async getBatches(page: number = 1, limit: number = 10): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/batches?page=${page}&limit=${limit}`),
      'Get batches'
    );
  }

  async getBatch(id: string): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/batches/${id}`),
      'Get batch'
    );
  }

  async createBatch(batchData: any): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.post('/batches', batchData),
      'Create batch'
    );
  }

  async updateBatch(id: string, batchData: any): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.put(`/batches/${id}`, batchData),
      'Update batch'
    );
  }

  async deleteBatch(id: string): Promise<ApiResponse<null>> {
    return this.safeRequest(
      () => apiClient.delete(`/batches/${id}`),
      'Delete batch'
    );
  }

  // Dispatches endpoints
  async getDispatches(page: number = 1, limit: number = 10): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/dispatches?page=${page}&limit=${limit}`),
      'Get dispatches'
    );
  }

  async getDispatch(id: string): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/dispatches/${id}`),
      'Get dispatch'
    );
  }

  async createDispatch(dispatchData: any): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.post('/dispatches', dispatchData),
      'Create dispatch'
    );
  }

  async updateDispatch(id: string, dispatchData: any): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.put(`/dispatches/${id}`, dispatchData),
      'Update dispatch'
    );
  }

  async deleteDispatch(id: string): Promise<ApiResponse<null>> {
    return this.safeRequest(
      () => apiClient.delete(`/dispatches/${id}`),
      'Delete dispatch'
    );
  }

  // File upload with progress tracking
  async uploadFile(file: any, type: 'image' | 'document' = 'image'): Promise<ApiResponse<{ url: string }>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);

    return this.safeRequest(
      () => apiClient.post('/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 60000, // 60 second timeout for file uploads
      }),
      'File upload'
    );
  }

  // Search endpoints
  async searchPlaces(query: string): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/places/search?q=${encodeURIComponent(query)}`),
      'Search places'
    );
  }

  async searchPlantations(query: string): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/plantations/search?q=${encodeURIComponent(query)}`),
      'Search plantations'
    );
  }

  // Analytics endpoints
  async getAnalytics(timeRange: string = '7d'): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get(`/analytics?timeRange=${timeRange}`),
      'Get analytics'
    );
  }

  async getDashboardStats(): Promise<ApiResponse<any>> {
    return this.safeRequest(
      () => apiClient.get('/dashboard/stats'),
      'Get dashboard stats'
    );
  }

  // Generic request method
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    url: string,
    data?: any,
    config?: any
  ): Promise<ApiResponse<T>> {
    return this.safeRequest(
      () => apiClient.request({
        method,
        url,
        data,
        ...config,
      }),
      `${method} ${url}`
    );
  }
}

// Export singleton instance
export const apiService = new ApiService();
export { apiClient }; 