// backend/src/utils/fileUpload.ts
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';

// Configure storage
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = file.mimetype.startsWith('image/')
            ? 'uploads/images'
            : 'uploads/videos';

        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, uniqueSuffix + ext);
    }
});

// File filter
const fileFilter = (req: any, file: any, cb: any) => {
    const allowedTypes = /jpeg|jpg|png|gif|mp4|webm|mov|avi|mkv|ogg/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('Only images and videos are allowed'));
    }
};

export const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit for videos
    },
    fileFilter: fileFilter
});

// Process and optimize images (videos are not processed to maintain quality)
export const processImage = async (filePath: string): Promise<string> => {
    try {
        const outputPath = filePath.replace(/\.(jpg|jpeg|png)$/, '.webp');
        await sharp(filePath)
            .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(outputPath);

        // Remove original file
        await fs.unlink(filePath);
        return outputPath;
    } catch (error) {
        console.error('Error processing image:', error);
        return filePath;
    }
};

// Get video thumbnail (optional)
export const getVideoThumbnail = async (videoPath: string): Promise<string> => {
    // You can implement video thumbnail generation using fluent-ffmpeg
    // This is optional and requires ffmpeg installation
    return videoPath;
};