// src/controllers/mediaController.ts
import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { s3Helper } from '../helpers/s3.helper';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ==============================================
// STREAM MEDIA FROM S3 (With Authentication)
// ==============================================
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

        // ✅ Add CORS headers
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4200');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, Content-Type, Accept');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

        // ✅ Handle preflight OPTIONS request
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }

        // Get the file from S3
        const command = new GetObjectCommand({
            Bucket: s3Helper.getBucketName(),
            Key: decodedKey,
        });

        const response = await s3Helper.getClient().send(command);
        const contentType = response.ContentType || 'application/octet-stream';

        // ✅ Set Accept-Ranges header for video seeking
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', contentType);

        // Handle range requests for video seeking
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : (response.ContentLength || 0) - 1;
            const chunksize = (end - start) + 1;

            const stream = response.Body?.transformToWebStream();
            if (!stream) {
                return res.status(404).json({ success: false, message: 'Media not found' });
            }

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${response.ContentLength}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': 'http://localhost:4200',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
            });

            // Stream the range
            const reader = stream.getReader();
            const writer = res as any;

            async function pump() {
                const { done, value } = await reader.read();
                if (done) {
                    writer.end();
                    return;
                }
                writer.write(value);
                pump();
            }
            pump();
        } else {
            // For images or full video download
            const stream = response.Body?.transformToWebStream();
            if (!stream) {
                return res.status(404).json({ success: false, message: 'Media not found' });
            }

            res.setHeader('Cache-Control', 'public, max-age=31536000');
            res.setHeader('Content-Length', response.ContentLength || 0);

            const reader = stream.getReader();
            const writer = res as any;

            async function pump() {
                const { done, value } = await reader.read();
                if (done) {
                    writer.end();
                    return;
                }
                writer.write(value);
                pump();
            }
            pump();
        }

    } catch (error: any) {
        console.error('Error streaming media:', error);

        if (error.name === 'NoSuchKey') {
            return res.status(404).json({
                success: false,
                message: 'Media not found'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to stream media'
        });
    }
};

// ==============================================
// GENERATE PRESIGNED URL (Alternative)
// ==============================================
export const getMediaUrl = async (req: AuthRequest, res: Response) => {
    try {
        const { key } = req.query;

        if (!key) {
            return res.status(400).json({
                success: false,
                message: 'Media key is required'
            });
        }

        const decodedKey = decodeURIComponent(key as string);

        // Generate a presigned URL that expires in 15 minutes
        const command = new GetObjectCommand({
            Bucket: s3Helper.bucketName,
            Key: decodedKey,
        });

        const url = await getSignedUrl(s3Helper.client, command, { expiresIn: 900 });

        res.json({
            success: true,
            url: url,
            expiresIn: 900 // 15 minutes
        });

    } catch (error: any) {
        console.error('Error generating presigned URL:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate media URL'
        });
    }
};