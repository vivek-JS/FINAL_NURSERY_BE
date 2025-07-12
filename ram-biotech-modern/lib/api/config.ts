// API Configuration for different environments
export const API_CONFIG = {
  // Production URL - Always use live backend
  PRODUCTION_URL: 'https://final-nursery-be-1.onrender.com/api/v1',
  
  // Development URL - Local backend (if needed for testing)
  DEVELOPMENT_URL: 'http://10.0.2.2:8000/api/v1', // Android emulator localhost
  
  // Current active URL - Set to production for live app
  BASE_URL: 'https://final-nursery-be-1.onrender.com/api/v1',
  
  // Timeout settings
  TIMEOUT: 15000,
  
  // Headers
  HEADERS: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
};

// Export the active configuration
export const getApiConfig = () => ({
  baseURL: API_CONFIG.BASE_URL,
  timeout: API_CONFIG.TIMEOUT,
  headers: API_CONFIG.HEADERS,
});

console.log('🌐 API Config loaded:', { baseURL: API_CONFIG.BASE_URL }); 