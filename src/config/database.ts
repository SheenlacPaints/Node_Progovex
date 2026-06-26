import sql from 'mssql';
import mongoose from 'mongoose';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

// SQL Server Connection Configuration
const sqlConfig: sql.config = {
    user: process.env.SQL_SERVER_USER || 'sa',
    password: process.env.SQL_SERVER_PASSWORD || '',
    server: process.env.SQL_SERVER_HOST || 'localhost',
    port: parseInt(process.env.SQL_SERVER_PORT || '1433'),
    database: process.env.SQL_SERVER_DATABASE || 'social_platform',
    options: {
        encrypt: process.env.SQL_SERVER_ENCRYPT === 'true',
        trustServerCertificate: process.env.SQL_SERVER_TRUST_SERVER_CERTIFICATE === 'true',
        enableArithAbort: true,
        connectTimeout: 30000,
        requestTimeout: 30000,
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
    },
    connectionTimeout: 30000,
};

// SQL Server Connection Pool
export let pool: sql.ConnectionPool | null = null;

// Function to get connection pool
export const getSQLConnection = async (): Promise<sql.ConnectionPool> => {
    try {
        if (pool) {
            // Check if pool is still connected
            try {
                const test = await pool.query('SELECT 1');
                if (test) {
                    return pool;
                }
            } catch (err) {
                console.log('⚠️ Pool connection lost, reconnecting...');
                pool = null;
            }
        }

        // Create new connection
        console.log('📡 Connecting to SQL Server...');
        pool = await sql.connect(sqlConfig);
        console.log('✅ SQL Server connected successfully');
        return pool;
    } catch (error) {
        console.error('❌ SQL Server connection failed:', error);
        throw error;
    }
};

// Function to execute queries with automatic connection handling
export const executeQuery = async <T = any>(
    query: string,
    params?: { [key: string]: any }
): Promise<T> => {
    const connection = await getSQLConnection();
    
    try {
        const request = connection.request();
        
        // Add parameters if provided
        if (params) {
            Object.keys(params).forEach(key => {
                request.input(key, params[key]);
            });
        }
        
        // Execute query
        const result = await request.query(query);
        return result.recordset as T;
    } catch (error) {
        console.error('❌ Query execution failed:', error);
        throw error;
    }
};

// Function to execute non-query (INSERT, UPDATE, DELETE)
export const executeNonQuery = async (
    query: string,
    params?: { [key: string]: any }
): Promise<any> => {
    const connection = await getSQLConnection();
    
    try {
        const request = connection.request();
        
        // Add parameters if provided
        if (params) {
            Object.keys(params).forEach(key => {
                request.input(key, params[key]);
            });
        }
        
        // Execute query
        const result = await request.query(query);
        return result;
    } catch (error) {
        console.error('❌ Non-query execution failed:', error);
        throw error;
    }
};

// Transaction helper
export const executeTransaction = async <T>(
    callback: (connection: sql.ConnectionPool) => Promise<T>
): Promise<T> => {
    const connection = await getSQLConnection();
    const transaction = new sql.Transaction(connection);
    
    try {
        await transaction.begin();
        const result = await callback(connection);
        await transaction.commit();
        return result;
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
};

// Close SQL connection (for graceful shutdown)
export const closeSQLConnection = async (): Promise<void> => {
    if (pool) {
        try {
            await pool.close();
            pool = null;
            console.log('✅ SQL Server connection closed');
        } catch (error) {
            console.error('❌ Error closing SQL Server connection:', error);
            throw error;
        }
    }
};

// MongoDB Connection (optional)
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