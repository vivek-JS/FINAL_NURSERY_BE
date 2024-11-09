import multer from "multer";
import path from "path";

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "./public/images");
  },
  filename: function (req, file, cb) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const randomValue = Math.random().toString(36).substr(2, 9);
    const fileExtension = path.extname(file.originalname);
    const filename = `${year}-${month}-${day}-${randomValue}${fileExtension}`;
    cb(null, filename);
    req.body.receiptPhoto = filename;
  },
});

export const upload = multer({
  storage,
});
