import moment from 'moment';

// Validation Utils
export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export const validatePassword = (password: string): boolean => {
  return password.length > 0;
};

export const validateRequired = (value: string): boolean => {
  return value.trim().length > 0;
};

export const validateNumeric = (value: string): boolean => {
  return !isNaN(Number(value)) && Number(value) >= 0;
};

export const validatePhoneNumber = (phone: string): boolean => {
  const phoneRegex = /^\+?[\d\s-()]{10,}$/;
  return phoneRegex.test(phone);
};

// Form Validation
export interface ValidationErrors {
  [key: string]: string;
}

export const validateLoginForm = (phoneNumber: string, password: string): ValidationErrors => {
  const errors: ValidationErrors = {};
  
  if (!validateRequired(phoneNumber)) {
    errors.phoneNumber = 'Phone number is required';
  } else if (!validatePhoneNumber(phoneNumber)) {
    errors.phoneNumber = 'Please enter a valid phone number';
  }
  
  if (!validateRequired(password)) {
    errors.password = 'Password is required';
  } else if (!validatePassword(password)) {
    errors.password = 'Password cannot be empty';
  }
  
  return errors;
};

export const validateRegistrationForm = (
  username: string,
  email: string,
  password: string,
  confirmPassword: string
): ValidationErrors => {
  const errors: ValidationErrors = {};
  
  if (!validateRequired(username)) {
    errors.username = 'Username is required';
  } else if (username.length < 3) {
    errors.username = 'Username must be at least 3 characters long';
  }
  
  if (!validateRequired(email)) {
    errors.email = 'Email is required';
  } else if (!validateEmail(email)) {
    errors.email = 'Please enter a valid email address';
  }
  
  if (!validateRequired(password)) {
    errors.password = 'Password is required';
  } else if (!validatePassword(password)) {
    errors.password = 'Password cannot be empty';
  }
  
  if (!validateRequired(confirmPassword)) {
    errors.confirmPassword = 'Please confirm your password';
  } else if (password !== confirmPassword) {
    errors.confirmPassword = 'Passwords do not match';
  }
  
  return errors;
};

// Date Utils
export const formatDate = (date: string | Date): string => {
  return moment(date).format('MMM DD, YYYY');
};

export const formatDateTime = (date: string | Date): string => {
  return moment(date).format('MMM DD, YYYY h:mm A');
};

export const getRelativeTime = (date: string | Date): string => {
  return moment(date).fromNow();
};

export const isDateInPast = (date: string | Date): boolean => {
  return moment(date).isBefore(moment());
};

export const isDateToday = (date: string | Date): boolean => {
  return moment(date).isSame(moment(), 'day');
};

export const addDays = (date: string | Date, days: number): string => {
  return moment(date).add(days, 'days').toISOString();
};

// Number Utils
export const formatNumber = (num: number): string => {
  return num.toLocaleString();
};

export const formatCurrency = (amount: number, currency: string = 'USD'): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
};

export const calculatePercentage = (value: number, total: number): number => {
  if (total === 0) return 0;
  return Math.round((value / total) * 100);
};

// String Utils
export const capitalize = (str: string): string => {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
};

export const generateId = (): string => {
  return Math.random().toString(36).substr(2, 9);
};

export const generateBatchNumber = (): string => {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.random().toString(36).substr(2, 4).toUpperCase();
  return `B${timestamp}${random}`;
};

export const generateDispatchNumber = (): string => {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.random().toString(36).substr(2, 4).toUpperCase();
  return `D${timestamp}${random}`;
};

// Status Utils
export const getStatusColor = (status: string): string => {
  switch (status.toLowerCase()) {
    case 'active':
    case 'planted':
    case 'delivered':
    case 'completed':
      return '#10B981'; // green
    case 'pending':
    case 'growing':
    case 'in_transit':
      return '#F59E0B'; // yellow
    case 'ready':
      return '#3B82F6'; // blue
    case 'cancelled':
    case 'inactive':
      return '#EF4444'; // red
    default:
      return '#6B7280'; // gray
  }
};

export const getStatusText = (status: string): string => {
  return status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
};

// Array Utils
export const sortByDate = <T>(
  array: T[],
  dateField: keyof T,
  direction: 'asc' | 'desc' = 'desc'
): T[] => {
  return [...array].sort((a, b) => {
    const dateA = moment(a[dateField] as string);
    const dateB = moment(b[dateField] as string);
    
    if (direction === 'asc') {
      return dateA.isBefore(dateB) ? -1 : 1;
    } else {
      return dateA.isAfter(dateB) ? -1 : 1;
    }
  });
};

export const groupByField = <T>(
  array: T[],
  field: keyof T
): { [key: string]: T[] } => {
  return array.reduce((groups, item) => {
    const key = String(item[field]);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
    return groups;
  }, {} as { [key: string]: T[] });
};

// Device Utils
export const isIOS = (): boolean => {
  return require('react-native').Platform.OS === 'ios';
};

export const isAndroid = (): boolean => {
  return require('react-native').Platform.OS === 'android';
};

// Error Utils
export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unexpected error occurred';
};

export const handleApiError = (error: any): string => {
  if (error.response?.data?.message) {
    return error.response.data.message;
  }
  if (error.message) {
    return error.message;
  }
  return 'Network error. Please try again.';
}; 