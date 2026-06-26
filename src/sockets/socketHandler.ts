import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { getSQLConnection, executeQuery } from '../config/database';
import { verify } from 'jsonwebtoken';
import sql from 'mssql';

export let io: SocketServer;

export const initializeSocket = (server: HttpServer) => {
    io = new SocketServer(server, {
        cors: {
            origin: process.env.FRONTEND_URL || 'http://localhost:4200',
            methods: ['GET', 'POST'],
            credentials: true
        },
        transports: ['websocket', 'polling']
    });

    // Authentication middleware for socket
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token;
        console.log('🔑 Socket auth token:', token ? 'Present' : 'Missing');
        
        if (!token) {
            console.log('❌ Socket authentication failed: No token provided');
            return next(new Error('Authentication required'));
        }

        try {
            const decoded = verify(token, process.env.JWT_SECRET!) as any;
            console.log('✅ Socket token verified for user:', decoded.id || decoded.username);

            // Verify session in SQL Server - Using executeQuery
            try {
                const sessions = await executeQuery<any>(
                    'SELECT * FROM nt_sessions WHERE token = @token AND expires_at > GETDATE()',
                    { token }
                );

                if (!sessions || sessions.length === 0) {
                    console.log('❌ Socket authentication failed: Session expired or not found');
                    return next(new Error('Session expired'));
                }

                // Update session expiry
                await executeQuery(
                    'UPDATE nt_sessions SET expires_at = DATEADD(day, 7, GETDATE()) WHERE token = @token',
                    { token }
                );

            } catch (dbError) {
                console.error('⚠️ Database session check failed:', dbError);
                // Continue even if DB check fails for development
                // In production, you might want to reject
            }

            // Store user data in socket
            socket.data.user = {
                id: decoded.id || decoded.username || decoded.cuserid,
                username: decoded.username || decoded.cuser_name || 'user',
                email: decoded.email || decoded.cemail || '',
                role: decoded.role || decoded.crole_name || 'user'
            };
            
            console.log('✅ Socket authenticated for user:', socket.data.user.username);
            next();
        } catch (error) {
            console.error('❌ Socket authentication error:', error);
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket: Socket) => {
        const userId = socket.data.user?.id;
        const username = socket.data.user?.username;

        if (!userId) {
            console.log('❌ Socket connection rejected: No user ID');
            socket.disconnect();
            return;
        }

        // Join user's personal room
        socket.join(`user_${userId}`);
        console.log(`🟢 User ${username} (${userId}) connected: ${socket.id}`);

        // Send connection success
        socket.emit('connected', { 
            message: 'Connected to socket server',
            userId: userId,
            username: username,
            timestamp: new Date()
        });

        // Handle typing indicators
        socket.on('typing', (data: { postId: number, isTyping: boolean }) => {
            if (!data.postId) return;
            socket.to(`post_${data.postId}`).emit('user_typing', {
                userId,
                username,
                isTyping: data.isTyping,
                timestamp: new Date()
            });
        });

        // Handle post reactions
        socket.on('react_post', async (data: { postId: number, type: string }) => {
            if (!data.postId) return;
            
            console.log(`❤️ User ${username} reacted to post ${data.postId} with ${data.type}`);
            
            // Broadcast reaction to post viewers
            io.to(`post_${data.postId}`).emit('post_reaction', {
                userId,
                username,
                postId: data.postId,
                type: data.type,
                timestamp: new Date()
            });

            // Also emit to global feed
            io.emit('post_reaction_global', {
                userId,
                username,
                postId: data.postId,
                type: data.type,
                timestamp: new Date()
            });
        });

        // Handle comment reactions
        socket.on('react_comment', async (data: { commentId: number, type: string }) => {
            if (!data.commentId) return;
            
            console.log(`💬 User ${username} reacted to comment ${data.commentId} with ${data.type}`);
            
            io.to(`comment_${data.commentId}`).emit('comment_reaction', {
                userId,
                username,
                commentId: data.commentId,
                type: data.type,
                timestamp: new Date()
            });
        });

        // Handle new comment
        socket.on('new_comment', async (data: { postId: number, comment: any }) => {
            if (!data.postId || !data.comment) return;
            
            console.log(`💬 User ${username} commented on post ${data.postId}`);
            
            // Broadcast to post room
            io.to(`post_${data.postId}`).emit('new_comment', {
                postId: data.postId,
                comment: data.comment,
                userId: userId,
                username: username,
                timestamp: new Date()
            });

            // Also emit to global feed
            io.emit('new_comment_global', {
                postId: data.postId,
                comment: data.comment,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
        });

        // Join post room for real-time updates
        socket.on('join_post', (postId: number) => {
            if (!postId) return;
            
            socket.join(`post_${postId}`);
            console.log(`📌 User ${username} (${userId}) joined post room: post_${postId}`);
            
            // Send current room info
            const room = io.sockets.adapter.rooms.get(`post_${postId}`);
            const roomSize = room ? room.size : 0;
            console.log(`📊 Room post_${postId} has ${roomSize} users`);
            
            // Send room info back to client
            socket.emit('room_info', {
                postId: postId,
                roomSize: roomSize,
                userId: userId,
                timestamp: new Date()
            });
        });

        // Leave post room
        socket.on('leave_post', (postId: number) => {
            if (!postId) return;
            
            socket.leave(`post_${postId}`);
            console.log(`📌 User ${username} (${userId}) left post room: post_${postId}`);
        });

        // Handle join user room
        socket.on('join_user', (targetUserId: number) => {
            if (!targetUserId) return;
            
            socket.join(`user_${targetUserId}`);
            console.log(`👤 User ${username} (${userId}) joined user room: user_${targetUserId}`);
        });

        // Handle leave user room
        socket.on('leave_user', (targetUserId: number) => {
            if (!targetUserId) return;
            
            socket.leave(`user_${targetUserId}`);
            console.log(`👤 User ${username} (${userId}) left user room: user_${targetUserId}`);
        });

        // Handle new post notification
        socket.on('new_post', async (data: { post: any }) => {
            if (!data.post) return;
            
            console.log(`📰 User ${username} created a new post: ${data.post.id}`);
            
            // Broadcast to all users
            io.emit('new_post_global', {
                post: data.post,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
        });

        // Handle post update
        socket.on('update_post', async (data: { postId: number, updates: any }) => {
            if (!data.postId || !data.updates) return;
            
            console.log(`📝 User ${username} updated post: ${data.postId}`);
            
            // Broadcast to post room
            io.to(`post_${data.postId}`).emit('post_updated', {
                postId: data.postId,
                updates: data.updates,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
        });

        // Handle delete post
        socket.on('delete_post', async (data: { postId: number }) => {
            if (!data.postId) return;
            
            console.log(`🗑️ User ${username} deleted post: ${data.postId}`);
            
            // Broadcast to post room
            io.to(`post_${data.postId}`).emit('post_deleted', {
                postId: data.postId,
                userId: userId,
                username: username,
                timestamp: new Date()
            });

            // Also emit globally
            io.emit('post_deleted_global', {
                postId: data.postId,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
        });

        // Handle notification read
        socket.on('notification_read', async (data: { notificationId: number }) => {
            if (!data.notificationId) return;
            
            console.log(`🔔 User ${username} read notification: ${data.notificationId}`);
            
            // Update notification in database
            try {
                await executeQuery(
                    `UPDATE nt_notifications 
                     SET is_read = 1 
                     WHERE id = @notificationId AND cuserid = @userId`,
                    { 
                        notificationId: data.notificationId, 
                        userId: userId 
                    }
                );
                
                // Emit to user room
                io.to(`user_${userId}`).emit('notification_updated', {
                    notificationId: data.notificationId,
                    isRead: true,
                    timestamp: new Date()
                });
            } catch (error) {
                console.error('Error marking notification as read:', error);
            }
        });

        // Handle mark all notifications as read
        socket.on('mark_all_notifications_read', async () => {
            console.log(`🔔 User ${username} marked all notifications as read`);
            
            try {
                await executeQuery(
                    `UPDATE nt_notifications 
                     SET is_read = 1 
                     WHERE cuserid = @userId AND is_read = 0`,
                    { userId: userId }
                );
                
                // Emit to user room
                io.to(`user_${userId}`).emit('all_notifications_read', {
                    userId: userId,
                    timestamp: new Date()
                });
            } catch (error) {
                console.error('Error marking all notifications as read:', error);
            }
        });

        // Handle get room size
        socket.on('get_room_size', (postId: number) => {
            if (!postId) return;
            
            const room = io.sockets.adapter.rooms.get(`post_${postId}`);
            const roomSize = room ? room.size : 0;
            
            socket.emit('room_size', {
                postId: postId,
                roomSize: roomSize,
                timestamp: new Date()
            });
        });

        // Handle get online users count
        socket.on('get_online_users', () => {
            const onlineUsers = getConnectedUsers();
            socket.emit('online_users', {
                count: onlineUsers.length,
                users: onlineUsers,
                timestamp: new Date()
            });
        });

        // Handle poll vote update
        socket.on('poll_vote', async (data: { postId: number, optionId: number, pollData: any }) => {
            if (!data.postId || !data.optionId) return;
            
            console.log(`📊 User ${username} voted on poll ${data.postId}`);
            
            // Broadcast to post room
            io.to(`post_${data.postId}`).emit('poll_updated', {
                postId: data.postId,
                pollData: data.pollData,
                userId: userId,
                optionId: data.optionId,
                timestamp: new Date()
            });
        });

        // Handle disconnect
        socket.on('disconnect', () => {
            console.log(`🔴 User ${username} (${userId}) disconnected: ${socket.id}`);
        });

        // Handle error
        socket.on('error', (error) => {
            console.error(`❌ Socket error for user ${username} (${userId}):`, error);
        });
    });

    console.log('🔌 Socket.IO server initialized');
    return io;
};

// Helper function to emit to post room
export const emitToPostRoom = (postId: number, event: string, data: any) => {
    if (io) {
        // Emit to post room
        io.to(`post_${postId}`).emit(event, {
            ...data,
            timestamp: new Date()
        });
        console.log(`📤 Emitted ${event} for post ${postId} to room`);
    }
};

// Helper function to emit to user room
export const emitToUser = (userId: number, event: string, data: any) => {
    if (io) {
        io.to(`user_${userId}`).emit(event, {
            ...data,
            timestamp: new Date()
        });
        console.log(`📤 Emitted ${event} to user ${userId}`);
    }
};

// Helper function to emit to all users
export const emitToAll = (event: string, data: any) => {
    if (io) {
        io.emit(event, {
            ...data,
            timestamp: new Date()
        });
        console.log(`📤 Emitted ${event} to all users`);
    }
};

// Helper to get room size
export const getRoomSize = (roomName: string): number => {
    if (!io) return 0;
    const room = io.sockets.adapter.rooms.get(roomName);
    return room ? room.size : 0;
};

// Helper to get all connected users
export const getConnectedUsers = (): string[] => {
    if (!io) return [];
    const users: string[] = [];
    const rooms = io.sockets.adapter.rooms;
    
    for (const [roomName, room] of rooms) {
        if (roomName.startsWith('user_') && room.size > 0) {
            const userId = roomName.replace('user_', '');
            users.push(userId);
        }
    }
    
    return users;
};

// Helper to emit to multiple post rooms
export const emitToMultiplePosts = (postIds: number[], event: string, data: any) => {
    if (io) {
        postIds.forEach(postId => {
            io.to(`post_${postId}`).emit(event, {
                ...data,
                timestamp: new Date()
            });
        });
        console.log(`📤 Emitted ${event} to ${postIds.length} post rooms`);
    }
};

// Helper to check if user is online
export const isUserOnline = (userId: number): boolean => {
    if (!io) return false;
    const room = io.sockets.adapter.rooms.get(`user_${userId}`);
    return room ? room.size > 0 : false;
};

// Helper to get online users count
export const getOnlineUsersCount = (): number => {
    if (!io) return 0;
    let count = 0;
    const rooms = io.sockets.adapter.rooms;
    
    for (const [roomName, room] of rooms) {
        if (roomName.startsWith('user_')) {
            count += room.size;
        }
    }
    
    return count;
};

// Helper to broadcast typing status
export const broadcastTyping = (postId: number, userId: number, username: string, isTyping: boolean) => {
    if (io) {
        io.to(`post_${postId}`).emit('user_typing', {
            userId,
            username,
            isTyping,
            timestamp: new Date()
        });
    }
};

// Helper to broadcast new comment
export const broadcastNewComment = (postId: number, comment: any, userId: number, username: string) => {
    if (io) {
        const data = {
            postId,
            comment,
            userId,
            username,
            timestamp: new Date()
        };
        io.to(`post_${postId}`).emit('new_comment', data);
        io.emit('new_comment_global', data);
    }
};

// Helper to broadcast reaction update
export const broadcastReactionUpdate = (postId: number, userId: number, username: string, type: string) => {
    if (io) {
        const data = {
            postId,
            userId,
            username,
            type,
            timestamp: new Date()
        };
        io.to(`post_${postId}`).emit('reaction_updated', data);
        io.emit('reaction_updated_global', data);
    }
};

// Helper to broadcast post approved
export const broadcastPostApproved = (postId: number, post: any) => {
    if (io) {
        const data = {
            postId,
            post,
            timestamp: new Date()
        };
        io.emit('post_approved_live', data);
        io.to(`post_${postId}`).emit('post_status_changed', {
            postId,
            status: 'approved',
            post,
            timestamp: new Date()
        });
        console.log(`📤 Broadcast post approved for post ${postId}`);
    }
};

// Helper to broadcast post rejected
export const broadcastPostRejected = (postId: number, reason: string) => {
    if (io) {
        const data = {
            postId,
            reason,
            timestamp: new Date()
        };
        io.emit('post_rejected', data);
        io.to(`post_${postId}`).emit('post_status_changed', {
            postId,
            status: 'rejected',
            reason,
            timestamp: new Date()
        });
        console.log(`📤 Broadcast post rejected for post ${postId}`);
    }
};

// Helper to broadcast new post
export const broadcastNewPost = (post: any) => {
    if (io) {
        const data = {
            post,
            timestamp: new Date()
        };
        io.emit('post_created', data);
        io.emit('new_post_global', data);
        console.log(`📤 Broadcast new post ${post.id}`);
    }
};

// Helper to broadcast poll update
export const broadcastPollUpdate = (postId: number, pollData: any, userId: number, optionId: number) => {
    if (io) {
        const data = {
            postId,
            pollData,
            userId,
            optionId,
            timestamp: new Date()
        };
        io.to(`post_${postId}`).emit('poll_updated', data);
        console.log(`📤 Broadcast poll update for post ${postId}`);
    }
};