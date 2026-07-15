// backend/src/server.ts
import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';

import {
    getSQLConnection,
    connectMongoDB,
    closeSQLConnection
} from './config/database';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';

import authRoutes from './routes/authRoutes';
import postRoutes from './routes/postRoutes';
import gmailRoutes from './routes/gmail.routes';
import userRoutes from './routes/userRoutes';
import adminRoutes from './routes/adminRoutes';
import s3Routes from './routes/s3.routes';
import mediaRoutes from './routes/mediaRoutes';

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
    'https://devtaskflow.sheenlac.com',
    'https://devmeet.sheenlac.com',
    'http://devtaskflow.sheenlac.com',
    'http://localhost:4200',
    'http://localhost:3000',
    'http://127.0.0.1:4200',
    'https://localhost:4200'
];

const corsOptions = {
    origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('CORS blocked for origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Origin',
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Credentials'
    ],
    exposedHeaders: [
        'Authorization',
        'Content-Length',
        'X-Requested-With'
    ],
    maxAge: 86400
};

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    upgradeTimeout: 10000
});

app.set('io', io);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "unsafe-none" }
}));

app.use(compression());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

console.log('Server starting...');
console.log('Allowed Origins:', allowedOrigins);

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    const token = socket.handshake.auth.token;
    console.log('Token received:', token ? 'Yes' : 'No');

    socket.on('join_user', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined their room`);
    });

    socket.on('join_sync', (userId) => {
        socket.join(`sync_${userId}`);
        console.log(`User ${userId} joined sync room`);
    });

    socket.on('leave_sync', (userId) => {
        socket.leave(`sync_${userId}`);
        console.log(`User ${userId} left sync room`);
    });

    socket.on('join_post', (postId) => {
        socket.join(`post_${postId}`);
        console.log(`Socket ${socket.id} joined post ${postId}`);
    });

    socket.on('check_room', (data) => {
        console.log(`Checking rooms for socket:`, Array.from(socket.rooms));
        socket.emit('room_list', { rooms: Array.from(socket.rooms) });
    });

    socket.on('leave_post', (postId) => {
        socket.leave(`post_${postId}`);
        console.log(`Socket ${socket.id} left post ${postId}`);
    });

    socket.on('typing', (data) => {
        socket.to(`post_${data.postId}`).emit('user_typing', {
            userId: socket.data.userId,
            isTyping: data.isTyping
        });
    });

    socket.on('new_comment', (data) => {
        io.to(`post_${data.postId}`).emit('new_comment', data);
        console.log('New comment event emitted to post:', data.postId);
    });

    socket.on('react_post', (data) => {
        io.to(`post_${data.postId}`).emit('reaction_updated', data);
        console.log('Reaction update emitted to post:', data.postId);
    });

    socket.on('post_created', (data) => {
        io.emit('post_created', data);
        console.log('New post created event emitted');
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

app.use('/uploads', express.static(path.join(__dirname, '../uploads'), {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4200');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
    }
}));

app.use('/node/api/auth', authRoutes);
app.use('/node/api/posts', postRoutes);
app.use('/node/api/gmail', gmailRoutes);
app.use('/node/api/users', userRoutes);
app.use('/node/api/admin', adminRoutes);
app.use('/node/api/s3', s3Routes);
app.use('/node/api', apiLimiter);
app.use('/node/api/post/media', mediaRoutes);

app.get('/cors-test', (req: Request, res: Response) => {
    res.json({
        message: 'CORS is working!',
        origin: req.headers.origin || 'No origin',
        method: req.method,
        headers: req.headers,
        allowedOrigins: allowedOrigins
    });
});

app.get('/health', async (req: Request, res: Response) => {
    try {
        const connection = await getSQLConnection();
        await connection.query('SELECT 1');
        res.json({
            status: 'healthy',
            database: 'SQL Server connected',
            timestamp: new Date()
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            database: 'disconnected',
            error: String(error)
        });
    }
});

app.get('/socket-health', (req: Request, res: Response) => {
    res.json({
        status: 'ok',
        connections: io.engine.clientsCount,
        message: 'Socket.IO server is running'
    });
});

app.get('/', (req: Request, res: Response) => {
    res.json({
        message: 'Social Platform API',
        version: '1.0.0',
        socket: 'Socket.IO enabled',
        cors: {
            allowedOrigins: allowedOrigins,
            currentOrigin: req.headers.origin || 'No origin'
        }
    });
});

app.use(errorHandler);

connectMongoDB().catch(console.error);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`API URL: http://localhost:${PORT}/node/api`);
    console.log(`Socket.IO server ready on port ${PORT}`);
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(async () => {
        console.log('HTTP server closed');
        try {
            await closeSQLConnection();
        } catch (err) {
            console.error('Error closing SQL connection:', err);
        }
        process.exit(0);
    });
});

export { app, server, io };