// backend/src/controllers/adminController.ts
import { Request, Response } from 'express';
import { mysqlPool } from '../config/database';
import { ActivityLog } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import { sendEmail } from '../workers/emailWorker';

export const getPendingPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    console.log('Fetching pending posts:', { page, limit, offset });

    // OPTION 1: Use query() instead of execute() - Simpler and works better with LIMIT/OFFSET
    const query = `
            SELECT p.*, u.username, u.full_name, u.cemail 
            FROM nt_posts p
            JOIN users u ON p.cuserid = u.cuserid
            WHERE p.approval_status = 'waiting' AND p.status = 'pending'
            ORDER BY p.created_at ASC
            LIMIT ? OFFSET ?
        `;

    // Pass parameters as an array with exactly 2 values
    const [posts] = await mysqlPool.query(query, [limit, offset]);

    // Get total count - no parameters needed here
    const [countResult] = await mysqlPool.query(
      `SELECT COUNT(*) as total 
             FROM nt_posts p
             WHERE p.approval_status = 'waiting' AND p.status = 'pending'`
    );

    const total = (countResult as any[])[0]?.total || 0;

    console.log(`Found ${(posts as any[]).length} pending posts out of ${total} total`);

    res.json({
      success: true,
      posts: posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error getting pending posts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending posts',
      error: error.message
    });
  }
};

// Alternative version using execute() with correct parameter counting
export const getPendingPostsExecute = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    // For execute(), we need to use ? placeholders and pass an array
    const sql = `
            SELECT p.*, u.username, u.full_name, u.cemail 
            FROM nt_posts p
            JOIN users u ON p.cuserid = u.id
            WHERE p.approval_status = 'waiting' AND p.status = 'pending'
            ORDER BY p.created_at ASC
            LIMIT ? OFFSET ?
        `;

    // IMPORTANT: Pass exactly 2 parameters for the 2 placeholders
    const [posts] = await mysqlPool.execute(sql, [limit, offset]);

    const [countResult] = await mysqlPool.execute(
      `SELECT COUNT(*) as total 
             FROM nt_posts p
             WHERE p.approval_status = 'waiting' AND p.status = 'pending'`
    );

    const total = (countResult as any[])[0]?.total || 0;

    res.json({
      success: true,
      posts: posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error getting pending posts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending posts',
      error: error.message
    });
  }
};

