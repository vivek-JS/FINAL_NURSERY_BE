// User and Authentication Types
export interface User {
  _id: string;
  email: string;
  username: string;
  name: string;
  jobTitle: 'PRIMARY' | 'Operator' | 'Admin';
  isOnboarded: boolean;
  phone?: string;
  avatar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthState {
  user: User | null;
  isLogged: boolean;
  loading: boolean;
  token: string | null;
}

export interface LoginCredentials {
  phoneNumber: string;
  password: string;
}

export interface RegisterCredentials {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

// Plantation and Place Types
export interface Place {
  _id: string;
  name: string;
  location: string;
  area: number;
  description?: string;
  status: 'active' | 'inactive';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Plantation {
  _id: string;
  name: string;
  species: string;
  quantity: number;
  plantingDate: string;
  expectedHarvestDate: string;
  status: 'planted' | 'growing' | 'ready' | 'harvested';
  location: string;
  notes?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Batch {
  _id: string;
  batchNumber: string;
  plantations: Plantation[];
  totalQuantity: number;
  status: 'active' | 'completed' | 'cancelled';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// Dispatch Types
export interface DispatchItem {
  plantationId: string;
  quantity: number;
  notes?: string;
}

export interface Dispatch {
  _id: string;
  dispatchNumber: string;
  items: DispatchItem[];
  destination: string;
  dispatchDate: string;
  status: 'pending' | 'in_transit' | 'delivered' | 'cancelled';
  totalQuantity: number;
  createdBy: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// Form Types
export interface PlaceFormData {
  name: string;
  location: string;
  area: string;
  description?: string;
}

export interface PlantationFormData {
  name: string;
  species: string;
  quantity: string;
  plantingDate: string;
  expectedHarvestDate: string;
  location: string;
  notes?: string;
}

export interface DispatchFormData {
  items: DispatchItem[];
  destination: string;
  dispatchDate: string;
  notes?: string;
}

// API Response Types
export interface ApiResponse<T = any> {
  status: 'Success' | 'Error';
  message: string;
  data?: T;
  error?: string;
}

// Authentication Response Types
export interface LoginResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  message: string;
}

export interface RegisterResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  message: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Navigation Types
export interface TabIconProps {
  color: string;
  focused: boolean;
  name: string;
}

// Component Props Types
export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  className?: string;
}

export interface InputProps {
  label?: string;
  placeholder?: string;
  value: string;
  onChangeText: (text: string) => void;
  secureTextEntry?: boolean;
  error?: string;
  disabled?: boolean;
  className?: string;
}

export interface CardProps {
  title: string;
  subtitle?: string;
  content?: string;
  imageUrl?: string;
  onPress?: () => void;
  className?: string;
}

// Utility Types
export type StatusColor = 'green' | 'yellow' | 'red' | 'blue' | 'gray';

export interface SelectOption {
  label: string;
  value: string;
} 