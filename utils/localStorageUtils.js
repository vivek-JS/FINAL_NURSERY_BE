// utils/localStorageUtils.js
// Local disk storage replacement for Cloudinary
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

const getBaseUrl = () =>
  (process.env.BASE_URL || 'http://167.71.232.6').replace(/\/$/, '');

/**
 * Upload image/file buffer to local disk
 * @param {Buffer} buffer - File buffer
 * @param {string} folder - Sub-folder under uploads/ (mirrors Cloudinary folder)
 * @param {Object} options - { mimetype } optional
 * @returns {Promise<Object>} - Result with url, publicId, format, bytes, success
 */
export const uploadImageToLocalStorage = async (buffer, folder = 'nursery-orders', options = {}) => {
  try {
    const ext = (options.mimetype && MIME_TO_EXT[options.mimetype]) || 'jpg';
    const filename = `${randomUUID()}.${ext}`;
    const relativeDir = folder;
    const absoluteDir = path.join(UPLOADS_ROOT, relativeDir);

    fs.mkdirSync(absoluteDir, { recursive: true });

    const absolutePath = path.join(absoluteDir, filename);
    fs.writeFileSync(absolutePath, buffer);

    const publicId = `${relativeDir}/${filename}`;
    const url = `${getBaseUrl()}/uploads/${publicId}`;

    return {
      success: true,
      url,
      publicId,
      format: ext,
      bytes: buffer.length,
      width: null,
      height: null,
    };
  } catch (error) {
    console.error('Local storage upload error:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Upload multiple file buffers to local disk
 * @param {Buffer[]} buffers - Array of file buffers
 * @param {string} folder - Sub-folder under uploads/
 * @returns {Promise<Object[]>} - Array of upload results
 */
export const uploadMultipleImagesToLocalStorage = async (buffers, folder = 'nursery-orders') => {
  try {
    const results = await Promise.all(
      buffers.map(buffer => uploadImageToLocalStorage(buffer, folder))
    );
    return results;
  } catch (error) {
    console.error('Multiple images upload error:', error);
    return [];
  }
};

/**
 * Delete a file from local disk by its publicId (relative path)
 * @param {string} publicId - Relative path like "nursery-images/uuid.jpg"
 * @returns {Promise<Object>} - Deletion result
 */
export const deleteImageFromLocalStorage = async (publicId) => {
  try {
    const absolutePath = path.join(UPLOADS_ROOT, publicId);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
    return { success: true };
  } catch (error) {
    console.error('Local storage delete error:', error);
    return { success: false, error: error.message };
  }
};
