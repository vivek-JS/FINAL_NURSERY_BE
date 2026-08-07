/**
 * One-time script to download @vladmandic/face-api model weights into weights/.
 * Run with: node scripts/download-face-models.mjs
 *
 * Only the 3 models actually used by faceRecognition.service.js are fetched
 * (tiny face detector, 68-point landmarks, face recognition descriptor net)
 * to keep the weights/ folder small — age/gender/expression/ssd models are skipped.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEIGHTS_DIR = path.join(__dirname, '..', 'weights');
const BASE_URL = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model';

const FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
];

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          download(res.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(err);
      });
  });
}

async function main() {
  fs.mkdirSync(WEIGHTS_DIR, { recursive: true });
  console.log(`Downloading ${FILES.length} face-api model files into ${WEIGHTS_DIR} ...`);

  for (const filename of FILES) {
    const destPath = path.join(WEIGHTS_DIR, filename);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      console.log(`  [skip] ${filename} already present`);
      continue;
    }
    process.stdout.write(`  [fetch] ${filename} ... `);
    await download(`${BASE_URL}/${filename}`, destPath);
    const size = fs.statSync(destPath).size;
    console.log(`done (${(size / 1024).toFixed(1)} KB)`);
  }

  console.log('All face-api model weights are ready.');
}

main().catch((err) => {
  console.error('Failed to download face-api models:', err.message);
  process.exit(1);
});
