// src/controllers/mediaController.ts

import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { s3Helper } from '../helpers/s3.helper';
import { Readable } from 'stream';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';

export const streamMedia = async (req: AuthRequest, res: Response) => {
    try {
        const { key } = req.query;

        if (!key) {
            return res.status(400).json({
                success: false,
                message: 'Media key is required'
            });
        }

        const decodedKey = decodeURIComponent(key as string);
        console.log(`📥 Streaming media: ${decodedKey}`);

        // Check if file exists
        const exists = await s3Helper.fileExists(decodedKey);
        if (!exists) {
            return res.status(404).json({
                success: false,
                message: 'Media not found'
            });
        }

        // Get file info
        const fileInfo = await s3Helper.getFileInfo(decodedKey);
        
        // Get file from S3 - this returns the raw response
        const params: AWS.S3.GetObjectRequest = {
            Bucket: s3Helper.getBucketName(),
            Key: decodedKey,
        };

        const s3Response = await s3Helper.getClient().getObject(params).promise();
        const body = s3Response.Body as Buffer;
        const contentType = s3Response.ContentType || fileInfo.contentType || 'application/octet-stream';
        const contentLength = s3Response.ContentLength || fileInfo.size || 0;

        // Set headers
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Access-Control-Allow-Origin', FRONTEND_URL);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

        // Handle range requests for video seeking
        const range = req.headers.range;
        if (range && typeof range === 'string') {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : contentLength - 1;
            const chunksize = (end - start) + 1;

            // Slice the buffer for range request
            const buffer = body.slice(start, end + 1);

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${contentLength}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': FRONTEND_URL,
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
            });

            res.end(buffer);
        } else {
            // Send the entire file
            res.end(body);
        }

    } catch (error: any) {
        console.error('Error streaming media:', error);

        // Check if headers already sent
        if (res.headersSent) {
            return;
        }

        if (error.code === 'NoSuchKey' || error.name === 'NoSuchKey') {
            return res.status(404).json({
                success: false,
                message: 'Media not found'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to stream media',
            error: error.message
        });
    }
};

export const getMediaUrl = async (req: AuthRequest, res: Response) => {
    try {
        const { key } = req.query;
        const expiresIn = parseInt(req.query.expiresIn as string) || 900;

        if (!key) {
            return res.status(400).json({
                success: false,
                message: 'Media key is required'
            });
        }

        const decodedKey = decodeURIComponent(key as string);
        const url = await s3Helper.getPresignedDownloadUrl(decodedKey, expiresIn);

        res.json({
            success: true,
            url: url,
            expiresIn: expiresIn
        });

    } catch (error: any) {
        console.error('Error generating presigned URL:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate media URL'
        });
    }
};

export const streamMediaWithPresignedUrl = async (req: AuthRequest, res: Response) => {
    try {
        const { key } = req.query;

        if (!key) {
            return res.status(400).json({
                success: false,
                message: 'Media key is required'
            });
        }

        const decodedKey = decodeURIComponent(key as string);
        console.log(`📥 Streaming media with presigned URL: ${decodedKey}`);

        // Generate a presigned URL that expires in 5 minutes
        const url = await s3Helper.getPresignedDownloadUrl(decodedKey, 300);

        // Redirect to the presigned URL
        res.redirect(url);

    } catch (error: any) {
        console.error('Error streaming media with presigned URL:', error);
        
        if (res.headersSent) {
            return;
        }

        res.status(500).json({
            success: false,
            message: 'Failed to stream media'
        });
    }
};