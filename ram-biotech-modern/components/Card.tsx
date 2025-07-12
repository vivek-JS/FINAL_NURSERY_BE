import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';

interface CardProps {
  title: string;
  subtitle?: string;
  content?: string;
  imageUrl?: string;
  onPress?: () => void;
  children?: React.ReactNode;
  style?: any;
  variant?: 'default' | 'outlined' | 'elevated';
}

const Card: React.FC<CardProps> = ({
  title,
  subtitle,
  content,
  imageUrl,
  onPress,
  children,
  style,
  variant = 'default',
}) => {
  const cardStyles = [
    styles.card,
    styles[variant],
    style,
  ];

  const CardContent = () => (
    <View style={cardStyles}>
      {imageUrl && (
        <Image source={{ uri: imageUrl }} style={styles.image} />
      )}
      
      <View style={styles.content}>
        <Text style={styles.title}>{title}</Text>
        
        {subtitle && (
          <Text style={styles.subtitle}>{subtitle}</Text>
        )}
        
        {content && (
          <Text style={styles.description}>{content}</Text>
        )}
        
        {children}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        <CardContent />
      </TouchableOpacity>
    );
  }

  return <CardContent />;
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 16,
  },
  
  // Variants
  default: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  outlined: {
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#D1D5DB',
  },
  elevated: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 3.84,
    elevation: 5,
  },
  
  image: {
    width: '100%',
    height: 160,
    resizeMode: 'cover',
  },
  
  content: {
    padding: 16,
  },
  
  title: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    color: '#1F2937',
    marginBottom: 4,
  },
  
  subtitle: {
    fontSize: 14,
    fontFamily: 'Poppins-Medium',
    color: '#6B7280',
    marginBottom: 8,
  },
  
  description: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    color: '#4B5563',
    lineHeight: 20,
  },
});

export default Card; 