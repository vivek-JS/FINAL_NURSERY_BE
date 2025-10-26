// utils/cloudinaryUtils.js
import cloudinary from '../config/cloudinary.js';

/**
 * Upload image buffer to Cloudinary
 * @param {Buffer} buffer - Image buffer
 * @param {string} folder - Cloudinary folder (optional)
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} - Cloudinary upload result
 */
export const uploadImageToCloudinary = async (buffer, folder = 'nursery-orders', options = {}) => {
  try {
    const uploadOptions = {
      folder,
      resource_type: 'auto',
      quality: 'auto',
      fetch_format: 'auto',
      ...options
    };

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(buffer);
    });

    return {
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes
    };
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Upload multiple images to Cloudinary
 * @param {Buffer[]} buffers - Array of image buffers
 * @param {string} folder - Cloudinary folder (optional)
 * @returns {Promise<Object[]>} - Array of upload results
 */
export const uploadMultipleImagesToCloudinary = async (buffers, folder = 'nursery-orders') => {
  try {
    const uploadPromises = buffers.map(buffer => 
      uploadImageToCloudinary(buffer, folder)
    );
    
    const results = await Promise.all(uploadPromises);
    return results;
  } catch (error) {
    console.error('Multiple images upload error:', error);
    return [];
  }
};

/**
 * Delete image from Cloudinary
 * @param {string} publicId - Cloudinary public ID
 * @returns {Promise<Object>} - Deletion result
 */
export const deleteImageFromCloudinary = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return {
      success: result.result === 'ok',
      result: result.result
    };
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Get optimized image URL with transformations
 * @param {string} publicId - Cloudinary public ID
 * @param {Object} transformations - Image transformations
 * @returns {string} - Optimized image URL
 */
export const getOptimizedImageUrl = (publicId, transformations = {}) => {
  const defaultTransformations = {
    quality: 'auto',
    fetch_format: 'auto',
    ...transformations
  };
  
  return cloudinary.url(publicId, defaultTransformations);
};

/**
 * Extract public ID from Cloudinary URL
 * @param {string} url - Cloudinary URL
 * @returns {string|null} - Public ID or null
 */
export const extractPublicIdFromUrl = (url) => {
  if (!url || !url.includes('cloudinary.com')) return null;
  
  const parts = url.split('/');
  const filename = parts[parts.length - 1];
  const publicId = filename.split('.')[0];
  
  return publicId;
};
