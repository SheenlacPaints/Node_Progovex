// backend/src/controllers/adminController.ts
import { Request, Response } from 'express';
import { getSQLServerPool } from '../config/database';
import { ActivityLog } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import { sendEmail } from '../workers/emailWorker';
import sql from 'mssql';

export const getPendingPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const pool = await getSQLServerPool();

    console.log('Fetching pending posts:', { page, limit, offset });

    const query = `
      SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.cemail 
      FROM nt_posts p
      JOIN users u ON p.cuserid = u.id
      WHERE p.approval_status = 'waiting' AND p.status = 'pending'
      ORDER BY p.created_at ASC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `;

    const result = await pool.request()
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query(query);

    const countResult = await pool.request()
      .query(`
        SELECT COUNT(*) as total 
        FROM nt_posts p
        WHERE p.approval_status = 'waiting' AND p.status = 'pending'
      `);

    const total = countResult.recordset[0]?.total || 0;

    console.log(`Found ${result.recordset.length} pending posts out of ${total} total`);

    res.json({
      success: true,
      posts: result.recordset,
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
    const pool = await getSQLServerPool();

    let sql:any = `
      SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.cemail 
      FROM nt_posts p
      JOIN users u ON p.cuserid = u.id
      WHERE 1=1
    `;

    const request = pool.request();

    if (status !== 'all') {
      sql += ` AND p.status = @status`;
      request.input('status', sql.NVarChar, status);
    }

    if (approvalStatus !== 'all') {
      sql += ` AND p.approval_status = @approvalStatus`;
      request.input('approvalStatus', sql.NVarChar, approvalStatus);
    }

    sql += ` ORDER BY p.created_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
    request.input('limit', sql.Int, limit);
    request.input('offset', sql.Int, offset);

    const result = await request.query(sql);

    // Get total count
    let countSql = `SELECT COUNT(*) as total FROM nt_posts p WHERE 1=1`;
    const countRequest = pool.request();

    if (status !== 'all') {
      countSql += ` AND p.status = @status`;
      countRequest.input('status', sql.NVarChar, status);
    }

    if (approvalStatus !== 'all') {
      countSql += ` AND p.approval_status = @approvalStatus`;
      countRequest.input('approvalStatus', sql.NVarChar, approvalStatus);
    }

    const countResult = await countRequest.query(countSql);
    const total = countResult.recordset[0]?.total || 0;

    res.json({
      success: true,
      posts: result.recordset,
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
    const pool = await getSQLServerPool();

    console.log('Approving post:', { postId: id, adminId });

    // Update post with approval status and set approved_at to GETDATE()
    const result = await pool.request()
      .input('adminId', sql.Int, adminId)
      .input('postId', sql.Int, id)
      .query(`
        UPDATE nt_posts 
        SET approval_status = 'approved', 
            status = 'approved', 
            approved_by = @adminId, 
            approved_at = GETDATE() 
        WHERE id = @postId AND approval_status = 'waiting'
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or already processed'
      });
    }

    // Get the approved post with all details
    const postsResult = await pool.request()
      .input('postId', sql.Int, id)
      .query(`
        SELECT 
          p.*, 
          u.cuser_name as username, 
          u.cuser_name as full_name, 
          u.cprofile_image_name as avatar_url, 
          u.cemail,
          FORMAT(p.created_at, 'yyyy-MM-dd HH:mm:ss') as created_at_formatted,
          FORMAT(p.approved_at, 'yyyy-MM-dd HH:mm:ss') as approved_at_formatted
        FROM nt_posts p
        JOIN users u ON p.cuserid = u.id
        WHERE p.id = @postId
      `);

    const approvedPost = postsResult.recordset[0];

    // Parse JSON fields for frontend
    approvedPost.mediaUrls = approvedPost.media_urls ? JSON.parse(approvedPost.media_urls) : [];
    approvedPost.hashtags = approvedPost.hashtags ? JSON.parse(approvedPost.hashtags) : [];
    approvedPost.pollData = approvedPost.poll_data ? JSON.parse(approvedPost.poll_data) : null;

    // Get user's vote for this post if it's a poll
    const userVoteResult = await pool.request()
      .input('postId', sql.Int, id)
      .input('adminId', sql.Int, adminId)
      .query('SELECT option_id FROM nt_poll_votes WHERE post_id = @postId AND cuserid = @adminId');
    approvedPost.userVotedOption = userVoteResult.recordset[0]?.option_id || null;

    // Log activity
    await pool.request()
      .input('adminId', sql.Int, adminId)
      .input('postId', sql.Int, id)
      .input('details', sql.NVarChar, JSON.stringify({
        postId: id,
        created_at: approvedPost.created_at,
        approved_at: approvedPost.approved_at
      }))
      .input('ipAddress', sql.NVarChar, req.ip || 'unknown')
      .query(`
        INSERT INTO nt_activity_logs (cuserid, action, entity_type, entity_id, details, ip_address, created_at) 
        VALUES (@adminId, 'approve_post', 'post', @postId, @details, @ipAddress, GETDATE())
      `);

    // EMIT SOCKET EVENT FOR REAL-TIME UPDATE
    const io = req.app.get('io');
    if (io) {
      io.emit('post_approved_live', {
        post: approvedPost,
        postId: parseInt(id),
        approved_at: approvedPost.approved_at
      });

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
    const pool = await getSQLServerPool();

    console.log('Rejecting post:', { postId: id, adminId, reason });

    const result = await pool.request()
      .input('adminId', sql.Int, adminId)
      .input('postId', sql.Int, id)
      .query(`
        UPDATE nt_posts 
        SET approval_status = 'rejected', 
            status = 'rejected', 
            approved_by = @adminId, 
            approved_at = NULL 
        WHERE id = @postId AND (approval_status = 'waiting' OR approval_status = 'pending')
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or already processed'
      });
    }

    // Log rejection reason (optional)
    if (reason) {
      await pool.request()
        .input('postId', sql.Int, id)
        .input('adminId', sql.Int, adminId)
        .input('reason', sql.NVarChar, reason)
        .query(`
          INSERT INTO nt_post_rejection_logs (post_id, admin_id, reason, created_at) 
          VALUES (@postId, @adminId, @reason, GETDATE())
        `);
    }

    // Log activity
    await pool.request()
      .input('adminId', sql.Int, adminId)
      .input('postId', sql.Int, id)
      .input('details', sql.NVarChar, JSON.stringify({ reason: reason || 'No reason provided' }))
      .input('ipAddress', sql.NVarChar, req.ip || 'unknown')
      .query(`
        INSERT INTO nt_activity_logs (cuserid, action, entity_type, entity_id, details, ip_address, created_at) 
        VALUES (@adminId, 'reject_post', 'post', @postId, @details, @ipAddress, GETDATE())
      `);

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
    const pool = await getSQLServerPool();

    const result = await pool.request()
      .query(`
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
      stats: result.recordset[0]
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
  try {
    const { postIds } = req.body;
    const adminId = req.user!.id;
    const pool = await getSQLServerPool();

    if (!postIds || !Array.isArray(postIds)) {
      throw new AppError('Invalid post IDs', 400);
    }

    for (const postId of postIds) {
      await pool.request()
        .input('adminId', sql.Int, adminId)
        .input('postId', sql.Int, postId)
        .query(`
          UPDATE nt_posts 
          SET status = 'approved', 
              approval_status = 'approved', 
              approved_by = @adminId, 
              approved_at = GETDATE() 
          WHERE id = @postId AND approval_status = 'waiting'
        `);
    }

    res.json({ success: true, message: `${postIds.length} posts approved` });
  } catch (error) {
    console.error('Error bulk approving posts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bulk approve posts',
      error: error.message
    });
  }
};

