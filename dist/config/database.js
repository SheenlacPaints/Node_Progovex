"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActivityLog = exports.logger = exports.connectMongoDB = exports.testSQLServerConnection = exports.getSQLServerPool = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const winston_1 = __importDefault(require("winston"));
const dotenv_1 = __importDefault(require("dotenv"));
const mssql_1 = __importDefault(require("mssql"));
dotenv_1.default.config();
// ==============================================
// SQL SERVER CONNECTION POOL
// ==============================================
const sqlServerConfig = {
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
let sqlServerPool = null;
const getSQLServerPool = async () => {
    if (!sqlServerPool) {
        try {
            sqlServerPool = await mssql_1.default.connect(sqlServerConfig);
            console.log('✅ SQL Server connected successfully');
            // Test connection
            const result = await sqlServerPool.request().query('SELECT 1 as test');
            console.log('✅ SQL Server test query successful');
        }
        catch (err) {
            console.error('❌ SQL Server connection failed:', err);
            throw err;
        }
    }
    return sqlServerPool;
};
exports.getSQLServerPool = getSQLServerPool;
const testSQLServerConnection = async () => {
    try {
        const pool = await (0, exports.getSQLServerPool)();
        await pool.request().query('SELECT 1');
        return true;
    }
    catch (error) {
        return false;
    }
};
exports.testSQLServerConnection = testSQLServerConnection;
// ==============================================
// MONGODB CONNECTION (optional)
// ==============================================
const connectMongoDB = async () => {
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
        await mongoose_1.default.connect(mongoURI, {
            serverSelectionTimeoutMS: 5000,
        });
        console.log('✅ MongoDB connected for logging');
    }
    catch (error) {
        console.error('❌ MongoDB connection error:', error);
    }
};
exports.connectMongoDB = connectMongoDB;
// ==============================================
// WINSTON LOGGER
// ==============================================
exports.logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [
        new winston_1.default.transports.File({ filename: 'error.log', level: 'error' }),
        new winston_1.default.transports.File({ filename: 'combined.log' }),
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple())
        })
    ]
});
// ==============================================
// ACTIVITY LOG (MongoDB fallback)
// ==============================================
let ActivityLog = {
    create: async (data) => {
        exports.logger.info('Activity Log:', data);
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
exports.ActivityLog = ActivityLog;
// Try to use real MongoDB if available
try {
    const activityLogSchema = new mongoose_1.default.Schema({
        userId: { type: String, required: true },
        action: { type: String, required: true },
        entityType: { type: String, required: true },
        entityId: { type: String },
        details: { type: mongoose_1.default.Schema.Types.Mixed },
        ipAddress: { type: String },
        userAgent: { type: String },
        timestamp: { type: Date, default: Date.now }
    });
    if (mongoose_1.default.connection.readyState === 1) {
        exports.ActivityLog = ActivityLog = mongoose_1.default.model('ActivityLog', activityLogSchema);
    }
}
catch (error) {
    // Use fallback
}
//# sourceMappingURL=database.js.map