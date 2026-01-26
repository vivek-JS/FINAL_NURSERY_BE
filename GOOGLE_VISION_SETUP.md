# Google Cloud Vision OCR Setup

## Overview
The OCR functionality now uses Google Cloud Vision API for better accuracy in extracting payment information from receipts and cheques.

## Setup Steps

### 1. Get Google Cloud Vision API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Cloud Vision API**:
   - Navigate to "APIs & Services" > "Library"
   - Search for "Cloud Vision API"
   - Click "Enable"

### 2. Create API Key

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "API Key"
3. Copy the API key
4. (Optional) Restrict the API key to Cloud Vision API only for security

### 3. Add to Environment Variables

Add the API key to your `.env` file:

```env
# Google Cloud Vision API
GOOGLE_CLOUD_VISION_API_KEY=your_api_key_here
GOOGLE_CLOUD_PROJECT_ID=your_project_id_here
```

### Alternative: Use Service Account (Recommended for Production)

1. Go to "IAM & Admin" > "Service Accounts"
2. Create a new service account
3. Grant it "Cloud Vision API User" role
4. Create and download a JSON key file
5. Set environment variable:

```env
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
GOOGLE_CLOUD_PROJECT_ID=your_project_id_here
```

## Pricing

- **Free Tier**: ~1,000 images/month
- **After Free Tier**: ~$1.50 per 1,000 images

## Fallback

If Google Cloud Vision API is not configured or fails, the system automatically falls back to Tesseract.js (free, but less accurate).

## Testing

Once configured, test with:
```bash
curl 'http://localhost:8000/api/v1/user/media/ocr' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  --data-raw '{"imageUrl":"YOUR_IMAGE_URL"}'
```

## Security Notes

⚠️ **Never expose API keys in frontend code**
- API keys are stored in backend environment variables only
- All OCR processing happens on the backend
- The frontend only sends the image URL to the backend
