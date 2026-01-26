# PaddleOCR Setup Guide

## Overview
PaddleOCR provides better accuracy than Tesseract for receipts and cheques. It's open-source and free.

## Setup Options

### Option 1: Python Microservice (Recommended)

1. **Install Python 3.8+** if not already installed

2. **Install Dependencies:**
   ```bash
   pip install flask flask-cors paddleocr opencv-python requests numpy
   ```

3. **Start PaddleOCR Service:**
   ```bash
   cd FINAL_NURSERY_BE
   python paddleocr-service.py
   ```
   Service runs on `http://localhost:5000` by default

4. **Set Environment Variable:**
   Add to your `.env` file:
   ```env
   PADDLEOCR_SERVICE_URL=http://localhost:5000
   ```

### Option 2: Docker (Easier Deployment)

1. **Create Dockerfile:**
   ```dockerfile
   FROM python:3.9-slim
   
   WORKDIR /app
   COPY paddleocr-service.py .
   COPY requirements.txt .
   
   RUN pip install --no-cache-dir -r requirements.txt
   
   EXPOSE 5000
   CMD ["python", "paddleocr-service.py"]
   ```

2. **Create requirements.txt:**
   ```
   flask==2.3.0
   flask-cors==4.0.0
   paddleocr==2.7.0
   opencv-python==4.8.0
   requests==2.31.0
   numpy==1.24.0
   ```

3. **Build and Run:**
   ```bash
   docker build -t paddleocr-service .
   docker run -p 5000:5000 paddleocr-service
   ```

## Priority Order

The backend tries OCR services in this order:
1. **PaddleOCR** (if `PADDLEOCR_SERVICE_URL` is set)
2. **Google Cloud Vision** (if `GOOGLE_CLOUD_VISION_API_KEY` is set)
3. **Tesseract.js** (fallback - always available)

## Testing

Test the PaddleOCR service directly:
```bash
curl -X POST http://localhost:5000/ocr \
  -H "Content-Type: application/json" \
  -d '{"imageUrl": "YOUR_IMAGE_URL"}'
```

Test from Node.js backend:
```bash
curl 'http://localhost:8000/api/v1/user/media/ocr' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  --data-raw '{"imageUrl":"YOUR_IMAGE_URL"}'
```

## Advantages of PaddleOCR

- ✅ Free and open-source
- ✅ Better accuracy than Tesseract for receipts/cheques
- ✅ Handles rotated images automatically
- ✅ Supports multiple languages
- ✅ Good with low-quality images

## Notes

- First run may take time to download PaddleOCR models (~200MB)
- Service needs to be running separately from your Node.js backend
- Can be deployed on same server or different server
