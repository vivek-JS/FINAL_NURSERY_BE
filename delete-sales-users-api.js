import axios from 'axios';

const BASE_URL = 'http://localhost:8000/api/v1';

// Super Admin credentials
const SUPER_ADMIN_CREDENTIALS = {
  phoneNumber: 7588686452,
  password: 'passsword123443'
};

// Function to get access token
async function getAccessToken() {
  try {
    console.log('🔐 Logging in as Super Admin...');
    const response = await axios.post(`${BASE_URL}/user/login`, SUPER_ADMIN_CREDENTIALS);
    
    if (response.data.status === 'Success') {
      const accessToken = response.data.data.accessToken;
      console.log('✅ Login successful, access token obtained');
      return accessToken;
    } else {
      throw new Error('Login failed: ' + response.data.message);
    }
  } catch (error) {
    console.error('❌ Login error:', error.response?.data || error.message);
    throw error;
  }
}

// Function to get all users
async function getAllUsers(accessToken) {
  try {
    console.log('📋 Fetching all users...');
    const response = await axios.get(`${BASE_URL}/user/allusers`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (response.data.success) {
      console.log(`✅ Found ${response.data.data.length} total users`);
      return response.data.data;
    } else {
      throw new Error('Failed to fetch users: ' + response.data.message);
    }
  } catch (error) {
    console.error('❌ Error fetching users:', error.response?.data || error.message);
    throw error;
  }
}

// Function to delete a user
async function deleteUser(userId, accessToken) {
  try {
    const response = await axios.delete(`${BASE_URL}/user/deleteUser`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      data: {
        id: userId
      }
    });
    
    if (response.data.status === 'Success') {
      return true;
    } else {
      throw new Error('Delete failed: ' + response.data.message);
    }
  } catch (error) {
    console.error(`❌ Error deleting user ${userId}:`, error.response?.data || error.message);
    return false;
  }
}

// Main function to delete sales users
async function deleteSalesUsers() {
  try {
    console.log('🚀 Starting sales users deletion process...');
    
    // Get access token
    const accessToken = await getAccessToken();
    
    // Get all users
    const allUsers = await getAllUsers(accessToken);
    
    // Filter sales users
    const salesUsers = allUsers.filter(user => user.jobTitle === 'SALES');
    
    if (salesUsers.length === 0) {
      console.log('✅ No users with SALES job title found');
      return;
    }
    
    console.log(`📊 Found ${salesUsers.length} users with SALES job title:`);
    console.log('');
    
    // Display users that will be deleted
    salesUsers.forEach((user, index) => {
      console.log(`${index + 1}. ${user.name} (${user.phoneNumber}) - ${user.role}`);
    });
    
    console.log('');
    console.log('⚠️  WARNING: This action cannot be undone!');
    console.log('Proceeding with deletion...');
    console.log('');
    
    // Delete each sales user
    let deletedCount = 0;
    let failedCount = 0;
    
    for (const user of salesUsers) {
      console.log(`🗑️  Deleting user: ${user.name} (${user.phoneNumber})...`);
      
      const success = await deleteUser(user._id, accessToken);
      
      if (success) {
        console.log(`✅ Successfully deleted: ${user.name}`);
        deletedCount++;
      } else {
        console.log(`❌ Failed to delete: ${user.name}`);
        failedCount++;
      }
    }
    
    console.log('');
    console.log('📋 Deletion Summary:');
    console.log(`✅ Successfully deleted: ${deletedCount} users`);
    console.log(`❌ Failed to delete: ${failedCount} users`);
    
    // Verify deletion by fetching users again
    console.log('');
    console.log('🔍 Verifying deletion...');
    const remainingUsers = await getAllUsers(accessToken);
    const remainingSalesUsers = remainingUsers.filter(user => user.jobTitle === 'SALES');
    console.log(`📊 Remaining users with SALES job title: ${remainingSalesUsers.length}`);
    
    if (remainingSalesUsers.length === 0) {
      console.log('✅ All sales users have been successfully deleted!');
    } else {
      console.log('⚠️  Some sales users may still exist');
      remainingSalesUsers.forEach(user => {
        console.log(`   - ${user.name} (${user.phoneNumber})`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error in deletion process:', error.message);
  }
}

// Run the script
deleteSalesUsers(); 