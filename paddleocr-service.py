"""
PaddleOCR Microservice for Node.js Backend
Run this service separately: python paddleocr-service.py
"""
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import cv2
import numpy as np
from paddleocr import PaddleOCR
import os
import tempfile

app = Flask(__name__)
CORS(app)  # Allow requests from Node.js backend

# Initialize PaddleOCR once (reuse for all requests)
ocr = PaddleOCR(
    use_angle_cls=True,  # Enable angle classification for better accuracy
    lang='en',           # English language
    det=True,            # Text detection
    rec=True,            # Text recognition
    show_log=False       # Disable verbose logging
)

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok", "service": "PaddleOCR"})

@app.route('/ocr', methods=['POST'])
def ocr_endpoint():
    """
    OCR endpoint that accepts image URL
    Request: { "imageUrl": "https://..." }
    Response: { "text": "...", "results": [[bbox, text, confidence], ...] }
    """
    try:
        data = request.json
        image_url = data.get('imageUrl')
        
        if not image_url:
            return jsonify({
                "success": False,
                "error": "imageUrl is required"
            }), 400
        
        # Download image from URL
        response = requests.get(image_url, timeout=30)
        response.raise_for_status()
        
        # Convert to numpy array for PaddleOCR
        nparr = np.frombuffer(response.content, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if img is None:
            return jsonify({
                "success": False,
                "error": "Failed to decode image"
            }), 400
        
        # Run PaddleOCR
        # Result format: [[bbox, text, confidence], ...]
        results = ocr.ocr(img, cls=True)
        
        # Extract text from results
        text_lines = []
        all_results = []
        
        if results and len(results) > 0:
            for line in results[0]:
                if line and len(line) >= 2:
                    bbox = line[0]  # Bounding box coordinates
                    text_info = line[1]  # [text, confidence]
                    text = text_info[0] if isinstance(text_info, list) else text_info
                    confidence = text_info[1] if isinstance(text_info, list) and len(text_info) > 1 else 1.0
                    
                    text_lines.append(text)
                    all_results.append({
                        "bbox": bbox,
                        "text": text,
                        "confidence": float(confidence)
                    })
        
        # Combine all text into single string
        full_text = "\n".join(text_lines)
        
        return jsonify({
            "success": True,
            "text": full_text,
            "results": all_results,
            "lines": text_lines
        })
        
    except Exception as e:
        print(f"OCR Error: {str(e)}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"PaddleOCR service starting on port {port}...")
    app.run(host='0.0.0.0', port=port, debug=False)
