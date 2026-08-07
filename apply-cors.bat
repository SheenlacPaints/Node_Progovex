@echo off
REM Apply CORS policy to S3 bucket (Windows Batch)
REM Make sure you have AWS CLI configured with proper credentials

setlocal enabledelayedexpansion

set BUCKET_NAME=progovex-post
set REGION=ap-south-1
set CORS_FILE=.\src\config\s3-cors-policy.json

echo Applying CORS policy to S3 bucket: %BUCKET_NAME%
echo Region: %REGION%
echo.

REM Check if AWS CLI is installed
aws --version >nul 2>&1
if errorlevel 1 (
    echo ❌ AWS CLI is not installed. Please install it first.
    exit /b 1
)

REM Check if CORS policy file exists
if not exist "%CORS_FILE%" (
    echo ❌ CORS policy file not found at %CORS_FILE%
    exit /b 1
)

REM Apply CORS policy
echo ⏳ Applying CORS policy...
aws s3api put-bucket-cors ^
    --bucket %BUCKET_NAME% ^
    --cors-configuration file://%CORS_FILE% ^
    --region %REGION%

if errorlevel 1 (
    echo ❌ Failed to apply CORS policy
    exit /b 1
)

echo ✅ CORS policy applied successfully!
echo.
echo Verifying CORS configuration...
aws s3api get-bucket-cors ^
    --bucket %BUCKET_NAME% ^
    --region %REGION%

pause
