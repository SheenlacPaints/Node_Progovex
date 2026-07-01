// src/routes/s3.routes.ts
import { Router, Request, Response } from 'express';
import { s3Helper } from '../helpers/s3.helper';
import { AuthRequest } from '../middleware/auth';
import multer from 'multer';
import path from 'path';

const router = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        // Allow images and videos
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only images and videos are allowed'));
        }
    },
});


// ==============================================
// FOLDER OPERATIONS
// ==============================================

// Create folder  
router.post('/folder', async (req: AuthRequest, res: Response) => {
    try {
        const { folderPath, metadata } = req.body;
        const userId = req.user?.id || 'anonymous';

        if (!folderPath) {
            return res.status(400).json({
                success: false,
                message: 'folderPath is required',
            });
        }

        const userFolder = `users/${userId}/${folderPath}`;
        const result = await s3Helper.createFolder(userFolder, metadata);

        res.json({
            success: true,
            message: 'Folder created successfully',
            folderPath: result,
        });
    } catch (error: any) {
        console.error('Error creating folder:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create folder',
            error: error.message,
        });
    }
});

// List folder contents
router.get('/folder/:path(*)', async (req: AuthRequest, res: Response) => {
    try {
        const folderPath = req.params.path;
        const userId = req.user?.id || 'anonymous';
        const recursive = req.query.recursive === 'true';

        const userFolder = `users/${userId}/${folderPath}`;
        const contents = await s3Helper.listFolderContents(userFolder, recursive);

        res.json({
            success: true,
            contents,
            folderPath: userFolder,
            count: contents.length,
        });
    } catch (error: any) {
        console.error('Error listing folder:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to list folder',
            error: error.message,
        });
    }
});

// Delete folder
router.delete('/folder/:path(*)', async (req: AuthRequest, res: Response) => {
    try {
        const folderPath = req.params.path;
        const userId = req.user?.id || 'anonymous';

        const userFolder = `users/${userId}/${folderPath}`;
        const deletedCount = await s3Helper.deleteFolder(userFolder);

        res.json({
            success: true,
            message: 'Folder deleted successfully',
            deletedCount,
            folderPath: userFolder,
        });
    } catch (error: any) {
        console.error('Error deleting folder:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete folder',
            error: error.message,
        });
    }
});

// Move folder
router.post('/folder/move', async (req: AuthRequest, res: Response) => {
    try {
        const { sourcePath, destinationPath } = req.body;
        const userId = req.user?.id || 'anonymous';

        if (!sourcePath || !destinationPath) {
            return res.status(400).json({
                success: false,
                message: 'sourcePath and destinationPath are required',
            });
        }

        const sourceUserFolder = `users/${userId}/${sourcePath}`;
        const destUserFolder = `users/${userId}/${destinationPath}`;

        const movedCount = await s3Helper.moveFolder(sourceUserFolder, destUserFolder);

        res.json({
            success: true,
            message: 'Folder moved successfully',
            movedCount,
            source: sourceUserFolder,
            destination: destUserFolder,
        });
    } catch (error: any) {
        console.error('Error moving folder:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to move folder',
            error: error.message,
        });
    }
});

// Check if folder exists
router.head('/folder/:path(*)', async (req: AuthRequest, res: Response) => {
    try {
        const folderPath = req.params.path;
        const userId = req.user?.id || 'anonymous';

        const userFolder = `users/${userId}/${folderPath}`;
        const exists = await s3Helper.folderExists(userFolder);

        if (exists) {
            res.status(200).json({ success: true, exists: true });
        } else {
            res.status(404).json({ success: false, exists: false });
        }
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error checking folder',
            error: error.message,
        });
    }
});

// ==============================================
// FILE OPERATIONS
// ==============================================

// Upload single file
router.post(
    '/upload',
    upload.single('file'),
    async (req: AuthRequest, res: Response) => {
        try {
            const { folderPath } = req.body;
            const userId = req.user?.id || 'anonymous';
            const file = req.file;

            if (!file) {
                return res.status(400).json({
                    success: false,
                    message: 'No file uploaded',
                });
            }

            const userFolder = `users/${userId}/${folderPath || ''}`;
            const result = await s3Helper.uploadFile(file.buffer, {
                folderPath: userFolder,
                fileName: file.originalname,
                contentType: file.mimetype,
                metadata: {
                    'uploaded-by': String(userId),
                    'file-size': String(file.size),
                    'original-name': file.originalname,
                },
            });

            res.json({
                success: true,
                message: 'File uploaded successfully',
                ...result,
                size: file.size,
                originalName: file.originalname,
            });
        } catch (error: any) {
            console.error('Error uploading file:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to upload file',
                error: error.message,
            });
        }
    }
);

