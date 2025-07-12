import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { API_CONFIG } from '../lib/api/config';

const ApiTest: React.FC = () => {
  const [apiStatus, setApiStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [apiResponse, setApiResponse] = useState<string>('');

  const testApiConnection = async () => {
    try {
      setApiStatus('loading');
      
      // Test the base API endpoint
      const response = await fetch(`${API_CONFIG.BASE_URL.replace('/api/v1', '')}`);
      const data = await response.json();
      
      setApiResponse(JSON.stringify(data, null, 2));
      setApiStatus('success');
    } catch (error) {
      console.error('API Test Error:', error);
      setApiResponse(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setApiStatus('error');
    }
  };

  useEffect(() => {
    testApiConnection();
  }, []);

  const showDetails = () => {
    Alert.alert(
      'API Details',
      `Current API URL: ${API_CONFIG.BASE_URL}\n\nResponse: ${apiResponse}`,
      [{ text: 'OK' }]
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>API Connection Test</Text>
      
      <Text style={styles.url}>
        URL: {API_CONFIG.BASE_URL}
      </Text>
      
      <View style={[styles.status, styles[apiStatus]]}>
        <Text style={styles.statusText}>
          Status: {apiStatus.toUpperCase()}
        </Text>
      </View>
      
      <TouchableOpacity style={styles.button} onPress={testApiConnection}>
        <Text style={styles.buttonText}>Test Connection</Text>
      </TouchableOpacity>
      
      <TouchableOpacity style={styles.detailsButton} onPress={showDetails}>
        <Text style={styles.detailsButtonText}>Show Details</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: '#f8f9fa',
    borderRadius: 10,
    margin: 20,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  url: {
    fontSize: 12,
    color: '#666',
    marginBottom: 10,
    fontFamily: 'monospace',
  },
  status: {
    padding: 10,
    borderRadius: 5,
    marginBottom: 10,
  },
  loading: {
    backgroundColor: '#fff3cd',
  },
  success: {
    backgroundColor: '#d4edda',
  },
  error: {
    backgroundColor: '#f8d7da',
  },
  statusText: {
    fontSize: 14,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#007bff',
    padding: 10,
    borderRadius: 5,
    marginBottom: 10,
  },
  buttonText: {
    color: '#fff',
    textAlign: 'center',
    fontWeight: 'bold',
  },
  detailsButton: {
    backgroundColor: '#6c757d',
    padding: 10,
    borderRadius: 5,
  },
  detailsButtonText: {
    color: '#fff',
    textAlign: 'center',
  },
});

export default ApiTest; 