export const bulkRejectPosts = async (req: AuthRequest, res: Response) => {
  try {
    const { postIds } = req.body;
    const adminId = req.user!.id;
    const pool = await getSQLServerPool();

    if (!postIds || !Array.isArray(postIds)) {
      throw new AppError('Invalid post IDs', 400);
    }

    for (const postId of postIds) {
      await pool.request()
        .input('postId', sql.Int, postId)
        .query(`
          UPDATE nt_posts 
          SET status = 'rejected', 
              approval_status = 'rejected' 
          WHERE id = @postId AND approval_status = 'waiting'
        `);
    }

    res.json({ success: true, message: `${postIds.length} posts rejected` });
  } catch (error) {
    console.error('Error bulk rejecting posts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bulk reject posts',
      error: error.message
    });
  }
};

export const getAllUsers = async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, role, is_active } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const pool = await getSQLServerPool();

    let query = `
      SELECT id, cuser_name as username, cemail, cuser_name as full_name, 
             cprofile_image_name as avatar_url, role, is_active, email_verified, created_at 
      FROM users WHERE 1=1
    `;

    const request = pool.request();

    if (role) {
      query += ` AND role = @role`;
      request.input('role', sql.NVarChar, role);
    }

    if (is_active !== undefined) {
      query += ` AND is_active = @isActive`;
      request.input('isActive', sql.Bit, is_active === 'true');
    }

    query += ` ORDER BY created_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
    request.input('limit', sql.Int, Number(limit));
    request.input('offset', sql.Int, offset);

    const result = await request.query(query);

    const totalResult = await pool.request()
      .query('SELECT COUNT(*) as total FROM users');

    res.json({
      success: true,
      users: result.recordset,
      total: totalResult.recordset[0]?.total || 0,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message
    });
  }
};

export const updateUserRole = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const pool = await getSQLServerPool();

    if (!['user', 'moderator', 'admin'].includes(role)) {
      throw new AppError('Invalid role', 400);
    }

    await pool.request()
      .input('role', sql.NVarChar, role)
      .input('userId', sql.Int, id)
      .query('UPDATE users SET role = @role WHERE id = @userId');

    await ActivityLog.create({
      userId: req.user!.id.toString(),
      action: 'update_user_role',
      entityType: 'user',
      entityId: id,
      details: { role },
      ipAddress: req.ip
    });

    res.json({ success: true, message: 'User role updated' });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user role',
      error: error.message
    });
  }
};

export const suspendUser = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const pool = await getSQLServerPool();

    await pool.request()
      .input('userId', sql.Int, id)
      .query('UPDATE users SET is_active = 0 WHERE id = @userId');

    await pool.request()
      .input('userId', sql.Int, id)
      .query('DELETE FROM nt_sessions WHERE cuserid = @userId');

    await ActivityLog.create({
      userId: req.user!.id.toString(),
      action: 'suspend_user',
      entityType: 'user',
      entityId: id,
      details: { reason },
      ipAddress: req.ip
    });

    res.json({ success: true, message: 'User suspended' });
  } catch (error) {
    console.error('Error suspending user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to suspend user',
      error: error.message
    });
  }
};

export const activateUser = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const pool = await getSQLServerPool();

    await pool.request()
      .input('userId', sql.Int, id)
      .query('UPDATE users SET is_active = 1 WHERE id = @userId');

    res.json({ success: true, message: 'User activated' });
  } catch (error) {
    console.error('Error activating user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to activate user',
      error: error.message
    });
  }
};

export const deleteUser = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const pool = await getSQLServerPool();

    await pool.request()
      .input('userId', sql.Int, id)
      .query('DELETE FROM users WHERE id = @userId');

    await ActivityLog.create({
      userId: req.user!.id.toString(),
      action: 'delete_user',
      entityType: 'user',
      entityId: id,
      ipAddress: req.ip
    });

    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message
    });
  }
};

export const getSystemStats = async (req: AuthRequest, res: Response) => {
  try {
    const pool = await getSQLServerPool();

    const [totalUsers, totalPosts, pendingPosts, totalComments, totalReactions, postsByDay] = await Promise.all([
      pool.request().query('SELECT COUNT(*) as count FROM users'),
      pool.request().query('SELECT COUNT(*) as count FROM nt_posts'),
      pool.request().query('SELECT COUNT(*) as count FROM nt_posts WHERE approval_status = "waiting"'),
      pool.request().query('SELECT COUNT(*) as count FROM nt_comments'),
      pool.request().query('SELECT COUNT(*) as count FROM nt_reactions'),
      pool.request().query(`
        SELECT CAST(created_at as DATE) as date, COUNT(*) as count 
        FROM nt_posts 
        WHERE created_at >= DATEADD(DAY, -7, GETDATE())
        GROUP BY CAST(created_at as DATE)
      `)
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers.recordset[0]?.count || 0,
        totalPosts: totalPosts.recordset[0]?.count || 0,
        pendingPosts: pendingPosts.recordset[0]?.count || 0,
        totalComments: totalComments.recordset[0]?.count || 0,
        totalReactions: totalReactions.recordset[0]?.count || 0,
        postsByDay: postsByDay.recordset || []
      }
    });
  } catch (error) {
    console.error('Error getting system stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch system stats',
      error: error.message
    });
  }
};

export const getActivityLogs = async (req: AuthRequest, res: Response) => {
  try {
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
  } catch (error) {
    console.error('Error getting activity logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch activity logs',
      error: error.message
    });
  }
};

export const getReportedPosts = async (req: AuthRequest, res: Response) => {
  try {
    const pool = await getSQLServerPool();

    const result = await pool.request()
      .query(`
        SELECT r.*, p.content, p.cuserid as post_owner_id, 
               u.cuser_name as reporter_username, u2.cuser_name as post_owner_username
        FROM nt_reports r
        JOIN nt_posts p ON r.post_id = p.id
        JOIN users u ON r.cuserid = u.id
        JOIN users u2 ON p.cuserid = u2.id
        WHERE r.resolved = 0
        ORDER BY r.created_at DESC
      `);

    res.json({ success: true, reports: result.recordset });
  } catch (error) {
    console.error('Error getting reported posts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reported posts',
      error: error.message
    });
  }
};

export const resolveReport = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { action } = req.body;
    const pool = await getSQLServerPool();

    if (action === 'delete_post') {
      const reportResult = await pool.request()
        .input('reportId', sql.Int, id)
        .query('SELECT post_id FROM nt_reports WHERE id = @reportId');
      const report = reportResult.recordset[0];

      if (report) {
        await pool.request()
          .input('postId', sql.Int, report.post_id)
          .query('UPDATE nt_posts SET status = "deleted" WHERE id = @postId');
      }
    }

    await pool.request()
      .input('reportId', sql.Int, id)
      .input('adminId', sql.Int, req.user!.id)
      .query(`
        UPDATE nt_reports 
        SET resolved = 1, resolved_by = @adminId, resolved_at = GETDATE() 
        WHERE id = @reportId
      `);

    res.json({ success: true });
  } catch (error) {
    console.error('Error resolving report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resolve report',
      error: error.message
    });
  }
};

export const getAnalytics = async (req: AuthRequest, res: Response) => {
  try {
    const { period = 'week' } = req.query;
    let days = 7;
    const pool = await getSQLServerPool();

    if (period === 'month') {
      days = 30;
    } else if (period === 'year') {
      days = 365;
    }

    const [userGrowth, postActivity, topContributors] = await Promise.all([
      pool.request()
        .input('days', sql.Int, days)
        .query(`
          SELECT CAST(created_at as DATE) as date, COUNT(*) as new_users 
          FROM users 
          WHERE created_at >= DATEADD(DAY, -@days, GETDATE())
          GROUP BY CAST(created_at as DATE)
        `),
      pool.request()
        .input('days', sql.Int, days)
        .query(`
          SELECT CAST(created_at as DATE) as date, COUNT(*) as posts 
          FROM nt_posts 
          WHERE created_at >= DATEADD(DAY, -@days, GETDATE())
          GROUP BY CAST(created_at as DATE)
        `),
      pool.request()
        .query(`
          SELECT TOP 10 u.cuser_name as username, COUNT(p.id) as post_count 
          FROM users u
          JOIN nt_posts p ON u.id = p.cuserid
          WHERE p.created_at >= DATEADD(DAY, -30, GETDATE())
          GROUP BY u.id, u.cuser_name
          ORDER BY post_count DESC
        `)
    ]);

    res.json({
      success: true,
      analytics: {
        userGrowth: userGrowth.recordset,
        postActivity: postActivity.recordset,
        topContributors: topContributors.recordset,
        period
      }
    });
  } catch (error) {
    console.error('Error getting analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch analytics',
      error: error.message
    });
  }
};

export const sendAnnouncement = async (req: AuthRequest, res: Response) => {
  try {
    const { title, message, audience = 'all' } = req.body;
    const pool = await getSQLServerPool();

    let userQuery = 'SELECT cemail, cuser_name as username FROM users WHERE is_active = 1';
    if (audience === 'active') {
      userQuery += ' AND created_at >= DATEADD(DAY, -30, GETDATE())';
    }

    const result = await pool.request().query(userQuery);
    const users = result.recordset;

    for (const user of users) {
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
      details: { title, audience, recipientCount: users.length },
      ipAddress: req.ip
    });

    res.json({
      success: true,
      message: `Announcement sent to ${users.length} users`
    });
  } catch (error) {
    console.error('Error sending announcement:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send announcement',
      error: error.message
    });
  }
};

export const getModerationQueue = async (req: AuthRequest, res: Response) => {
  try {
    const pool = await getSQLServerPool();

    const [pendingPosts, reportedPosts] = await Promise.all([
      pool.request().query('SELECT COUNT(*) as count FROM nt_posts WHERE approval_status = "waiting"'),
      pool.request().query('SELECT COUNT(*) as count FROM nt_reports WHERE resolved = 0')
    ]);

    res.json({
      success: true,
      queue: {
        pendingPosts: pendingPosts.recordset[0]?.count || 0,
        reportedPosts: reportedPosts.recordset[0]?.count || 0
      }
    });
  } catch (error) {
    console.error('Error getting moderation queue:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch moderation queue',
      error: error.message
    });
  }
};

export const assignModerator = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const pool = await getSQLServerPool();

    await pool.request()
      .input('userId', sql.Int, id)
      .query('UPDATE users SET role = "moderator" WHERE id = @userId');

    res.json({ success: true, message: 'Moderator assigned' });
  } catch (error) {
    console.error('Error assigning moderator:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign moderator',
      error: error.message
    });
  }
};

export const getSystemHealth = async (req: AuthRequest, res: Response) => {
  try {
    let sqlServerHealthy = false;
    try {
      const pool = await getSQLServerPool();
      await pool.request().query('SELECT 1');
      sqlServerHealthy = true;
    } catch (error) {
      console.error('SQL Server health check failed', error);
    }

    res.json({
      success: true,
      status: sqlServerHealthy ? 'healthy' : 'degraded',
      services: {
        sqlServer: sqlServerHealthy
      },
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error checking system health:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check system health',
      error: error.message
    });
  }
};