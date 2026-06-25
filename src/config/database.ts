import mongoose from 'mongoose';
import winston from 'winston';
import dotenv from 'dotenv';
import sql from 'mssql';

dotenv.config();

// ==============================================
// SQL SERVER CONNECTION POOL
// ==============================================
const sqlServerConfig: sql.config = {
    user: process.env.MSSQL_USER || 'sa',
    password: process.env.MSSQL_PASSWORD || '',
    server: process.env.MSSQL_HOST || 'localhost',
    port: parseInt(process.env.MSSQL_PORT || '1433'),
    database: process.env.MSSQL_DATABASE || 'TASKENGINE',
    options: {
        encrypt: process.env.MSSQL_ENCRYPT === 'true',
        trustServerCertificate: process.env.MSSQL_TRUST_CERT === 'true',
        enableArithAbort: true,
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

let sqlServerPool: sql.ConnectionPool | null = null;

export const getSQLServerPool = async (): Promise<sql.ConnectionPool> => {
    if (!sqlServerPool) {
        try {
            sqlServerPool = await sql.connect(sqlServerConfig);
            console.log('✅ SQL Server connected successfully');
            
            // Test connection
            const result = await sqlServerPool.request().query('SELECT 1 as test');
            console.log('✅ SQL Server test query successful');
        } catch (err) {
            console.error('❌ SQL Server connection failed:', err);
            throw err;
        }
    }
    return sqlServerPool;
};

export const testSQLServerConnection = async (): Promise<boolean> => {
    try {
        const pool = await getSQLServerPool();
        await pool.request().query('SELECT 1');
        return true;
    } catch (error) {
        return false;
    }
};

// ==============================================
// MONGODB CONNECTION (optional)
// ==============================================
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

// ==============================================
// WINSTON LOGGER
// ==============================================
export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// ==============================================
// ACTIVITY LOG (MongoDB fallback)
// ==============================================
let ActivityLog: any = {
    create: async (data: any) => {
        logger.info('Activity Log:', data);
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

    if (mongoose.connection.readyState === 1) {
        ActivityLog = mongoose.model('ActivityLog', activityLogSchema);
    }
} catch (error) {
    // Use fallback
}

export { ActivityLog };