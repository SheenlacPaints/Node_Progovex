#!/bin/bash

# Apply CORS policy to S3 bucket
# Make sure you have AWS CLI configured with proper credentials

BUCKET_NAME="progovex-post"
REGION="ap-south-1"
CORS_FILE="./src/config/s3-cors-policy.json"

echo "Applying CORS policy to S3 bucket: $BUCKET_NAME"
echo "Region: $REGION"
echo ""

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed. Please install it first."
    exit 1
fi

# Check if CORS policy file exists
if [ ! -f "$CORS_FILE" ]; then
    echo "❌ CORS policy file not found at $CORS_FILE"
    exit 1
fi

# Apply CORS policy
echo "⏳ Applying CORS policy..."
aws s3api put-bucket-cors \
    --bucket "$BUCKET_NAME" \
    --cors-configuration "file://$CORS_FILE" \
    --region "$REGION"

if [ $? -eq 0 ]; then
    echo "✅ CORS policy applied successfully!"
    echo ""
    echo "Verifying CORS configuration..."
    aws s3api get-bucket-cors \
        --bucket "$BUCKET_NAME" \
        --region "$REGION"
else
    echo "❌ Failed to apply CORS policy"
    exit 1
fi
