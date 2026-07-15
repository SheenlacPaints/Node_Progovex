// src/config/s3.config.ts

import AWS from 'aws-sdk';
import dotenv from 'dotenv';

dotenv.config();

// Configure AWS SDK v2
AWS.config.update({
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    signatureVersion: 'v4',
});

// S3 Client instance (v2)
export const s3Client = new AWS.S3();

export const S3_CONFIG = {
    bucketName: process.env.S3_BUCKET_NAME || 'progovex-post',
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
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

// For backward compatibility - create a client instance
export const s3ClientV2 = s3Client;

// Helper function to get signed URL
export const getSignedUrl = (operation: string, params: any, expiresIn: number = 3600): string => {
    return s3Client.getSignedUrl(operation, {
        ...params,
        Expires: expiresIn,
    });
};

// Export types for v2
export type S3ClientType = AWS.S3;
export type S3ConfigType = typeof S3_CONFIG;