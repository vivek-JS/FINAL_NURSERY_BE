const axios = require('axios');

const getToken = async () => {
  try {
    console.log('🔐 Getting JWT token...');
    
    const response = await axios.post('http://localhost:8000/api/v1/user/login', {
      phoneNumber: '7588686452',
      password: 'passsword123443'
    });

    console.log('✅ Token received:', response.data.data.accessToken);
    return response.data.data.accessToken;
    
  } catch (error) {
    console.error('❌ Error getting token:', error.response?.data || error.message);
    return null;
  }
};

getToken(); 