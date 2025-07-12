import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MapPin, Sprout, Truck, FileText, Plus, Settings } from 'lucide-react-native';

export default function Create() {
  const createOptions = [
    {
      title: 'Add Place',
      description: 'Create a new location for your nursery',
      icon: MapPin,
      color: '#10B981',
    },
    {
      title: 'New Plantation',
      description: 'Start a new plantation project',
      icon: Sprout,
      color: '#3B82F6',
    },
    {
      title: 'Create Dispatch',
      description: 'Prepare plants for dispatch',
      icon: Truck,
      color: '#F59E0B',
    },
    {
      title: 'Generate Report',
      description: 'Create performance reports',
      icon: FileText,
      color: '#EF4444',
    },
    {
      title: 'Add Batch',
      description: 'Create a new batch of plants',
      icon: Plus,
      color: '#8B5CF6',
    },
    {
      title: 'Manage Settings',
      description: 'Configure app settings',
      icon: Settings,
      color: '#6B7280',
    },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.title}>Create New</Text>
          <Text style={styles.subtitle}>Choose what you want to create</Text>
        </View>

        <View style={styles.grid}>
          {createOptions.map((option, index) => (
            <TouchableOpacity
              key={index}
              style={[styles.optionCard, { borderLeftColor: option.color }]}
              activeOpacity={0.7}
            >
              <View style={[styles.iconContainer, { backgroundColor: option.color }]}>
                <option.icon size={24} color="#FFFFFF" />
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle}>{option.title}</Text>
                <Text style={styles.optionDescription}>{option.description}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 30,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 28,
    fontFamily: 'Poppins-Bold',
    color: '#1F2937',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    fontFamily: 'Poppins-Regular',
    color: '#6B7280',
  },
  grid: {
    padding: 20,
    gap: 16,
  },
  optionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  optionContent: {
    flex: 1,
  },
  optionTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    color: '#1F2937',
    marginBottom: 4,
  },
  optionDescription: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    color: '#6B7280',
  },
}); 