// backend/src/sockets/socketHandler.ts
import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { mysqlPool } from '../config/database';
import { verify } from 'jsonwebtoken';

export let io: SocketServer;

export const initializeSocket = (server: HttpServer) => {
    io = new SocketServer(server, {
        cors: {
            origin: process.env.FRONTEND_URL || 'http://localhost:4200',
            methods: ['GET', 'POST']
        }
    });

    // Authentication middleware for socket
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token;
        console.log('🔑 Socket auth token:', token);
        if (!token) {
            return next(new Error('Authentication required'));
        }

        try {
            const decoded = verify(token, process.env.JWT_SECRET!) as any;

            // Verify session
            const [sessions] = await mysqlPool.execute(
                'SELECT * FROM nt_sessions WHERE token = ? AND expires_at > NOW()',
                [token]
            );

            if ((sessions as any[]).length === 0) {
                return next(new Error('Session expired'));
            }

            socket.data.user = decoded;
            next();
        } catch (error) {
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket: Socket) => {
        const userId = socket.data.user.id;

        // Join user's personal room
        socket.join(`user_${userId}`);

        console.log(`🟢 User ${userId} connected: ${socket.id}`);

        // Handle typing indicators
        socket.on('typing', (data: { postId: number, isTyping: boolean }) => {
            socket.to(`post_${data.postId}`).emit('user_typing', {
                userId,
                isTyping: data.isTyping
            });
        });

        // Handle post reactions
        socket.on('react_post', async (data: { postId: number, type: string }) => {
            // Broadcast reaction to post viewers
            io.to(`post_${data.postId}`).emit('post_reaction', {
                userId,
                type: data.type
            });
        });

        // Handle comment reactions
        socket.on('react_comment', async (data: { commentId: number, type: string }) => {
            io.to(`comment_${data.commentId}`).emit('comment_reaction', {
                userId,
                type: data.type
            });
        });

        // Join post room for real-time updates
        socket.on('join_post', (postId: number) => {
            socket.join(`post_${postId}`);
            console.log(`📌 User ${userId} joined post room: post_${postId}`);
            
            // Send current room info
            const room = io.sockets.adapter.rooms.get(`post_${postId}`);
            const roomSize = room ? room.size : 0;
            console.log(`📊 Room post_${postId} has ${roomSize} users`);
        });

        socket.on('leave_post', (postId: number) => {
            socket.leave(`post_${postId}`);
            console.log(`📌 User ${userId} left post room: post_${postId}`);
        });

        socket.on('disconnect', () => {
            console.log(`🔴 User ${userId} disconnected: ${socket.id}`);
        });
    });

    return io;
};

// Helper function to emit to post room and all users
export const emitToPostRoom = (postId: number, event: string, data: any) => {
    if (io) {
        // Emit to post room
        io.to(`post_${postId}`).emit(event, data);
        
        // Also emit to global feed for users who are not in the post room
        io.emit(`${event}_global`, data);
        
        console.log(`📤 Emitted ${event} for post ${postId} to room and global`);
    }
};

// Helper to get room size
export const getRoomSize = (roomName: string): number => {
    if (!io) return 0;
    const room = io.sockets.adapter.rooms.get(roomName);
    return room ? room.size : 0;
};