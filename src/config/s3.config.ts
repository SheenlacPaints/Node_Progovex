// src/config/s3.config.ts
import { S3Client } from "@aws-sdk/client-s3";
import dotenv from 'dotenv';

dotenv.config();

// S3 Client Configuration
export const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
});

export const S3_CONFIG = {
    bucketName: process.env.S3_BUCKET_NAME || 'your-bucket-name',
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    baseFolder: process.env.S3_BASE_FOLDER || 'uploads',
    maxFileSize: 50 * 1024 * 1024, // 50MB
    allowedMimeTypes: [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'video/mp4',
        'video/webm',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
};