// Upload multiple files
router.post(
    '/upload-multiple',
    upload.array('files', 10),
    async (req: AuthRequest, res: Response) => {
        try {
            const { folderPath } = req.body;
            const userId = req.user?.id || 'anonymous';
            const files = req.files as Express.Multer.File[];

            if (!files || files.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No files uploaded',
                });
            }

            const userFolder = `users/${userId}/${folderPath || ''}`;
            const results = [];

            for (const file of files) {
                const result = await s3Helper.uploadFile(file.buffer, {
                    folderPath: userFolder,
                    fileName: file.originalname,
                    contentType: file.mimetype,
                    metadata: {
                        'uploaded-by': String(userId),
                        'file-size': String(file.size),
                    },
                });
                results.push({
                    ...result,
                    size: file.size,
                    originalName: file.originalname,
                });
            }

            res.json({
                success: true,
                message: `${files.length} files uploaded successfully`,
                files: results,
            });
        } catch (error: any) {
            console.error('Error uploading files:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to upload files',
                error: error.message,
            });
        }
    }
);

// Get file
router.get('/file/:path(*)', async (req: AuthRequest, res: Response) => {
    try {
        const filePath = req.params.path;
        const userId = req.user?.id || 'anonymous';

        const userFilePath = `users/${userId}/${filePath}`;

        if (!await s3Helper.fileExists(userFilePath)) {
            return res.status(404).json({
                success: false,
                message: 'File not found',
            });
        }

        const fileInfo = await s3Helper.getFileInfo(userFilePath);
        const fileBuffer = await s3Helper.getFile(userFilePath);

        res.setHeader('Content-Type', fileInfo.contentType || 'application/octet-stream');
        res.setHeader('Content-Length', fileInfo.size);
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
        res.send(fileBuffer);
    } catch (error: any) {
        console.error('Error getting file:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get file',
            error: error.message,
        });
    }
});

// Delete file
router.delete('/file/:path(*)', async (req: AuthRequest, res: Response) => {
    try {
        const filePath = req.params.path;
        const userId = req.user?.id || 'anonymous';

        const userFilePath = `users/${userId}/${filePath}`;

        if (!await s3Helper.fileExists(userFilePath)) {
            return res.status(404).json({
                success: false,
                message: 'File not found',
            });
        }

        await s3Helper.deleteFile(userFilePath);

        res.json({
            success: true,
            message: 'File deleted successfully',
            filePath: userFilePath,
        });
    } catch (error: any) {
        console.error('Error deleting file:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete file',
            error: error.message,
        });
    }
});

// Delete multiple files
router.post('/file/delete-multiple', async (req: AuthRequest, res: Response) => {
    try {
        const { filePaths } = req.body;
        const userId = req.user?.id || 'anonymous';

        if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'filePaths array is required',
            });
        }

        const userFilePaths = filePaths.map((path: string) => `users/${userId}/${path}`);
        const deletedCount = await s3Helper.deleteMultipleFiles(userFilePaths);

        res.json({
            success: true,
            message: 'Files deleted successfully',
            deletedCount,
            filePaths: userFilePaths,
        });
    } catch (error: any) {
        console.error('Error deleting files:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete files',
            error: error.message,
        });
    }
});

// Move file
router.post('/file/move', async (req: AuthRequest, res: Response) => {
    try {
        const { sourcePath, destinationPath } = req.body;
        const userId = req.user?.id || 'anonymous';

        if (!sourcePath || !destinationPath) {
            return res.status(400).json({
                success: false,
                message: 'sourcePath and destinationPath are required',
            });
        }

        const sourceUserPath = `users/${userId}/${sourcePath}`;
        const destUserPath = `users/${userId}/${destinationPath}`;

        await s3Helper.moveFile(sourceUserPath, destUserPath);

        res.json({
            success: true,
            message: 'File moved successfully',
            source: sourceUserPath,
            destination: destUserPath,
        });
    } catch (error: any) {
        console.error('Error moving file:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to move file',
            error: error.message,
        });
    }
});

