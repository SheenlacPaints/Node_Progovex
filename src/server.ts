// backend/src/server.ts
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';

// Import configurations
import { connectMongoDB, getSQLServerPool, testSQLServerConnection } from './config/database';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';

// Import routes
import authRoutes from './routes/authRoutes';
import postRoutes from './routes/postRoutes';
import emailRoutes from './routes/emailRoutes';
import userRoutes from './routes/userRoutes';
import adminRoutes from './routes/adminRoutes';

const app = express();
const server = http.createServer(app);

// ==============================================
// SOCKET.IO SETUP
// ==============================================
const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:4200', 'http://localhost:3000', 'http://127.0.0.1:4200'],
        credentials: true,
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});

// Make io accessible to routes
app.set('io', io);

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);

    // Get token from handshake
    const token = socket.handshake.auth.token;
    console.log('🔑 Token received:', token ? 'Yes' : 'No');

    // Store userId in socket data for later use
    socket.on('authenticate', (userId) => {
        socket.data.userId = userId;
        socket.join(`user_${userId}`);
        console.log(`👤 User ${userId} authenticated and joined their room`);
    });

    // Join user-specific room
    socket.on('join_user', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`👤 User ${userId} joined their room`);
    });

    // Join post room for real-time updates
    socket.on('join_post', (postId) => {
        socket.join(`post_${postId}`);
        console.log(`📝 Socket ${socket.id} joined post ${postId}`);
    });

    socket.on('check_room', () => {
        console.log(`🔍 Checking rooms for socket:`, Array.from(socket.rooms));
        socket.emit('room_list', { rooms: Array.from(socket.rooms) });
    });

    socket.on('leave_post', (postId) => {
        socket.leave(`post_${postId}`);
        console.log(`📝 Socket ${socket.id} left post ${postId}`);
    });

    // Handle typing indicators
    socket.on('typing', (data) => {
        socket.to(`post_${data.postId}`).emit('user_typing', {
            userId: socket.data.userId || data.userId,
            isTyping: data.isTyping
        });
    });

    // Handle new comment (broadcast to post room)
    socket.on('new_comment', (data) => {
        io.to(`post_${data.postId}`).emit('new_comment', data);
        console.log('📝 New comment event emitted to post:', data.postId);
    });

    // Handle reaction updates
    socket.on('react_post', (data) => {
        io.to(`post_${data.postId}`).emit('reaction_updated', data);
        console.log('❤️ Reaction update emitted to post:', data.postId);
    });

    // Handle new post created
    socket.on('post_created', (data) => {
        io.emit('post_created', data);
        console.log('📰 New post created event emitted');
    });

    // Handle post approved
    socket.on('post_approved', (data) => {
        io.emit('post_approved', data);
        console.log('✅ Post approved event emitted:', data.postId);
    });

    // Handle post rejected
    socket.on('post_rejected', (data) => {
        io.emit('post_rejected', data);
        console.log('❌ Post rejected event emitted:', data.postId);
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ==============================================
// ENVIRONMENT LOGGING
// ==============================================
console.log('🚀 Server Environment:');
console.log(`📦 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`🔗 PORT: ${process.env.PORT || 3000}`);

// Database configuration
console.log('\n📊 Database Configuration:');
console.log('SQL Server:');
console.log(`  - Host: ${process.env.MSSQL_HOST || 'localhost'}`);
console.log(`  - Port: ${process.env.MSSQL_PORT || '1433'}`);
console.log(`  - Database: ${process.env.MSSQL_DATABASE || 'TASKENGINE'}`);
console.log(`  - User: ${process.env.MSSQL_USER || 'sa'}`);
console.log(`  - Password: ${process.env.MSSQL_PASSWORD ? '***SET***' : 'NOT SET'}`);

// ==============================================
// MIDDLEWARE
// ==============================================

// Security middleware
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
}));

app.use(compression());

// CORS configuration
const corsOptions = {
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:4200', 'http://localhost:3000', 'http://127.0.0.1:4200'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Authorization', 'Content-Length', 'X-Requested-With']
};

app.use(cors(corsOptions));

// Handle preflight requests for all routes
app.options('*', cors(corsOptions));

// Body parsing middleware
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Rate limiting
app.use('/api', apiLimiter);

// ==============================================
// STATIC FILE SERVING
// ==============================================

// Serve uploaded files statically
app.use('/uploads', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN?.split(',')[0] || 'http://localhost:4200');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    res.header('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
}, express.static(path.join(__dirname, '../uploads'), {
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN?.split(',')[0] || 'http://localhost:4200');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
}));

// Also serve from root uploads folder
app.use('/uploads', express.static('uploads'));

// ==============================================
// ROUTES
// ==============================================

app.use('/api/auth', authRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);

// ==============================================
// HEALTH CHECK ENDPOINTS
// ==============================================

// Basic health check
app.get('/health', async (req, res) => {
    const status = {
        status: 'healthy',
        timestamp: new Date(),
        services: {
            server: 'running',
            socketio: 'running'
        }
    };

    // Check SQL Server
    try {
        const sqlServerStatus = await testSQLServerConnection();
        status.services['sql_server'] = sqlServerStatus ? 'connected' : 'disconnected';
    } catch (error) {
        status.services['sql_server'] = 'disconnected';
        status.status = 'degraded';
    }

    res.json(status);
});

// Socket.IO health check endpoint
app.get('/socket-health', (req, res) => {
    res.json({
        status: 'ok',
        connections: io.engine.clientsCount,
        message: 'Socket.IO server is running',
        timestamp: new Date()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Social Platform API',
        version: '1.0.0',
        socket: 'Socket.IO enabled',
        timestamp: new Date(),
        endpoints: {
            auth: '/api/auth',
            posts: '/api/posts',
            users: '/api/users',
            admin: '/api/admin',
            socket: '/socket.io',
            health: '/health',
            socketHealth: '/socket-health'
        }
    });
});

// ==============================================
// ERROR HANDLING
// ==============================================

app.use(errorHandler);

// ==============================================
// DATABASE CONNECTIONS
// ==============================================

// Connect to SQL Server
getSQLServerPool()
    .then(() => {
        console.log('✅ SQL Server connected successfully');
    })
    .catch((err) => {
        console.error('❌ SQL Server connection failed:', err.message);
        console.warn('⚠️ Continuing with limited functionality...');
    });

// Connect to MongoDB (optional)
connectMongoDB().catch(console.error);

// ==============================================
// START SERVER
// ==============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 API URL: http://localhost:${PORT}/api`);
    console.log(`🔌 Socket.IO: http://localhost:${PORT}`);
    console.log(`📊 Health Check: http://localhost:${PORT}/health`);
    console.log('='.repeat(50) + '\n');
});

// ==============================================
// GRACEFUL SHUTDOWN
// ==============================================

const gracefulShutdown = async () => {
    console.log('\n🛑 Received shutdown signal...');

    // Close HTTP server
    server.close(() => {
        console.log('✅ HTTP server closed');
    });

    // Close SQL Server connection
    try {
        const pool = await getSQLServerPool();
        await pool.close();
        console.log('✅ SQL Server connection closed');
    } catch (error) {
        console.warn('⚠️ Error closing SQL Server connection:', error);
    }

    // Close MongoDB connection
    try {
        // await mongoose?.disconnect();
        console.log('✅ MongoDB connection closed');
    } catch (error) {
        console.warn('⚠️ Error closing MongoDB connection:', error);
    }

    process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown();
});

export { app, server, io };