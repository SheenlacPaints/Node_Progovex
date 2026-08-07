#!/usr/bin/env node

/**
 * Apply CORS policy to S3 bucket
 * Usage: node apply-cors.js
 */

import AWS from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize S3 client
const s3 = new AWS.S3({
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'progovex-post';
const CORS_FILE = path.join(__dirname, 'src/config/s3-cors-policy.json');

async function applyCorsPolicy() {
    try {
        console.log(`🔧 Applying CORS policy to S3 bucket: ${BUCKET_NAME}`);
        console.log(`📄 Using CORS policy from: ${CORS_FILE}`);
        console.log('');

        // Read CORS policy file
        if (!fs.existsSync(CORS_FILE)) {
            console.error(`❌ CORS policy file not found at ${CORS_FILE}`);
            process.exit(1);
        }

        const corsConfigData = JSON.parse(fs.readFileSync(CORS_FILE, 'utf-8'));
        
        // Handle both formats: array and object with CORSRules
        const corsConfig = Array.isArray(corsConfigData) 
            ? { CORSRules: corsConfigData }
            : corsConfigData;

        console.log('📋 CORS Configuration:');
        console.log(JSON.stringify(corsConfig, null, 2));
        console.log('');

        // Apply CORS policy
        console.log('⏳ Applying CORS policy to S3 bucket...');
        await s3.putBucketCors({
            Bucket: BUCKET_NAME,
            CORSConfiguration: corsConfig,
        }).promise();

        console.log('✅ CORS policy applied successfully!');
        console.log('');

        // Verify CORS configuration
        console.log('📍 Verifying CORS configuration...');
        const result = await s3.getBucketCors({
            Bucket: BUCKET_NAME,
        }).promise();

        console.log('✨ Current CORS Configuration:');
        console.log(JSON.stringify(result.CORSConfiguration, null, 2));
        console.log('');
        console.log('🎉 CORS configuration is now active!');
        console.log('Clear your browser cache and refresh the page.');

    } catch (error) {
        console.error('❌ Error applying CORS policy:');
        console.error(error.message);
        
        if (error.code === 'NoSuchBucket') {
            console.error(`\n❌ Bucket "${BUCKET_NAME}" does not exist`);
        } else if (error.code === 'InvalidAccessKeyId' || error.code === 'SignatureDoesNotMatch') {
            console.error('\n❌ AWS credentials are invalid or not configured');
            console.error('Make sure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set in .env');
        }
        
        process.exit(1);
    }
}

// Run the function
applyCorsPolicy();
