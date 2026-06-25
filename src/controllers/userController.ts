// backend/src/controllers/userController.ts
import { Request, Response } from 'express';
import { mysqlPool, ActivityLog } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import bcrypt from 'bcryptjs';
import { processImage } from '../utils/fileUpload';

export const getUserProfile = async (req: AuthRequest, res: Response) => {
    const { username } = req.params;
    const currentUserId = req.user!.id;

    const query = username
        ? 'SELECT id, username, full_name, avatar_url, bio, created_at FROM users WHERE username = ?'
        : 'SELECT id, username, full_name, avatar_url, bio, created_at FROM users WHERE id = ?';

    const params = username ? [username] : [currentUserId];

    const [users] = await mysqlPool.execute(query, params);
    const user = (users as any[])[0];

    if (!user) {
        throw new AppError('User not found', 404);
    }

    // Get follower counts
    const [followers] = await mysqlPool.execute(
        'SELECT COUNT(*) as count FROM nt_follows WHERE following_id = ?',
        [user.id]
    );

    const [following] = await mysqlPool.execute(
        'SELECT COUNT(*) as count FROM nt_follows WHERE follower_id = ?',
        [user.id]
    );

    // Check if current user nt_follows this user
    const [isFollowing] = await mysqlPool.execute(
        'SELECT id FROM nt_follows WHERE follower_id = ? AND following_id = ?',
        [currentUserId, user.id]
    );

    res.json({
        success: true,
        user: {
            ...user,
            followers_count: (followers as any[])[0].count,
            following_count: (following as any[])[0].count,
            is_following: (isFollowing as any[]).length > 0
        }
    });
};

export const updateUserProfile = async (req: AuthRequest, res: Response) => {
    const { fullName, bio } = req.body;
    const userId = req.user!.id;

    await mysqlPool.execute(
        'UPDATE users SET full_name = ?, bio = ? WHERE id = ?',
        [fullName, bio, userId]
    );

    await ActivityLog.create({
        userId: userId.toString(),
        action: 'update_profile',
        entityType: 'user',
        details: { fullName, bio },
        ipAddress: req.ip
    });

    res.json({ success: true, message: 'Profile updated successfully' });
};

export const updateAvatar = async (req: AuthRequest, res: Response) => {
    // if (!req.file) {
    //     throw new AppError('No file uploaded', 400);
    // }

    // const avatarUrl = await processImage(req.file.buffer, req.file.originalname);
    // const userId = req.user!.id;

    // await mysqlPool.execute(
    //     'UPDATE users SET avatar_url = ? WHERE id = ?',
    //     [avatarUrl, userId]
    // );

    // res.json({ success: true, avatarUrl });
};

export const followUser = async (req: AuthRequest, res: Response) => {
    const followerId = req.user!.id;
    const followingId = parseInt(req.params.userId);

    if (followerId === followingId) {
        throw new AppError('Cannot follow yourself', 400);
    }

    // Check if user exists
    const [users] = await mysqlPool.execute(
        'SELECT id FROM users WHERE id = ?',
        [followingId]
    );

    if ((users as any[]).length === 0) {
        throw new AppError('User not found', 404);
    }

    try {
        await mysqlPool.execute(
            'INSERT INTO nt_follows (follower_id, following_id) VALUES (?, ?)',
            [followerId, followingId]
        );

        // Create notification
        await mysqlPool.execute(
            `INSERT INTO nt_notifications (cuserid, type, reference_id, content) 
       VALUES (?, 'follow', ?, ?)`,
            [followingId, followerId, `${req.user!.username} started following you`]
        );

        await ActivityLog.create({
            userId: followerId.toString(),
            action: 'follow',
            entityType: 'user',
            entityId: followingId.toString(),
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'User followed' });
    } catch (error: any) {
        if (error.code === 'ER_DUP_ENTRY') {
            throw new AppError('Already following this user', 400);
        }
        throw error;
    }
};

export const unfollowUser = async (req: AuthRequest, res: Response) => {
    const followerId = req.user!.id;
    const followingId = parseInt(req.params.userId);

    await mysqlPool.execute(
        'DELETE FROM nt_follows WHERE follower_id = ? AND following_id = ?',
        [followerId, followingId]
    );

    res.json({ success: true, message: 'User unfollowed' });
};

