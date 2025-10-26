// config/cloudinary.js
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

dotenv.config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dtxbjhxa6',
  api_key: process.env.CLOUDINARY_API_KEY || '992243453554794',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'nxbbLOVhD7JPp9Xe-jAGKUx8IOI',
});

export default cloudinary;
