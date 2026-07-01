// src/helpers/s3.helper.ts
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
    CopyObjectCommand,
    DeleteObjectsCommand,
    PutObjectCommandInput,
    GetObjectCommandInput,
    DeleteObjectCommandInput,
    ListObjectsV2CommandInput,
    CopyObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, S3_CONFIG } from "../config/s3.config";
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { Readable } from 'stream';

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
    public client: S3Client;
    public bucketName: string;
    private region: string;
    private baseUrl: string;

    constructor() {
        this.client = s3Client;
        this.region = S3_CONFIG.region || 'ap-south-1';
        this.bucketName = S3_CONFIG.bucketName || 'progovex-post';

        this.client = new S3Client({
            region: this.region,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
            },
        });

        this.baseUrl = `https://${this.bucketName}.s3.${this.region}.amazonaws.com`;
    }

    // ==============================================
    // FOLDER OPERATIONS
    // ==============================================

    // Make these properties accessible
    getBucketName(): string {
        return this.bucketName;
    }

    getRegion(): string {
        return this.region;
    }

    getClient(): S3Client {
        return this.client;
    }

    /**
     * Create a folder in S3
     */
    async createFolder(folderPath: string, metadata?: Record<string, string>): Promise<string> {
        try {
            const key = this.normalizePath(folderPath, true);

            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: '',
                ContentType: 'application/x-directory',
                Metadata: {
                    'folder': 'true',
                    'created-at': new Date().toISOString(),
                    ...metadata,
                },
            });

            await this.client.send(command);
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
                const listCommand = new ListObjectsV2Command({
                    Bucket: this.bucketName,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                });

                const listResponse = await this.client.send(listCommand);

                if (!listResponse.Contents || listResponse.Contents.length === 0) {
                    break;
                }

                const objectsToDelete = listResponse.Contents
                    .filter(item => item.Key)
                    .map(item => ({ Key: item.Key! }));

                if (objectsToDelete.length > 0) {
                    const deleteCommand = new DeleteObjectsCommand({
                        Bucket: this.bucketName,
                        Delete: {
                            Objects: objectsToDelete,
                            Quiet: false,
                        },
                    });

                    await this.client.send(deleteCommand);
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

            const listCommand = new ListObjectsV2Command({
                Bucket: this.bucketName,
                Prefix: prefix,
                Delimiter: recursive ? undefined : '/',
            });

            const response = await this.client.send(listCommand);
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

            // Process subfolders (from CommonPrefixes)
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
     * Check if a folder exists
     */
    async folderExists(folderPath: string): Promise<boolean> {
        try {
            const prefix = this.normalizePath(folderPath, true);
            const listCommand = new ListObjectsV2Command({
                Bucket: this.bucketName,
                Prefix: prefix,
                MaxKeys: 1,
            });

            const response = await this.client.send(listCommand);
            return (response.Contents && response.Contents.length > 0) || false;
        } catch (error) {
            return false;
        }
    }

    /**
     * Move/Rename a folder
     */
    async moveFolder(sourcePath: string, destinationPath: string): Promise<number> {
        try {
            const sourcePrefix = this.normalizePath(sourcePath, true);
            const destPrefix = this.normalizePath(destinationPath, true);

            // List all objects in source folder
            const listCommand = new ListObjectsV2Command({
                Bucket: this.bucketName,
                Prefix: sourcePrefix,
            });

            const listResponse = await this.client.send(listCommand);

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
                await this.client.send(new CopyObjectCommand({
                    Bucket: this.bucketName,
                    CopySource: `${this.bucketName}/${item.Key}`,
                    Key: newKey,
                }));

                // Delete from old location
                await this.client.send(new DeleteObjectCommand({
                    Bucket: this.bucketName,
                    Key: item.Key,
                }));

                movedCount++;
            }

            console.log(`📂 Folder moved: ${sourcePrefix} -> ${destPrefix} (${movedCount} objects)`);
            return movedCount;
        } catch (error: any) {
            console.error('Error moving folder:', error);
            throw new Error(`Failed to move folder: ${error.message}`);
        }
    }

    // ==============================================
    // FILE OPERATIONS
    // ==============================================

    /**
     * Upload a file to S3
     */
    // In your s3.helper.ts - ensure uploads are private by default
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
                isPublic = false, // Default to private
            } = options;

            const finalFileName = fileName || `${uuidv4()}`;
            const key = this.normalizePath(folderPath, true) + finalFileName;

            const uploadParams: PutObjectCommandInput = {
                Bucket: this.bucketName,
                Key: key,
                Body: file,
                ContentType: contentType,
                Metadata: {
                    'uploaded-at': new Date().toISOString(),
                    ...metadata,
                },
            };

            // ⚠️ DON'T set ACL for private - this is the default
            // Only set ACL if explicitly requested
            if (isPublic) {
                uploadParams.ACL = 'public-read';
            }

            const command = new PutObjectCommand(uploadParams);
            const response = await this.client.send(command);

            const result: FileUploadResult = {
                key: key,
                url: this.getFileUrl(key),
                bucket: this.bucketName,
                region: this.region,
                contentType: contentType,
                metadata: metadata,
            };

            console.log(`✅ File uploaded privately: ${key}`);
            return result;
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
     * Download/Get a file from S3
     */
    async getFile(key: string): Promise<Buffer> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            const response = await this.client.send(command);

            // Convert stream to buffer
            const chunks: Uint8Array[] = [];
            for await (const chunk of response.Body as any) {
                chunks.push(chunk);
            }

            console.log(`📥 File downloaded: ${key}`);
            return Buffer.concat(chunks);
        } catch (error: any) {
            console.error('Error getting file:', error);
            throw new Error(`Failed to get file: ${error.message}`);
        }
    }

    /**
     * Get file as stream (for large files)
     */
    async getFileStream(key: string): Promise<Readable> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            const response = await this.client.send(command);
            console.log(`📥 File stream created: ${key}`);
            return response.Body as Readable;
        } catch (error: any) {
            console.error('Error getting file stream:', error);
            throw new Error(`Failed to get file stream: ${error.message}`);
        }
    }

    /**
     * Delete a file from S3
     */
    async deleteFile(key: string): Promise<boolean> {
        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            await this.client.send(command);
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

            // S3 can delete up to 1000 objects at once
            const objects = keys.map(key => ({ Key: key }));

            const command = new DeleteObjectsCommand({
                Bucket: this.bucketName,
                Delete: {
                    Objects: objects,
                    Quiet: false,
                },
            });

            const response = await this.client.send(command);
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
            const command = new HeadObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            await this.client.send(command);
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
            const command = new HeadObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            const response = await this.client.send(command);

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
            const command = new CopyObjectCommand({
                Bucket: this.bucketName,
                CopySource: `${this.bucketName}/${sourceKey}`,
                Key: destinationKey,
            });

            await this.client.send(command);
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
            // Copy to new location
            await this.copyFile(sourceKey, destinationKey);

            // Delete from old location
            await this.deleteFile(sourceKey);

            console.log(`📂 File moved: ${sourceKey} -> ${destinationKey}`);
            return true;
        } catch (error: any) {
            console.error('Error moving file:', error);
            throw new Error(`Failed to move file: ${error.message}`);
        }
    }

    // ==============================================
    // PRESIGNED URLS
    // ==============================================

    /**
     * Generate a presigned URL for uploading
     */
    async getPresignedUploadUrl(
        key: string,
        expiresIn: number = 3600,
        contentType?: string
    ): Promise<string> {
        try {
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                ContentType: contentType || 'application/octet-stream',
            });

            const url = await getSignedUrl(this.client, command, { expiresIn });
            console.log(`🔗 Presigned upload URL generated: ${key}`);
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
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            const url = await getSignedUrl(this.client, command, { expiresIn });
            console.log(`🔗 Presigned download URL generated: ${key}`);
            return url;
        } catch (error: any) {
            console.error('Error generating presigned URL:', error);
            throw new Error(`Failed to generate presigned URL: ${error.message}`);
        }
    }

    // ==============================================
    // SEARCH OPERATIONS
    // ==============================================

    /**
     * Search files by prefix or pattern
     */
    async searchFiles(prefix: string, maxKeys: number = 1000): Promise<FileInfo[]> {
        try {
            const command = new ListObjectsV2Command({
                Bucket: this.bucketName,
                Prefix: prefix,
                MaxKeys: maxKeys,
            });

            const response = await this.client.send(command);

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

            console.log(`🔍 Found ${files.length} files in ${prefix}`);
            return files;
        } catch (error: any) {
            console.error('Error searching files:', error);
            throw new Error(`Failed to search files: ${error.message}`);
        }
    }

    // ==============================================
    // UTILITY METHODS
    // ==============================================

    /**
     * Get public URL for a file
     */
    getFileUrl(key: string): string {
        return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
    }

    /**
     * Normalize path (remove leading/trailing slashes)
     */
    private normalizePath(pathString: string, isFolder: boolean = false): string {
        let normalized = pathString.replace(/^\/+|\/+$/g, '');

        // Add base folder if configured
        if (S3_CONFIG.baseFolder && !normalized.startsWith(S3_CONFIG.baseFolder)) {
            normalized = `${S3_CONFIG.baseFolder}/${normalized}`;
        }

        if (isFolder && !normalized.endsWith('/')) {
            normalized = `${normalized}/`;
        }

        return normalized;
    }

    /**
     * Get file extension from key
     */
    getFileExtension(key: string): string {
        return path.extname(key).toLowerCase();
    }

    /**
     * Get file name from key
     */
    getFileName(key: string): string {
        return path.basename(key);
    }

    /**
     * Get file size in human readable format
     */
    getReadableSize(bytes: number): string {
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    }
}

// Export singleton instance
export const s3Helper = new S3Helper();