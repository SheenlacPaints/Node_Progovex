"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVideoThumbnail = exports.processImage = exports.upload = void 0;
// backend/src/utils/fileUpload.ts
const multer_1 = __importDefault(require("multer"));
const sharp_1 = __importDefault(require("sharp"));
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
// Configure storage
const storage = multer_1.default.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = file.mimetype.startsWith('image/')
            ? 'uploads/images'
            : 'uploads/videos';
        await promises_1.default.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path_1.default.extname(file.originalname);
        cb(null, uniqueSuffix + ext);
    }
});
// File filter
const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|mp4|webm|mov|avi|mkv|ogg/;
    const extname = allowedTypes.test(path_1.default.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
        return cb(null, true);
    }
    else {
        cb(new Error('Only images and videos are allowed'));
    }
};
exports.upload = (0, multer_1.default)({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit for videos
    },
    fileFilter: fileFilter
});
// Process and optimize images (videos are not processed to maintain quality)
const processImage = async (filePath) => {
    try {
        const outputPath = filePath.replace(/\.(jpg|jpeg|png)$/, '.webp');
        await (0, sharp_1.default)(filePath)
            .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(outputPath);
        // Remove original file
        await promises_1.default.unlink(filePath);
        return outputPath;
    }
    catch (error) {
        console.error('Error processing image:', error);
        return filePath;
    }
};
exports.processImage = processImage;
// Get video thumbnail (optional)
const getVideoThumbnail = async (videoPath) => {
    // You can implement video thumbnail generation using fluent-ffmpeg
    // This is optional and requires ffmpeg installation
    return videoPath;
};
exports.getVideoThumbnail = getVideoThumbnail;
//# sourceMappingURL=fileUpload.js.map