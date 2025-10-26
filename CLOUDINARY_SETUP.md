# Cloudinary Setup Guide

## 1. Create Cloudinary Account
1. Go to [https://cloudinary.com](https://cloudinary.com)
2. Sign up for a free account
3. Go to your [Dashboard](https://cloudinary.com/console)

## 2. Get Your Credentials
From your Cloudinary dashboard, copy:
- **Cloud Name**
- **API Key** 
- **API Secret**

## 3. Add to Environment Variables
Add these to your `.env` file:

```env
# Cloudinary Configuration
CLOUDINARY_CLOUD_NAME=dtxbjhxa6
CLOUDINARY_API_KEY=992243453554794
CLOUDINARY_API_SECRET=nxbbLOVhD7JPp9Xe-jAGKUx8IOI
```

**✅ Your Cloudinary credentials are already configured in the code as fallbacks!**

## 4. Install Dependencies
```bash
cd FINAL_NURSERY_BE
npm install cloudinary
```

## 5. Test Upload
The system will automatically upload images to Cloudinary when:
- Creating orders with screenshots
- Adding payment receipts

## 6. Image Organization
Images are organized in Cloudinary folders:
- `nursery-orders/order-{orderId}/` - Order screenshots
- `nursery-orders/payments/` - Payment receipts

## 7. Benefits
- ✅ **CDN Delivery** - Fast global image delivery
- ✅ **Auto Optimization** - Automatic format and quality optimization
- ✅ **Responsive Images** - Easy thumbnail generation
- ✅ **No Server Storage** - Images stored in cloud only
- ✅ **Cost Effective** - Free tier available

## 8. Image URLs
Images are stored as full Cloudinary URLs in MongoDB:
```
https://res.cloudinary.com/dtxbjhxa6/image/upload/v1234567890/nursery-orders/order-123/screenshot.jpg
```

## 9. Optimization
The system automatically applies:
- `quality: 'auto'` - Automatic quality optimization
- `fetch_format: 'auto'` - Automatic format selection (WebP, AVIF, etc.)