// Copy file
router.post('/file/copy', async (req: AuthRequest, res: Response) => {
    try {
        const { sourcePath, destinationPath } = req.body;
        const userId = req.user?.id || 'anonymous';

        if (!sourcePath || !destinationPath) {
            return res.status(400).json({
                success: false,
                message: 'sourcePath and destinationPath are required',
            });
        }

        const sourceUserPath = `users/${userId}/${sourcePath}`;
        const destUserPath = `users/${userId}/${destinationPath}`;

        await s3Helper.copyFile(sourceUserPath, destUserPath);

        res.json({
            success: true,
            message: 'File copied successfully',
            source: sourceUserPath,
            destination: destUserPath,
        });
    } catch (error: any) {
        console.error('Error copying file:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to copy file',
            error: error.message,
        });
    }
});

// Get file info
router.get('/file/:path(*)/info', async (req: AuthRequest, res: Response) => {
    try {
        const filePath = req.params.path;
        const userId = req.user?.id || 'anonymous';

        const userFilePath = `users/${userId}/${filePath}`;

        if (!await s3Helper.fileExists(userFilePath)) {
            return res.status(404).json({
                success: false,
                message: 'File not found',
            });
        }

        const info = await s3Helper.getFileInfo(userFilePath);

        res.json({
            success: true,
            info: {
                ...info,
                sizeReadable: s3Helper.getReadableSize(info.size),
            },
        });
    } catch (error: any) {
        console.error('Error getting file info:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get file info',
            error: error.message,
        });
    }
});

// ==============================================
// PRESIGNED URL OPERATIONS
// ==============================================

// Get presigned upload URL
router.post('/presigned-upload', async (req: AuthRequest, res: Response) => {
    try {
        const { filePath, expiresIn, contentType } = req.body;
        const userId = req.user?.id || 'anonymous';

        if (!filePath) {
            return res.status(400).json({
                success: false,
                message: 'filePath is required',
            });
        }

        const userFilePath = `users/${userId}/${filePath}`;
        const url = await s3Helper.getPresignedUploadUrl(
            userFilePath,
            expiresIn || 3600,
            contentType
        );

        res.json({
            success: true,
            url,
            filePath: userFilePath,
            expiresIn: expiresIn || 3600,
        });
    } catch (error: any) {
        console.error('Error generating presigned URL:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate presigned URL',
            error: error.message,
        });
    }
});

// Get presigned download URL
router.post('/presigned-download', async (req: AuthRequest, res: Response) => {
    try {
        const { filePath, expiresIn } = req.body;
        const userId = req.user?.id || 'anonymous';

        if (!filePath) {
            return res.status(400).json({
                success: false,
                message: 'filePath is required',
            });
        }

        const userFilePath = `users/${userId}/${filePath}`;

        if (!await s3Helper.fileExists(userFilePath)) {
            return res.status(404).json({
                success: false,
                message: 'File not found',
            });
        }

        const url = await s3Helper.getPresignedDownloadUrl(
            userFilePath,
            expiresIn || 3600
        );

        res.json({
            success: true,
            url,
            filePath: userFilePath,
            expiresIn: expiresIn || 3600,
        });
    } catch (error: any) {
        console.error('Error generating presigned URL:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate presigned URL',
            error: error.message,
        });
    }
});

// ==============================================
// SEARCH OPERATIONS// ==============================================

// Search files
router.get('/search', async (req: AuthRequest, res: Response) => {
    try {
        const { prefix, maxKeys } = req.query;
        const userId = req.user?.id || 'anonymous';

        if (!prefix) {
            return res.status(400).json({
                success: false,
                message: 'prefix is required',
            });
        }

        const userPrefix = `users/${userId}/${prefix}`;
        const files = await s3Helper.searchFiles(
            userPrefix,
            maxKeys ? parseInt(maxKeys as string) : 1000
        );

        res.json({
            success: true,
            files,
            count: files.length,
            prefix: userPrefix,
        });
    } catch (error: any) {
        console.error('Error searching files:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search files',
            error: error.message,
        });
    }
});

export default router;