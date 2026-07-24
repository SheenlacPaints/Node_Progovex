// src/helpers/s3.helper.ts

import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { Readable } from 'stream';
import { s3Client, S3_CONFIG } from '../config/s3.config';

export interface FileUploadOptions {
    folderPath?: string;
    fileName?: string;
    contentType?: string;
    metadata?: Record<string, string>;
    isPublic?: boolean;
}

export interface FileUploadResult {
    key: string;
    url: string;
    bucket: string;
    region: string;
    size?: number;
    contentType?: string;
    metadata?: Record<string, string>;
}

export interface FileInfo {
    key: string;
    size: number;
    lastModified: Date;
    contentType?: string;
    metadata?: Record<string, string>;
    url: string;
    isFolder: boolean;
}

export class S3Helper {
    public client: AWS.S3;
    public bucketName: string;
    private region: string;
    private baseUrl: string;

    constructor() {
        this.client = s3Client;
        this.region = S3_CONFIG.region || 'ap-south-1';
        this.bucketName = S3_CONFIG.bucketName || 'progovex-post';
        this.baseUrl = `https://${this.bucketName}.s3.${this.region}.amazonaws.com`;
    }

    getBucketName(): string {
        return this.bucketName;
    }

    getRegion(): string {
        return this.region;
    }

    getClient(): AWS.S3 {
        return this.client;
    }