export const getFollowers = async (req: AuthRequest, res: Response) => {
    const userId = parseInt(req.params.userId);
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const [followers] = await mysqlPool.execute(
        `SELECT u.id, u.username, u.full_name, u.avatar_url 
     FROM nt_follows f 
     JOIN users u ON f.follower_id = u.id 
     WHERE f.following_id = ? 
     LIMIT ? OFFSET ?`,
        [userId, Number(limit), offset]
    );

    res.json({ success: true, followers, page, limit });
};

export const getFollowing = async (req: AuthRequest, res: Response) => {
    const userId = parseInt(req.params.userId);
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const [following] = await mysqlPool.execute(
        `SELECT u.id, u.username, u.full_name, u.avatar_url 
     FROM nt_follows f 
     JOIN users u ON f.following_id = u.id 
     WHERE f.follower_id = ? 
     LIMIT ? OFFSET ?`,
        [userId, Number(limit), offset]
    );

    res.json({ success: true, following, page, limit });
};

export const getUserPosts = async (req: AuthRequest, res: Response) => {
    const userId = parseInt(req.params.userId);
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const [posts] = await mysqlPool.execute(
        `SELECT p.*, 
     (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id) as likes_count,
     (SELECT COUNT(*) FROM nt_comments WHERE post_id = p.id) as comments_count
     FROM nt_posts p
     WHERE p.cuserid = ? AND p.status = 'approved'
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
        [userId, Number(limit), offset]
    );

    res.json({ success: true, posts, page, limit });
};

export const searchUsers = async (req: AuthRequest, res: Response) => {
    const { q, limit = 20 } = req.query;

    if (!q) {
        throw new AppError('Search query required', 400);
    }

    const [users] = await mysqlPool.execute(
        `SELECT id, username, full_name, avatar_url 
     FROM users 
     WHERE username LIKE ? OR full_name LIKE ?
     LIMIT ?`,
        [`%${q}%`, `%${q}%`, Number(limit)]
    );

    res.json({ success: true, users });
};

export const getNotifications = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        console.log('📥 Fetching notifications for user:', userId);
        console.log('📊 Page:', page, 'Limit:', limit, 'Offset:', offset);

        // Get connection from pool
        const connection = await mysqlPool.getConnection();
        
        try {
            // Simple query without placeholders first to test
            const query = `
                SELECT 
                    id, 
                    cuserid, 
                    from_user_id, 
                    type, 
                    reference_id, 
                    reference_type, 
                    content, 
                    is_read, 
                    created_at
                FROM nt_notifications 
                WHERE cuserid = ${userId}
                ORDER BY created_at DESC
                LIMIT ${limit} OFFSET ${offset}
            `;
            
            console.log('📝 Executing query:', query);
            
            const [notifications] = await connection.query(query);
            
            // Get unread count
            const unreadQuery = `
                SELECT COUNT(*) as count 
                FROM nt_notifications 
                WHERE cuserid = ${userId} AND is_read = 0
            `;
            const [unreadResult] = await connection.query(unreadQuery);
            
            connection.release();

            const unreadCount = (unreadResult as any[])[0]?.count || 0;
            console.log('📊 Notifications found:', (notifications as any[]).length);
            console.log('📊 Unread count:', unreadCount);

            // Format notifications
            const formattedNotifications = [];
            for (const notif of notifications as any[]) {
                let fromUser = null;
                if (notif.from_user_id) {
                    const [userResult] = await mysqlPool.execute(
                        'SELECT username, full_name, avatar_url FROM users WHERE id = ?',
                        [notif.from_user_id]
                    );
                    const userData = (userResult as any[])[0];
                    if (userData) {
                        fromUser = {
                            username: userData.username,
                            fullName: userData.full_name,
                            avatarUrl: userData.avatar_url
                        };
                    }
                }

                formattedNotifications.push({
                    id: notif.id,
                    userId: notif.cuserid,
                    fromUserId: notif.from_user_id,
                    type: notif.type,
                    referenceId: notif.reference_id,
                    referenceType: notif.reference_type || 'post',
                    content: notif.content || getDefaultNotificationContent(notif.type, fromUser),
                    isRead: notif.is_read === 1,
                    createdAt: notif.created_at,
                    fromUser: fromUser
                });
            }

            res.json({
                success: true,
                notifications: formattedNotifications,
                unreadCount: unreadCount,
                page,
                limit
            });
        } catch (err) {
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error in getNotifications:', error);
        res.json({
            success: true,
            notifications: [],
            unreadCount: 0,
            page: 1,
            limit: 20
        });
    }
};

// Helper function
function getDefaultNotificationContent(type: string, fromUser: any): string {
    const username = fromUser?.username || 'Someone';
    switch (type) {
        case 'like': return `${username} liked your post`;
        case 'comment': return `${username} commented on your post`;
        case 'follow': return `${username} started following you`;
        case 'approval': return 'Your post has been approved';
        case 'mention': return `${username} mentioned you`;
        case 'share': return `${username} shared your post`;
        default: return 'New notification';
    }
}

export const markNotificationRead = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const notificationId = req.params.id;

        console.log('📌 Marking notification as read:', notificationId, 'for user:', userId);

        const [result] = await mysqlPool.execute(
            'UPDATE nt_notifications SET is_read = 1 WHERE id = ? AND cuserid = ?',
            [notificationId, userId]
        );

        if ((result as any).affectedRows === 0) {
            console.log('Notification not found or already read');
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notification' });
    }
};

export const markAllAsRead = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        console.log('📌 Marking all notifications as read for user:', userId);

        const [result] = await mysqlPool.execute(
            'UPDATE nt_notifications SET is_read = 1 WHERE cuserid = ? AND is_read = 0',
            [userId]
        );

        console.log('Updated rows:', (result as any).affectedRows);

        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Error marking all as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notifications' });
    }
};

export const markAllNotificationsRead = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        console.log('📌 Marking all notifications as read for user:', userId);

        await mysqlPool.execute(
            'UPDATE nt_notifications SET is_read = true WHERE cuserid = ? AND is_read = false',
            [userId]
        );

        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notifications' });
    }
};

export const deleteNotification = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const notificationId = req.params.id;

    await mysqlPool.execute(
        'DELETE FROM nt_notifications WHERE id = ? AND cuserid = ?',
        [notificationId, userId]
    );

    res.json({ success: true });
};

export const getUserStats = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;

    const [postCount] = await mysqlPool.execute(
        'SELECT COUNT(*) as count FROM nt_posts WHERE cuserid = ?',
        [userId]
    );

    const [followersCount] = await mysqlPool.execute(
        'SELECT COUNT(*) as count FROM nt_follows WHERE following_id = ?',
        [userId]
    );

    const [followingCount] = await mysqlPool.execute(
        'SELECT COUNT(*) as count FROM nt_follows WHERE follower_id = ?',
        [userId]
    );

    const [totalLikes] = await mysqlPool.execute(
        `SELECT COUNT(*) as count FROM nt_reactions r 
     JOIN nt_posts p ON r.post_id = p.id 
     WHERE p.cuserid = ?`,
        [userId]
    );

    res.json({
        success: true,
        stats: {
            posts: (postCount as any[])[0].count,
            followers: (followersCount as any[])[0].count,
            following: (followingCount as any[])[0].count,
            totalLikes: (totalLikes as any[])[0].count
        }
    });
};

export const getActivityLog = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { limit = 50 } = req.query;

    const logs = await ActivityLog.find({ userId: userId.toString() })
        .sort({ timestamp: -1 })
        .limit(Number(limit));

    res.json({ success: true, logs });
};

export const changePassword = async (req: AuthRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user!.id;

    const [users] = await mysqlPool.execute(
        'SELECT password_hash FROM users WHERE id = ?',
        [userId]
    );

    const user = (users as any[])[0];

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
        throw new AppError('Current password is incorrect', 401);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await mysqlPool.execute(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [hashedPassword, userId]
    );

    // Invalidate all sessions
    await mysqlPool.execute(
        'DELETE FROM nt_sessions WHERE cuserid = ?',
        [userId]
    );

    res.json({ success: true, message: 'Password changed successfully' });
};

export const deactivateAccount = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { password } = req.body;

    const [users] = await mysqlPool.execute(
        'SELECT password_hash FROM users WHERE id = ?',
        [userId]
    );

    const user = (users as any[])[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
        throw new AppError('Invalid password', 401);
    }

    await mysqlPool.execute(
        'UPDATE users SET is_active = false WHERE id = ?',
        [userId]
    );

    await mysqlPool.execute(
        'DELETE FROM nt_sessions WHERE cuserid = ?',
        [userId]
    );

    res.json({ success: true, message: 'Account deactivated' });
};