import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Package, Clock, CheckCircle, AlertCircle } from 'lucide-react-native';

export default function Dispatched() {
  const [filter, setFilter] = useState('all');

  const dispatches = [
    {
      id: 'D001',
      destination: 'Mumbai Garden Center',
      items: 25,
      status: 'delivered',
      date: '2024-01-15',
      value: '$1,250',
    },
    {
      id: 'D002',
      destination: 'Delhi Nursery Co.',
      items: 50,
      status: 'in_transit',
      date: '2024-01-14',
      value: '$2,400',
    },
    {
      id: 'D003',
      destination: 'Bangalore Plants',
      items: 35,
      status: 'pending',
      date: '2024-01-13',
      value: '$1,800',
    },
    {
      id: 'D004',
      destination: 'Chennai Green Hub',
      items: 15,
      status: 'cancelled',
      date: '2024-01-12',
      value: '$750',
    },
  ];

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'delivered':
        return <CheckCircle size={20} color="#10B981" />;
      case 'in_transit':
        return <Package size={20} color="#F59E0B" />;
      case 'pending':
        return <Clock size={20} color="#6B7280" />;
      case 'cancelled':
        return <AlertCircle size={20} color="#EF4444" />;
      default:
        return <Package size={20} color="#6B7280" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'delivered':
        return '#10B981';
      case 'in_transit':
        return '#F59E0B';
      case 'pending':
        return '#6B7280';
      case 'cancelled':
        return '#EF4444';
      default:
        return '#6B7280';
    }
  };

  const filters = ['all', 'delivered', 'in_transit', 'pending', 'cancelled'];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Dispatched Orders</Text>
        <Text style={styles.subtitle}>Track your dispatch orders</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterContainer}>
        {filters.map((filterOption) => (
          <TouchableOpacity
            key={filterOption}
            style={[
              styles.filterButton,
              filter === filterOption && styles.activeFilterButton,
            ]}
            onPress={() => setFilter(filterOption)}
          >
            <Text
              style={[
                styles.filterText,
                filter === filterOption && styles.activeFilterText,
              ]}
            >
              {filterOption.charAt(0).toUpperCase() + filterOption.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView style={styles.listContainer} showsVerticalScrollIndicator={false}>
        {dispatches.map((dispatch) => (
          <TouchableOpacity key={dispatch.id} style={styles.dispatchCard}>
            <View style={styles.cardHeader}>
              <View style={styles.dispatchInfo}>
                <Text style={styles.dispatchId}>{dispatch.id}</Text>
                <Text style={styles.destination}>{dispatch.destination}</Text>
              </View>
              <View style={styles.statusContainer}>
                {getStatusIcon(dispatch.status)}
                <Text style={[styles.statusText, { color: getStatusColor(dispatch.status) }]}>
                  {dispatch.status.replace('_', ' ')}
                </Text>
              </View>
            </View>
            
            <View style={styles.cardDetails}>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Items:</Text>
                <Text style={styles.detailValue}>{dispatch.items}</Text>
              </View>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Value:</Text>
                <Text style={styles.detailValue}>{dispatch.value}</Text>
              </View>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Date:</Text>
                <Text style={styles.detailValue}>{dispatch.date}</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}
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
    paddingBottom: 20,
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
  filterContainer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: '#FFFFFF',
  },
  filterButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 12,
    backgroundColor: '#F3F4F6',
  },
  activeFilterButton: {
    backgroundColor: '#3B82F6',
  },
  filterText: {
    fontSize: 14,
    fontFamily: 'Poppins-Medium',
    color: '#6B7280',
  },
  activeFilterText: {
    color: '#FFFFFF',
  },
  listContainer: {
    flex: 1,
    padding: 20,
  },
  dispatchCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  dispatchInfo: {
    flex: 1,
  },
  dispatchId: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    color: '#1F2937',
    marginBottom: 4,
  },
  destination: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    color: '#6B7280',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusText: {
    fontSize: 12,
    fontFamily: 'Poppins-Medium',
    textTransform: 'capitalize',
  },
  cardDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  detailItem: {
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 12,
    fontFamily: 'Poppins-Regular',
    color: '#6B7280',
    marginBottom: 2,
  },
  detailValue: {
    fontSize: 14,
    fontFamily: 'Poppins-SemiBold',
    color: '#1F2937',
  },
}); 