// Get all posts for admin (with filters)
export const getAllPostsForAdmin = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string || 'all';
    const approvalStatus = req.query.approval_status as string || 'all';

    let sql = `
            SELECT p.*, u.username, u.full_name, u.cemail 
            FROM nt_posts p
            JOIN users u ON p.cuserid = u.id
            WHERE 1=1
        `;
    const params: any[] = [];

    if (status !== 'all') {
      sql += ` AND p.status = ?`;
      params.push(status);
    }

    if (approvalStatus !== 'all') {
      sql += ` AND p.approval_status = ?`;
      params.push(approvalStatus);
    }

    sql += ` ORDER BY p.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [posts] = await mysqlPool.query(sql, params);

    // Get total count
    let countSql = `SELECT COUNT(*) as total FROM nt_posts p WHERE 1=1`;
    const countParams: any[] = [];

    if (status !== 'all') {
      countSql += ` AND p.status = ?`;
      countParams.push(status);
    }

    if (approvalStatus !== 'all') {
      countSql += ` AND p.approval_status = ?`;
      countParams.push(approvalStatus);
    }

    const [countResult] = await mysqlPool.query(countSql, countParams);
    const total = (countResult as any[])[0]?.total || 0;

    res.json({
      success: true,
      posts: posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error getting posts for admin:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch posts',
      error: error.message
    });
  }
};

export const approvePost = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const adminId = req.user!.id;

    console.log('Approving post:', { postId: id, adminId });

    // Update post with approval status and set approved_at to NOW()
    const [result] = await mysqlPool.execute(
      `UPDATE nt_posts 
             SET approval_status = 'approved', 
                 status = 'approved', 
                 approved_by = ?, 
                 approved_at = NOW() 
             WHERE id = ? AND approval_status = 'waiting'`,
      [adminId, id]
    );

    if ((result as any).affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or already processed'
      });
    }

    // Get the approved post with all details including user info and parsed data
    const [posts] = await mysqlPool.query(
      `SELECT 
                p.*, 
                u.username, u.full_name, u.avatar_url, u.cemail,
                DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') as created_at_formatted,
                DATE_FORMAT(p.approved_at, '%Y-%m-%d %H:%i:%s') as approved_at_formatted
             FROM nt_posts p
             JOIN users u ON p.cuserid = u.cuserid
             WHERE p.id = ?`,
      [id]
    );

    const approvedPost = (posts as any[])[0];

    // Parse JSON fields for frontend
    approvedPost.mediaUrls = approvedPost.media_urls ? JSON.parse(approvedPost.media_urls) : [];
    approvedPost.hashtags = approvedPost.hashtags ? JSON.parse(approvedPost.hashtags) : [];
    approvedPost.pollData = approvedPost.poll_data ? JSON.parse(approvedPost.poll_data) : null;

    // Get user's vote for this post if it's a poll
    const [userVote] = await mysqlPool.execute(
      'SELECT option_id FROM nt_poll_votes WHERE post_id = ? AND cuserid = ?',
      [id, adminId]
    );
    approvedPost.userVotedOption = (userVote as any[])[0]?.option_id || null;

    // Log activity
    await mysqlPool.execute(
      `INSERT INTO nt_activity_logs (cuserid, action, entity_type, entity_id, details, ip_address, created_at) 
             VALUES (?, 'approve_post', 'post', ?, ?, ?, NOW())`,
      [adminId, id, JSON.stringify({
        postId: id,
        created_at: approvedPost.created_at,
        approved_at: approvedPost.approved_at
      }), req.ip || 'unknown']
    );

    // EMIT SOCKET EVENT FOR REAL-TIME UPDATE
    const io = req.app.get('io');
    if (io) {
      // Emit to all clients that a post was approved
      io.emit('post_approved_live', {
        post: approvedPost,
        postId: parseInt(id),
        approved_at: approvedPost.approved_at
      });

      // Also emit to the specific post room for detailed updates
      io.to(`post_${id}`).emit('post_status_changed', {
        postId: parseInt(id),
        status: 'approved',
        post: approvedPost
      });

      console.log(`📤 Emitted post_approved_live for post ${id}`);
    }

    res.json({
      success: true,
      message: 'Post approved successfully',
      post: approvedPost,
      created_at: approvedPost.created_at,
      approved_at: approvedPost.approved_at
    });
  } catch (error) {
    console.error('Error approving post:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve post',
      error: error.message
    });
  }
};

export const rejectPost = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user!.id;

    console.log('Rejecting post:', { postId: id, adminId, reason });

    // Update post status - approved_at remains NULL for rejected posts
    const [result] = await mysqlPool.execute(
      `UPDATE nt_posts 
       SET approval_status = 'rejected', 
           status = 'rejected', 
           approved_by = ?, 
           approved_at = NULL 
       WHERE id = ? AND (approval_status = 'waiting' OR approval_status = 'pending')`,
      [adminId, id]
    );

    if ((result as any).affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or already processed'
      });
    }

    // Log rejection reason (optional)
    if (reason) {
      await mysqlPool.execute(
        `INSERT INTO nt_post_rejection_logs (post_id, admin_id, reason, created_at) 
         VALUES (?, ?, ?, NOW())`,
        [id, adminId, reason]
      );
    }

    // Log activity
    await mysqlPool.execute(
      `INSERT INTO nt_activity_logs (cuserid, action, entity_type, entity_id, details, ip_address, created_at) 
       VALUES (?, 'reject_post', 'post', ?, ?, ?, NOW())`,
      [adminId, id, JSON.stringify({ reason: reason || 'No reason provided' }), req.ip || 'unknown']
    );

    // Emit socket event for real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('post_rejected', {
        postId: parseInt(id),
        reason: reason || 'No reason provided'
      });
    }

    res.json({
      success: true,
      message: 'Post rejected successfully'
    });
  } catch (error) {
    console.error('Error rejecting post:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject post',
      error: error.message
    });
  }
};

// Get post statistics for admin dashboard
export const getPostStats = async (req: AuthRequest, res: Response) => {
  try {
    const [stats] = await mysqlPool.query(`
            SELECT 
                COUNT(*) as total_posts,
                SUM(CASE WHEN approval_status = 'waiting' AND status = 'pending' THEN 1 ELSE 0 END) as pending_posts,
                SUM(CASE WHEN approval_status = 'approved' AND status = 'approved' THEN 1 ELSE 0 END) as approved_posts,
                SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) as rejected_posts,
                SUM(CASE WHEN type = 'poll' THEN 1 ELSE 0 END) as poll_posts,
                SUM(CASE WHEN type = 'text' THEN 1 ELSE 0 END) as text_posts,
                SUM(CASE WHEN media_urls != '[]' AND media_urls IS NOT NULL THEN 1 ELSE 0 END) as posts_with_media
            FROM nt_posts
        `);

    res.json({
      success: true,
      stats: (stats as any[])[0]
    });
  } catch (error) {
    console.error('Error getting post stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch post statistics',
      error: error.message
    });
  }
};

export const bulkApprovePosts = async (req: AuthRequest, res: Response) => {
  const { postIds } = req.body;
  const adminId = req.user!.id;

  if (!postIds || !Array.isArray(postIds)) {
    throw new AppError('Invalid post IDs', 400);
  }

  for (const postId of postIds) {
    await mysqlPool.execute(
      `UPDATE nt_posts 
       SET status = 'approved', 
           approval_status = 'approved', 
           approved_by = ?, 
           approved_at = NOW() 
       WHERE id = ? AND approval_status = 'waiting'`,
      [adminId, postId]
    );
  }

  res.json({ success: true, message: `${postIds.length} posts approved` });
};

export const bulkRejectPosts = async (req: AuthRequest, res: Response) => {
  const { postIds } = req.body;
  const adminId = req.user!.id;

  if (!postIds || !Array.isArray(postIds)) {
    throw new AppError('Invalid post IDs', 400);
  }

  for (const postId of postIds) {
    await mysqlPool.execute(
      `UPDATE nt_posts SET status = "rejected", approval_status = "rejected" WHERE id = ? AND approval_status = 'waiting'`,
      [postId]
    );
  }

  res.json({ success: true, message: `${postIds.length} posts rejected` });
};

export const getAllUsers = async (req: AuthRequest, res: Response) => {
  const { page = 1, limit = 20, role, is_active } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  let query = 'SELECT id, username, cemail, full_name, role, is_active, email_verified, created_at FROM users WHERE 1=1';
  const params: any[] = [];

  if (role) {
    query += ' AND role = ?';
    params.push(role);
  }

  if (is_active !== undefined) {
    query += ' AND is_active = ?';
    params.push(is_active === 'true');
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), offset);

  const [users] = await mysqlPool.execute(query, params);

  const [total] = await mysqlPool.execute(
    'SELECT COUNT(*) as total FROM users'
  );

  res.json({
    success: true,
    users,
    total: (total as any[])[0].total,
    page: Number(page),
    limit: Number(limit)
  });
};

export const updateUserRole = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!['user', 'moderator', 'admin'].includes(role)) {
    throw new AppError('Invalid role', 400);
  }

  await mysqlPool.execute(
    'UPDATE users SET role = ? WHERE id = ?',
    [role, id]
  );

  await ActivityLog.create({
    userId: req.user!.id.toString(),
    action: 'update_user_role',
    entityType: 'user',
    entityId: id,
    details: { role },
    ipAddress: req.ip
  });

  res.json({ success: true, message: 'User role updated' });
};

export const suspendUser = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;

  await mysqlPool.execute(
    'UPDATE users SET is_active = false WHERE id = ?',
    [id]
  );

  await mysqlPool.execute('DELETE FROM nt_sessions WHERE cuserid = ?', [id]);

  await ActivityLog.create({
    userId: req.user!.id.toString(),
    action: 'suspend_user',
    entityType: 'user',
    entityId: id,
    details: { reason },
    ipAddress: req.ip
  });

  res.json({ success: true, message: 'User suspended' });
};

export const activateUser = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  await mysqlPool.execute(
    'UPDATE users SET is_active = true WHERE id = ?',
    [id]
  );

  res.json({ success: true, message: 'User activated' });
};

export const deleteUser = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  await mysqlPool.execute('DELETE FROM users WHERE id = ?', [id]);

  await ActivityLog.create({
    userId: req.user!.id.toString(),
    action: 'delete_user',
    entityType: 'user',
    entityId: id,
    ipAddress: req.ip
  });

  res.json({ success: true, message: 'User deleted' });
};

export const getSystemStats = async (req: AuthRequest, res: Response) => {
  const [totalUsers] = await mysqlPool.execute('SELECT COUNT(*) as count FROM users');
  const [totalPosts] = await mysqlPool.execute('SELECT COUNT(*) as count FROM nt_posts');
  const [pendingPosts] = await mysqlPool.execute('SELECT COUNT(*) as count FROM nt_posts WHERE approval_status = "waiting"');
  const [totalComments] = await mysqlPool.execute('SELECT COUNT(*) as count FROM nt_comments');
  const [totalReactions] = await mysqlPool.execute('SELECT COUNT(*) as count FROM nt_reactions');

  const [postsByDay] = await mysqlPool.execute(
    `SELECT DATE(created_at) as date, COUNT(*) as count 
     FROM nt_posts 
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
     GROUP BY DATE(created_at)`
  );

  res.json({
    success: true,
    stats: {
      totalUsers: (totalUsers as any[])[0].count,
      totalPosts: (totalPosts as any[])[0].count,
      pendingPosts: (pendingPosts as any[])[0].count,
      totalComments: (totalComments as any[])[0].count,
      totalReactions: (totalReactions as any[])[0].count,
      postsByDay
    }
  });
};

export const getActivityLogs = async (req: AuthRequest, res: Response) => {
  const { page = 1, limit = 50, action, userId } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const filter: any = {};
  if (action) filter.action = action;
  if (userId) filter.userId = userId;

  const logs = await ActivityLog.find(filter)
    .sort({ timestamp: -1 })
    .skip(offset)
    .limit(Number(limit));

  const total = await ActivityLog.countDocuments(filter);

  res.json({
    success: true,
    logs,
    total,
    page: Number(page),
    limit: Number(limit)
  });
};

export const getReportedPosts = async (req: AuthRequest, res: Response) => {
  const [reports] = await mysqlPool.execute(
    `SELECT r.*, p.content, p.cuserid as post_owner_id, 
     u.username as reporter_username, u2.username as post_owner_username
     FROM nt_reports r
     JOIN nt_posts p ON r.post_id = p.id
     JOIN users u ON r.cuserid = u.id
     JOIN users u2 ON p.cuserid = u2.id
     WHERE r.resolved = false
     ORDER BY r.created_at DESC`
  );

  res.json({ success: true, reports: reports });
};

export const resolveReport = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { action } = req.body;

  if (action === 'delete_post') {
    const [reports] = await mysqlPool.execute(
      'SELECT post_id FROM nt_reports WHERE id = ?',
      [id]
    );
    const report = (reports as any[])[0];

    if (report) {
      await mysqlPool.execute('UPDATE nt_posts SET status = "deleted" WHERE id = ?', [report.post_id]);
    }
  }

  await mysqlPool.execute(
    'UPDATE nt_reports SET resolved = true, resolved_by = ?, resolved_at = NOW() WHERE id = ?',
    [req.user!.id, id]
  );

  res.json({ success: true });
};

export const getAnalytics = async (req: AuthRequest, res: Response) => {
  const { period = 'week' } = req.query;
  let days = 7;

  if (period === 'month') {
    days = 30;
  } else if (period === 'year') {
    days = 365;
  }

  const [userGrowth] = await mysqlPool.execute(
    `SELECT DATE(created_at) as date, COUNT(*) as new_users 
     FROM users 
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(created_at)`,
    [days]
  );

  const [postActivity] = await mysqlPool.execute(
    `SELECT DATE(created_at) as date, COUNT(*) as posts 
     FROM nt_posts 
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(created_at)`,
    [days]
  );

  const [topContributors] = await mysqlPool.execute(
    `SELECT u.username, COUNT(p.id) as post_count 
     FROM users u
     JOIN nt_posts p ON u.id = p.cuserid
     WHERE p.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
     GROUP BY u.id
     ORDER BY post_count DESC
     LIMIT 10`
  );

  res.json({
    success: true,
    analytics: {
      userGrowth,
      postActivity,
      topContributors,
      period
    }
  });
};

export const sendAnnouncement = async (req: AuthRequest, res: Response) => {
  const { title, message, audience = 'all' } = req.body;

  let userQuery = 'SELECT cemail, username FROM users WHERE is_active = true';
  if (audience === 'active') {
    userQuery += ' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
  }

  const [users] = await mysqlPool.execute(userQuery);

  for (const user of users as any[]) {
    await sendEmail(
      user.cemail,
      title,
      'announcement',
      { name: user.username, message, title }
    );
  }

  await ActivityLog.create({
    userId: req.user!.id.toString(),
    action: 'send_announcement',
    entityType: 'system',
    details: { title, audience, recipientCount: (users as any[]).length },
    ipAddress: req.ip
  });

  res.json({
    success: true,
    message: `Announcement sent to ${(users as any[]).length} users`
  });
};

export const getModerationQueue = async (req: AuthRequest, res: Response) => {
  const [pendingPosts] = await mysqlPool.execute(
    'SELECT COUNT(*) as count FROM nt_posts WHERE approval_status = "waiting"'
  );

  const [reportedPosts] = await mysqlPool.execute(
    'SELECT COUNT(*) as count FROM nt_reports WHERE resolved = false'
  );

  res.json({
    success: true,
    queue: {
      pendingPosts: (pendingPosts as any[])[0].count,
      reportedPosts: (reportedPosts as any[])[0].count
    }
  });
};

export const assignModerator = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  await mysqlPool.execute(
    'UPDATE users SET role = "moderator" WHERE id = ?',
    [id]
  );

  res.json({ success: true, message: 'Moderator assigned' });
};

export const getSystemHealth = async (req: AuthRequest, res: Response) => {
  let mysqlHealthy = false;
  try {
    await mysqlPool.query('SELECT 1');
    mysqlHealthy = true;
  } catch (error) {
    console.error('MySQL health check failed', error);
  }

  res.json({
    success: true,
    status: mysqlHealthy ? 'healthy' : 'degraded',
    services: {
      mysql: mysqlHealthy
    },
    timestamp: new Date()
  });
};