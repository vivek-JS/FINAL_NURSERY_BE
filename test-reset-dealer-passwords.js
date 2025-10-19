#!/usr/bin/env node

/**
 * Test script for Reset All Dealer Passwords feature
 * 
 * This script tests the reset-all-dealer-passwords endpoint
 * Run this after logging in to get a valid token
 */

import axios from 'axios';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000/api/v1';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const testResetDealerPasswords = async () => {
  console.log('🔐 Reset All Dealer Passwords - Test Script\n');
  console.log('═══════════════════════════════════════════════════\n');

  try {
    // Get admin credentials
    const phoneNumber = await question('Enter Admin Phone Number: ');
    const password = await question('Enter Admin Password: ');
    
    console.log('\n📱 Logging in as admin...');
    
    // Login to get token
    const loginResponse = await axios.post(`${API_BASE_URL}/user/login`, {
      phoneNumber: phoneNumber.trim(),
      password: password.trim()
    });

    if (!loginResponse.data.success) {
      console.error('❌ Login failed:', loginResponse.data.message);
      rl.close();
      return;
    }

    const token = loginResponse.data.accessToken;
    const user = loginResponse.data.user;
    
    console.log('✅ Login successful!');
    console.log(`👤 User: ${user.name}`);
    console.log(`🎭 Role: ${user.role}`);
    console.log(`💼 Job Title: ${user.jobTitle}\n`);

    // Check if user is admin
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      console.error('❌ Error: User must be SUPER_ADMIN or ADMIN to reset dealer passwords');
      console.error(`   Current role: ${user.role}`);
      rl.close();
      return;
    }

    // Confirm action
    const confirm = await question('\n⚠️  This will reset ALL dealer passwords to "1234". Continue? (yes/no): ');
    
    if (confirm.toLowerCase() !== 'yes') {
      console.log('❌ Operation cancelled by user');
      rl.close();
      return;
    }

    console.log('\n🔄 Resetting all dealer passwords...\n');

    // Call the reset endpoint
    const resetResponse = await axios.post(
      `${API_BASE_URL}/user/reset-all-dealer-passwords`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (resetResponse.data.success) {
      console.log('✅ SUCCESS!\n');
      console.log('═══════════════════════════════════════════════════');
      console.log(`📊 Dealers affected: ${resetResponse.data.count}`);
      console.log('🔐 New password: 1234');
      console.log('🔄 Force password change: YES\n');
      
      if (resetResponse.data.dealers && resetResponse.data.dealers.length > 0) {
        console.log('📋 Affected Dealers:');
        console.log('───────────────────────────────────────────────────\n');
        resetResponse.data.dealers.forEach((dealer, index) => {
          console.log(`${index + 1}. ${dealer.name}`);
          console.log(`   Phone: ${dealer.phoneNumber}`);
          console.log(`   ID: ${dealer.id}\n`);
        });
      }
      console.log('═══════════════════════════════════════════════════\n');
      console.log('✨ All dealers will be prompted to change their password on next login.');
    } else {
      console.error('❌ Failed to reset passwords:', resetResponse.data.message);
    }

  } catch (error) {
    console.error('\n❌ Error occurred:\n');
    
    if (error.response) {
      // Server responded with error
      console.error('Status:', error.response.status);
      console.error('Message:', error.response.data.message || error.response.data);
      
      if (error.response.status === 403) {
        console.error('\n⚠️  Access Denied: Only Super Admin or Admin can reset dealer passwords');
      } else if (error.response.status === 401) {
        console.error('\n⚠️  Authentication Failed: Invalid or expired token');
      } else if (error.response.status === 404) {
        console.error('\n⚠️  No active dealers found in the system');
      }
    } else if (error.request) {
      // Request made but no response
      console.error('Network Error: Could not connect to server');
      console.error('Make sure the backend server is running at:', API_BASE_URL);
    } else {
      // Other errors
      console.error('Error:', error.message);
    }
  } finally {
    rl.close();
  }
};

// Run the test
testResetDealerPasswords();