    /**
     * Create a folder in S3
     */
    async createFolder(folderPath: string, metadata?: Record<string, string>): Promise<string> {
        try {
            const key = this.normalizePath(folderPath, true);

            const params: AWS.S3.PutObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
                Body: '',
                ContentType: 'application/x-directory',
                Metadata: {
                    'folder': 'true',
                    'created-at': new Date().toISOString(),
                    ...metadata,
                },
            };

            await this.client.putObject(params).promise();
            console.log(`📁 Folder created: ${key}`);
            return key;
        } catch (error: any) {
            console.error('Error creating folder:', error);
            throw new Error(`Failed to create folder: ${error.message}`);
        }
    }

    /**
     * Delete a folder and all its contents
     */
    async deleteFolder(folderPath: string): Promise<number> {
        try {
            const prefix = this.normalizePath(folderPath, true);
            let deletedCount = 0;
            let continuationToken: string | undefined;

            do {
                const listParams: AWS.S3.ListObjectsV2Request = {
                    Bucket: this.bucketName,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                };

                const listResponse = await this.client.listObjectsV2(listParams).promise();

                if (!listResponse.Contents || listResponse.Contents.length === 0) {
                    break;
                }

                const objectsToDelete = listResponse.Contents
                    .filter(item => item.Key)
                    .map(item => ({ Key: item.Key! }));

                if (objectsToDelete.length > 0) {
                    const deleteParams: AWS.S3.DeleteObjectsRequest = {
                        Bucket: this.bucketName,
                        Delete: {
                            Objects: objectsToDelete,
                            Quiet: false,
                        },
                    };

                    await this.client.deleteObjects(deleteParams).promise();
                    deletedCount += objectsToDelete.length;
                }

                continuationToken = listResponse.NextContinuationToken;
            } while (continuationToken);

            console.log(`🗑️ Folder deleted: ${prefix} (${deletedCount} objects)`);
            return deletedCount;
        } catch (error: any) {
            console.error('Error deleting folder:', error);
            throw new Error(`Failed to delete folder: ${error.message}`);
        }
    }

    /**
     * List files and folders in a directory
     */
    async listFolderContents(folderPath: string, recursive: boolean = false): Promise<FileInfo[]> {
        try {
            const prefix = this.normalizePath(folderPath, true);

            const listParams: AWS.S3.ListObjectsV2Request = {
                Bucket: this.bucketName,
                Prefix: prefix,
                Delimiter: recursive ? undefined : '/',
            };

            const response = await this.client.listObjectsV2(listParams).promise();
            const contents: FileInfo[] = [];

            // Process files
            if (response.Contents) {
                for (const item of response.Contents) {
                    if (item.Key && item.Key !== prefix) {
                        const isFolder = item.Key.endsWith('/');
                        contents.push({
                            key: item.Key,
                            size: item.Size || 0,
                            lastModified: item.LastModified || new Date(),
                            url: this.getFileUrl(item.Key),
                            isFolder: isFolder,
                        });
                    }
                }
            }

            // Process subfolders
            if (response.CommonPrefixes) {
                for (const prefixItem of response.CommonPrefixes) {
                    if (prefixItem.Prefix) {
                        contents.push({
                            key: prefixItem.Prefix,
                            size: 0,
                            lastModified: new Date(),
                            url: this.getFileUrl(prefixItem.Prefix),
                            isFolder: true,
                        });
                    }
                }
            }

            return contents;
        } catch (error: any) {
            console.error('Error listing folder contents:', error);
            throw new Error(`Failed to list folder contents: ${error.message}`);
        }
    }

    /**
     * Upload a file to S3
     */
    async uploadFile(
        file: Buffer | Readable | string,
        options: FileUploadOptions = {}
    ): Promise<FileUploadResult> {
        try {
            const {
                folderPath,
                fileName,
                contentType = 'application/octet-stream',
                metadata = {},
                isPublic = false,
            } = options;

            const finalFileName = fileName || `${uuidv4()}`;
            const key = this.normalizePath(folderPath, true) + finalFileName;

            const uploadParams: AWS.S3.PutObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
                Body: file,
                ContentType: contentType,
                Metadata: {
                    'uploaded-at': new Date().toISOString(),
                    ...metadata,
                },
            };

            if (isPublic) {
                uploadParams.ACL = 'public-read';
            }

            const result = await this.client.upload(uploadParams).promise();

            const uploadResult: FileUploadResult = {
                key: key,
                url: result.Location || this.getFileUrl(key),
                bucket: this.bucketName,
                region: this.region,
                contentType: contentType,
                metadata: metadata,
            };

            console.log(`✅ File uploaded: ${key}`);
            return uploadResult;
        } catch (error: any) {
            console.error('Error uploading file:', error);
            throw new Error(`Failed to upload file: ${error.message}`);
        }
    }

    /**
     * Upload multiple files
     */
    async uploadMultipleFiles(
        files: Array<{ buffer: Buffer; originalname: string; mimetype: string }>,
        folderPath: string = '',
        metadata?: Record<string, string>
    ): Promise<FileUploadResult[]> {
        const results: FileUploadResult[] = [];

        for (const file of files) {
            const result = await this.uploadFile(file.buffer, {
                folderPath,
                fileName: file.originalname,
                contentType: file.mimetype,
                metadata,
            });
            results.push(result);
        }

        return results;
    }

    /**
     * Get a file from S3
     */
    async getFile(key: string): Promise<Buffer> {
        try {
            const params: AWS.S3.GetObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
            };

            const response = await this.client.getObject(params).promise();
            return response.Body as Buffer;
        } catch (error: any) {
            console.error('Error getting file:', error);
            throw new Error(`Failed to get file: ${error.message}`);
        }
    }

    /**
     * Get file as stream
     */
    async getFileStream(key: string): Promise<Readable> {
        try {
            const params: AWS.S3.GetObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
            };

            const response = await this.client.getObject(params).promise();
            return response.Body as Readable;
        } catch (error: any) {
            console.error('Error getting file stream:', error);
            throw new Error(`Failed to get file stream: ${error.message}`);
        }
    }

    /**
     * Delete a file
     */
    async deleteFile(key: string): Promise<boolean> {
        try {
            const params: AWS.S3.DeleteObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
            };

            await this.client.deleteObject(params).promise();
            console.log(`🗑️ File deleted: ${key}`);
            return true;
        } catch (error: any) {
            console.error('Error deleting file:', error);
            throw new Error(`Failed to delete file: ${error.message}`);
        }
    }

    /**
     * Delete multiple files
     */
    async deleteMultipleFiles(keys: string[]): Promise<number> {
        try {
            if (keys.length === 0) return 0;

            const objects = keys.map(key => ({ Key: key }));

            const params: AWS.S3.DeleteObjectsRequest = {
                Bucket: this.bucketName,
                Delete: {
                    Objects: objects,
                    Quiet: false,
                },
            };

            const response = await this.client.deleteObjects(params).promise();
            const deletedCount = response.Deleted?.length || 0;

            console.log(`🗑️ Deleted ${deletedCount} files`);
            return deletedCount;
        } catch (error: any) {
            console.error('Error deleting files:', error);
            throw new Error(`Failed to delete files: ${error.message}`);
        }
    }

    /**
     * Check if a file exists
     */
    async fileExists(key: string): Promise<boolean> {
        try {
            const params: AWS.S3.HeadObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
            };

            await this.client.headObject(params).promise();
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get file information
     */
    async getFileInfo(key: string): Promise<FileInfo> {
        try {
            const params: AWS.S3.HeadObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
            };

            const response = await this.client.headObject(params).promise();

            return {
                key: key,
                size: response.ContentLength || 0,
                lastModified: response.LastModified || new Date(),
                contentType: response.ContentType,
                metadata: response.Metadata,
                url: this.getFileUrl(key),
                isFolder: key.endsWith('/'),
            };
        } catch (error: any) {
            console.error('Error getting file info:', error);
            throw new Error(`Failed to get file info: ${error.message}`);
        }
    }

    /**
     * Copy a file
     */
    async copyFile(sourceKey: string, destinationKey: string): Promise<boolean> {
        try {
            const params: AWS.S3.CopyObjectRequest = {
                Bucket: this.bucketName,
                CopySource: `${this.bucketName}/${sourceKey}`,
                Key: destinationKey,
            };

            await this.client.copyObject(params).promise();
            console.log(`📄 File copied: ${sourceKey} -> ${destinationKey}`);
            return true;
        } catch (error: any) {
            console.error('Error copying file:', error);
            throw new Error(`Failed to copy file: ${error.message}`);
        }
    }

    /**
     * Move a file
     */
    async moveFile(sourceKey: string, destinationKey: string): Promise<boolean> {
        try {
            await this.copyFile(sourceKey, destinationKey);
            await this.deleteFile(sourceKey);
            console.log(`📂 File moved: ${sourceKey} -> ${destinationKey}`);
            return true;
        } catch (error: any) {
            console.error('Error moving file:', error);
            throw new Error(`Failed to move file: ${error.message}`);
        }
    }

    /**
     * Generate a presigned URL for uploading
     */
    async getPresignedUploadUrl(
        key: string,
        expiresIn: number = 3600,
        contentType?: string
    ): Promise<string> {
        try {
            const params: AWS.S3.PutObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
                ContentType: contentType || 'application/octet-stream',
            };

            const url = this.client.getSignedUrl('putObject', {
                ...params,
                Expires: expiresIn,
            });

            return url;
        } catch (error: any) {
            console.error('Error generating presigned URL:', error);
            throw new Error(`Failed to generate presigned URL: ${error.message}`);
        }
    }

    /**
     * Generate a presigned URL for downloading
     */
    async getPresignedDownloadUrl(
        key: string,
        expiresIn: number = 3600
    ): Promise<string> {
        try {
            const params: AWS.S3.GetObjectRequest = {
                Bucket: this.bucketName,
                Key: key,
            };

            const url = this.client.getSignedUrl('getObject', {
                ...params,
                Expires: expiresIn,
            });

            return url;
        } catch (error: any) {
            console.error('Error generating presigned URL:', error);
            throw new Error(`Failed to generate presigned URL: ${error.message}`);
        }
    }

    /**
     * Search files by prefix
     */
    async searchFiles(prefix: string, maxKeys: number = 1000): Promise<FileInfo[]> {
        try {
            const params: AWS.S3.ListObjectsV2Request = {
                Bucket: this.bucketName,
                Prefix: prefix,
                MaxKeys: maxKeys,
            };

            const response = await this.client.listObjectsV2(params).promise();

            const files: FileInfo[] = [];
            if (response.Contents) {
                for (const item of response.Contents) {
                    if (item.Key && !item.Key.endsWith('/')) {
                        files.push({
                            key: item.Key,
                            size: item.Size || 0,
                            lastModified: item.LastModified || new Date(),
                            url: this.getFileUrl(item.Key),
                            isFolder: false,
                        });
                    }
                }
            }

            return files;
        } catch (error: any) {
            console.error('Error searching files:', error);
            throw new Error(`Failed to search files: ${error.message}`);
        }
    }

    /**
     * Get public URL for a file
     */
    getFileUrl(key: string): string {
        return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
    }

    /**
     * Normalize path
     */
    private normalizePath(pathString: string, isFolder: boolean = false): string {
        let normalized = pathString.replace(/^\/+|\/+$/g, '');

        if (isFolder && !normalized.endsWith('/')) {
            normalized = `${normalized}/`;
        }

        return normalized;
    }

    /**
     * Get file extension
     */
    getFileExtension(key: string): string {
        return path.extname(key).toLowerCase();
    }

    /**
     * Get file name
     */
    getFileName(key: string): string {
        return path.basename(key);
    }

    /**
     * Get readable file size
     */
    getReadableSize(bytes: number): string {
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    }

    // src/helpers/s3.helper.ts

    // Add these methods to the S3Helper class after the existing methods

    /**
     * Move/Rename a folder
     */
    async moveFolder(sourcePath: string, destinationPath: string): Promise<number> {
        try {
            const sourcePrefix = this.normalizePath(sourcePath, true);
            const destPrefix = this.normalizePath(destinationPath, true);

            // Check if source folder exists
            const sourceExists = await this.folderExists(sourcePath);
            if (!sourceExists) {
                throw new Error(`Source folder does not exist: ${sourcePath}`);
            }

            // List all objects in source folder
            const listParams: AWS.S3.ListObjectsV2Request = {
                Bucket: this.bucketName,
                Prefix: sourcePrefix,
            };

            const listResponse = await this.client.listObjectsV2(listParams).promise();

            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                return 0;
            }

            let movedCount = 0;

            for (const item of listResponse.Contents) {
                if (!item.Key) continue;

                // Calculate new key
                const relativePath = item.Key.substring(sourcePrefix.length);
                const newKey = destPrefix + relativePath;

                // Copy to new location
                const copyParams: AWS.S3.CopyObjectRequest = {
                    Bucket: this.bucketName,
                    CopySource: `${this.bucketName}/${item.Key}`,
                    Key: newKey,
                };

                await this.client.copyObject(copyParams).promise();

                // Delete from old location
                const deleteParams: AWS.S3.DeleteObjectRequest = {
                    Bucket: this.bucketName,
                    Key: item.Key,
                };

                await this.client.deleteObject(deleteParams).promise();

                movedCount++;
            }

            console.log(`📂 Folder moved: ${sourcePrefix} -> ${destPrefix} (${movedCount} objects)`);
            return movedCount;
        } catch (error: any) {
            console.error('Error moving folder:', error);
            throw new Error(`Failed to move folder: ${error.message}`);
        }
    }

    /**
     * Check if a folder exists
     */
    async folderExists(folderPath: string): Promise<boolean> {
        try {
            const prefix = this.normalizePath(folderPath, true);
            const listParams: AWS.S3.ListObjectsV2Request = {
                Bucket: this.bucketName,
                Prefix: prefix,
                MaxKeys: 1,
            };

            const response = await this.client.listObjectsV2(listParams).promise();
            return (response.Contents && response.Contents.length > 0) || false;
        } catch (error) {
            return false;
        }
    }

    /**
     * Create a folder if it doesn't exist
     */
    async ensureFolderExists(folderPath: string): Promise<boolean> {
        try {
            const exists = await this.folderExists(folderPath);
            if (!exists) {
                await this.createFolder(folderPath);
                return true;
            }
            return false;
        } catch (error: any) {
            console.error('Error ensuring folder exists:', error);
            throw new Error(`Failed to ensure folder exists: ${error.message}`);
        }
    }

    /**
     * Get folder size (total size of all files in folder)
     */
    async getFolderSize(folderPath: string): Promise<number> {
        try {
            const prefix = this.normalizePath(folderPath, true);
            let totalSize = 0;
            let continuationToken: string | undefined;

            do {
                const listParams: AWS.S3.ListObjectsV2Request = {
                    Bucket: this.bucketName,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                };

                const response = await this.client.listObjectsV2(listParams).promise();

                if (response.Contents) {
                    for (const item of response.Contents) {
                        totalSize += item.Size || 0;
                    }
                }

                continuationToken = response.NextContinuationToken;
            } while (continuationToken);

            return totalSize;
        } catch (error: any) {
            console.error('Error getting folder size:', error);
            throw new Error(`Failed to get folder size: ${error.message}`);
        }
    }

    /**
     * Get folder statistics (file count, folder count, total size)
     */
    async getFolderStats(folderPath: string): Promise<{
        fileCount: number;
        folderCount: number;
        totalSize: number;
    }> {
        try {
            const prefix = this.normalizePath(folderPath, true);
            let fileCount = 0;
            let folderCount = 0;
            let totalSize = 0;
            let continuationToken: string | undefined;

            do {
                const listParams: AWS.S3.ListObjectsV2Request = {
                    Bucket: this.bucketName,
                    Prefix: prefix,
                    Delimiter: '/',
                    ContinuationToken: continuationToken,
                };

                const response = await this.client.listObjectsV2(listParams).promise();

                // Count files
                if (response.Contents) {
                    for (const item of response.Contents) {
                        if (item.Key && item.Key !== prefix) {
                            fileCount++;
                            totalSize += item.Size || 0;
                        }
                    }
                }

                // Count subfolders
                if (response.CommonPrefixes) {
                    folderCount += response.CommonPrefixes.length;
                }

                continuationToken = response.NextContinuationToken;
            } while (continuationToken);

            return { fileCount, folderCount, totalSize };
        } catch (error: any) {
            console.error('Error getting folder stats:', error);
            throw new Error(`Failed to get folder stats: ${error.message}`);
        }
    }

    /**
     * Get all subfolders recursively
     */
    async getSubFolders(folderPath: string, recursive: boolean = false): Promise<string[]> {
        try {
            const prefix = this.normalizePath(folderPath, true);
            const folders: string[] = [];
            let continuationToken: string | undefined;

            do {
                const listParams: AWS.S3.ListObjectsV2Request = {
                    Bucket: this.bucketName,
                    Prefix: prefix,
                    Delimiter: recursive ? undefined : '/',
                    ContinuationToken: continuationToken,
                };

                const response = await this.client.listObjectsV2(listParams).promise();

                if (response.CommonPrefixes) {
                    for (const prefixItem of response.CommonPrefixes) {
                        if (prefixItem.Prefix) {
                            folders.push(prefixItem.Prefix);
                            if (recursive) {
                                const subFolders = await this.getSubFolders(prefixItem.Prefix, true);
                                folders.push(...subFolders);
                            }
                        }
                    }
                }

                continuationToken = response.NextContinuationToken;
            } while (continuationToken);

            return folders;
        } catch (error: any) {
            console.error('Error getting subfolders:', error);
            throw new Error(`Failed to get subfolders: ${error.message}`);
        }
    }

    /**
     * Copy a folder
     */
    async copyFolder(sourcePath: string, destinationPath: string): Promise<number> {
        try {
            const sourcePrefix = this.normalizePath(sourcePath, true);
            const destPrefix = this.normalizePath(destinationPath, true);

            // Check if source folder exists
            const sourceExists = await this.folderExists(sourcePath);
            if (!sourceExists) {
                throw new Error(`Source folder does not exist: ${sourcePath}`);
            }

            // List all objects in source folder
            const listParams: AWS.S3.ListObjectsV2Request = {
                Bucket: this.bucketName,
                Prefix: sourcePrefix,
            };

            const listResponse = await this.client.listObjectsV2(listParams).promise();

            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                return 0;
            }

            let copiedCount = 0;

            for (const item of listResponse.Contents) {
                if (!item.Key) continue;

                // Calculate new key
                const relativePath = item.Key.substring(sourcePrefix.length);
                const newKey = destPrefix + relativePath;

                // Copy to new location
                const copyParams: AWS.S3.CopyObjectRequest = {
                    Bucket: this.bucketName,
                    CopySource: `${this.bucketName}/${item.Key}`,
                    Key: newKey,
                };

                await this.client.copyObject(copyParams).promise();
                copiedCount++;
            }

            console.log(`📂 Folder copied: ${sourcePrefix} -> ${destPrefix} (${copiedCount} objects)`);
            return copiedCount;
        } catch (error: any) {
            console.error('Error copying folder:', error);
            throw new Error(`Failed to copy folder: ${error.message}`);
        }
    }
}

// Export singleton instance
export const s3Helper = new S3Helper();