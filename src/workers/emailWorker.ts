// backend/src/workers/emailWorker.ts
import Queue from 'bull';
import nodemailer from 'nodemailer';
import { logger } from '../config/database';
import Redis from 'ioredis';

// Create Redis client with proper configuration
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Create Redis clients without problematic options
const redisClient = new Redis(redisUrl, {
  maxRetriesPerRequest: null, // Important for Bull
  enableReadyCheck: false,    // Important for Bull
  lazyConnect: true
});

const subscriber = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true
});

// Configure email transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Create queue with custom Redis clients
let emailQueue: any | null = null;

try {
  emailQueue = new Queue('email', {
    createClient: (type: string) => {
      switch (type) {
        case 'client':
          return redisClient;
        case 'subscriber':
          return subscriber;
        default:
          return new Redis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false
          });
      }
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      }
    }
  });
  
  logger.info('✅ Redis connected for email queue');
} catch (error) {
  logger.warn('⚠️ Redis not available, email queue disabled');
}

const renderTemplate = (template: string, data: any): string => {
  const templates: Record<string, (data: any) => string> = {
    welcome: (data) => `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4CAF50; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; }
          .button { display: inline-block; padding: 10px 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to SocialHub!</h1>
          </div>
          <div class="content">
            <h2>Hello ${data.name}!</h2>
            <p>Thank you for joining our community. We're excited to have you on board!</p>
            <p>Please verify your email address by clicking the button below:</p>
            <p><a href="${process.env.FRONTEND_URL}/verify-email?token=${data.token}" class="button">Verify Email</a></p>
            <p>If you didn't create an account with us, please ignore this email.</p>
          </div>
          <div class="footer">
            <p>&copy; 2024 SocialHub. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    post_approved: (data) => `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4CAF50; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; }
          .button { display: inline-block; padding: 10px 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Post Approved!</h1>
          </div>
          <div class="content">
            <h2>Hello ${data.name}!</h2>
            <p>Great news! Your post has been approved and is now visible to everyone.</p>
            <p><a href="${process.env.FRONTEND_URL}/post/${data.postId}" class="button">View Your Post</a></p>
            <p>Keep sharing amazing content with our community!</p>
          </div>
        </div>
      </body>
      </html>
    `,
    announcement: (data) => `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2196F3; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${data.title}</h1>
          </div>
          <div class="content">
            <p>Hello ${data.name}!</p>
            <p>${data.message}</p>
          </div>
        </div>
      </body>
      </html>
    `,
    reset_password: (data) => `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #FF9800; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; }
          .button { display: inline-block; padding: 10px 20px; background: #FF9800; color: white; text-decoration: none; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Password Reset Request</h1>
          </div>
          <div class="content">
            <h2>Hello ${data.name}!</h2>
            <p>We received a request to reset your password. Click the button below to create a new password:</p>
            <p><a href="${process.env.FRONTEND_URL}/reset-password?token=${data.token}" class="button">Reset Password</a></p>
            <p>If you didn't request this, please ignore this email.</p>
            <p>This link will expire in 1 hour.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };
  
  return templates[template](data);
};

// Process jobs if queue is available
if (emailQueue) {
  emailQueue.process(async (job) => {
    const { to, subject, template, data } = job.data;
    
    try {
      const info = await transporter.sendMail({
        from: `"SocialHub" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html: renderTemplate(template, data)
      });
      
      logger.info(`Email sent to ${to}: ${info.messageId}`);
      return info;
    } catch (error) {
      logger.error(`Email failed to ${to}:`, error);
      throw error;
    }
  });

  // Error handling
  emailQueue.on('failed', (job, err) => {
    logger.error(`Job ${job.id} failed:`, err);
  });

  emailQueue.on('completed', (job) => {
    logger.info(`Job ${job.id} completed`);
  });
}

// Export email sending function
export const sendEmail = async (to: string, subject: string, template: string, data: any) => {
  if (emailQueue) {
    // Use queue if Redis is available
    await emailQueue.add({
      to,
      subject,
      template,
      data
    }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      }
    });
    logger.info(`Email queued for ${to}`);
  } else {
    // Send directly if Redis is not available
    try {
      const info = await transporter.sendMail({
        from: `"SocialHub" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html: renderTemplate(template, data)
      });
      logger.info(`Email sent directly to ${to}: ${info.messageId}`);
    } catch (error) {
      logger.error(`Email failed to ${to}:`, error);
      throw error;
    }
  }
};