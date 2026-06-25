// backend/src/config/database.ts
import mysql from 'mysql2/promise';
import mongoose from 'mongoose';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

// MySQL Connection Pool
export const mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'social_platform',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

// Test MySQL connection
mysqlPool.getConnection()
    .then(connection => {
        console.log('✅ MySQL connected successfully');
        connection.release();
    })
    .catch(err => {
        console.error('❌ MySQL connection failed:', err.message);
        process.exit(1);
    });

// MongoDB Connection (optional)
// backend/src/config/database.ts
export const connectMongoDB = async () => {
    const isEnabled = process.env.MONGODB_ENABLED === 'true';

    if (!isEnabled) {
        console.log('⚠️ MongoDB logging disabled (MONGODB_ENABLED=false)');
        return;
    }

    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
        console.log('⚠️ MongoDB URI not provided');
        return;
    }

    try {
        await mongoose.connect(mongoURI, {
            serverSelectionTimeoutMS: 5000,
        });
        console.log('✅ MongoDB connected for logging');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
    }
};

// Winston Logger
export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console()
    ]
});

// Activity Log Model (MongoDB) - with fallback for when MongoDB is not available
let ActivityLog: any = {
    create: async (data: any) => {
        // Log to console instead
        console.log('[LOG]', data);
        return { _id: Date.now().toString() };
    },
    find: () => ({
        sort: () => ({
            limit: () => [],
            skip: () => ({
                limit: () => []
            })
        })
    }),
    countDocuments: async () => 0
};

// Try to use real MongoDB if available
try {
    const activityLogSchema = new mongoose.Schema({
        userId: { type: String, required: true },
        action: { type: String, required: true },
        entityType: { type: String, required: true },
        entityId: { type: String },
        details: { type: mongoose.Schema.Types.Mixed },
        ipAddress: { type: String },
        userAgent: { type: String },
        timestamp: { type: Date, default: Date.now }
    });

    // Only create model if mongoose is connected
    if (mongoose.connection.readyState === 1) {
        ActivityLog = mongoose.model('ActivityLog', activityLogSchema);
    }
} catch (error) {
    // Use fallback
}

export { ActivityLog };