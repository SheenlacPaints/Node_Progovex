import { Request, Response } from 'express';
import { executeQuery, executeNonQuery, executeTransaction, ActivityLog } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import { sendEmail } from '../workers/emailWorker';
import sql from 'mssql';

export const getPendingPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    console.log('Fetching pending posts:', { page, limit, offset });

    // SQL Server query with OFFSET FETCH instead of LIMIT OFFSET
    const query = `
      SELECT 
        p.*, 
        u.cuser_name as username, 
        u.cuser_name as full_name, 
        u.cemail 
      FROM nt_posts p
      JOIN users u ON p.cuserid = u.cuserid
      WHERE p.approval_status = 'waiting' AND p.status = 'pending'
      ORDER BY p.created_at ASC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `;

    const posts = await executeQuery<any>(query, { offset, limit });

    // Get total count
    const countResult = await executeQuery<any>(
      `SELECT COUNT(*) as total 
       FROM nt_posts p
       WHERE p.approval_status = 'waiting' AND p.status = 'pending'`
    );

    const total = countResult[0]?.total || 0;

    console.log(`Found ${posts.length} pending posts out of ${total} total`);

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

// Alternative version with dynamic SQL building
export const getPendingPostsExecute = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const query = `
      SELECT 
        p.*, 
        u.cuser_name as username, 
        u.cuser_name as full_name, 
        u.cemail 
      FROM nt_posts p
      JOIN users u ON p.cuserid = u.cuserid
      WHERE p.approval_status = 'waiting' AND p.status = 'pending'
      ORDER BY p.created_at ASC
      OFFSET @offset ROWS
      FETCH NEXT @limit ROWS ONLY
    `;

    const posts = await executeQuery<any>(query, { offset, limit });

    const countResult = await executeQuery<any>(
      `SELECT COUNT(*) as total 
       FROM nt_posts p
       WHERE p.approval_status = 'waiting' AND p.status = 'pending'`
    );

    const total = countResult[0]?.total || 0;

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
      SELECT 
        p.*, 
        u.cuser_name as username, 
        u.cuser_name as full_name, 
        u.cemail 
      FROM nt_posts p
      JOIN users u ON p.cuserid = u.cuserid
      WHERE 1=1
    `;

    const params: any = {};

    if (status !== 'all') {
      sql += ` AND p.status = @status`;
      params.status = status;
    }

    if (approvalStatus !== 'all') {
      sql += ` AND p.approval_status = @approvalStatus`;
      params.approvalStatus = approvalStatus;
    }

    sql += ` ORDER BY p.created_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
    params.offset = offset;
    params.limit = limit;

    const posts = await executeQuery<any>(sql, params);

    // Get total count
    let countSql = `SELECT COUNT(*) as total FROM nt_posts p WHERE 1=1`;
    const countParams: any = {};

    if (status !== 'all') {
      countSql += ` AND p.status = @status`;
      countParams.status = status;
    }

    if (approvalStatus !== 'all') {
      countSql += ` AND p.approval_status = @approvalStatus`;
      countParams.approvalStatus = approvalStatus;
    }

    const countResult = await executeQuery<any>(countSql, countParams);
    const total = countResult[0]?.total || 0;

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

    // Update post with approval status and set approved_at to GETDATE()
    const result = await executeNonQuery(
      `UPDATE nt_posts 
       SET approval_status = 'approved', 
           status = 'approved', 
           approved_by = @adminId, 
           approved_at = GETDATE() 
       WHERE id = @postId AND approval_status = 'waiting'`,
      { adminId, postId: parseInt(id) }
    );

    if (result.rowsAffected && result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or already processed'
      });
    }

    // Get the approved post with all details including user info and parsed data
    const posts = await executeQuery<any>(
      `SELECT 
        p.*, 
        u.cuser_name as username, 
        u.cuser_name as full_name, 
        u.cprofile_image_name as avatar_url, 
        u.cemail,
        FORMAT(p.created_at, 'yyyy-MM-dd HH:mm:ss') as created_at_formatted,
        FORMAT(p.approved_at, 'yyyy-MM-dd HH:mm:ss') as approved_at_formatted
       FROM nt_posts p
       JOIN users u ON p.cuserid = u.cuserid
       WHERE p.id = @postId`,
      { postId: parseInt(id) }
    );

    const approvedPost = posts[0];

    // Parse JSON fields for frontend
    approvedPost.mediaUrls = approvedPost.media_urls ? JSON.parse(approvedPost.media_urls) : [];
    approvedPost.hashtags = approvedPost.hashtags ? JSON.parse(approvedPost.hashtags) : [];
    approvedPost.pollData = approvedPost.poll_data ? JSON.parse(approvedPost.poll_data) : null;

    // Get user's vote for this post if it's a poll
    const userVote = await executeQuery<any>(
      'SELECT option_id FROM nt_poll_votes WHERE post_id = @postId AND cuserid = @adminId',
      { postId: parseInt(id), adminId }
    );
    approvedPost.userVotedOption = userVote[0]?.option_id || null;

    // Log activity
    await executeNonQuery(
      `INSERT INTO nt_activity_logs (cuserid, action, entity_type, entity_id, details, ip_address, created_at) 
       VALUES (@adminId, 'approve_post', 'post', @postId, @details, @ip, GETDATE())`,
      {
        adminId,
        postId: parseInt(id),
        details: JSON.stringify({
          postId: id,
          created_at: approvedPost.created_at,
          approved_at: approvedPost.approved_at
        }),
        ip: req.ip || 'unknown'
      }
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
    const result = await executeNonQuery(
      `UPDATE nt_posts 
       SET approval_status = 'rejected', 
           status = 'rejected', 
           approved_by = @adminId, 
           approved_at = NULL 
       WHERE id = @postId AND (approval_status = 'waiting' OR approval_status = 'pending')`,
      { adminId, postId: parseInt(id) }
    );

    if (result.rowsAffected && result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Post not found or already processed'
      });
    }

    // Log rejection reason (optional)
    if (reason) {
      await executeNonQuery(
        `INSERT INTO nt_post_rejection_logs (post_id, admin_id, reason, created_at) 
         VALUES (@postId, @adminId, @reason, GETDATE())`,
        { postId: parseInt(id), adminId, reason }
      );
    }

    // Log activity
    await executeNonQuery(
      `INSERT INTO nt_activity_logs (cuserid, action, entity_type, entity_id, details, ip_address, created_at) 
       VALUES (@adminId, 'reject_post', 'post', @postId, @details, @ip, GETDATE())`,
      {
        adminId,
        postId: parseInt(id),
        details: JSON.stringify({ reason: reason || 'No reason provided' }),
        ip: req.ip || 'unknown'
      }
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
    const stats = await executeQuery<any>(
      `SELECT 
        COUNT(*) as total_posts,
        SUM(CASE WHEN approval_status = 'waiting' AND status = 'pending' THEN 1 ELSE 0 END) as pending_posts,
        SUM(CASE WHEN approval_status = 'approved' AND status = 'approved' THEN 1 ELSE 0 END) as approved_posts,
        SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) as rejected_posts,
        SUM(CASE WHEN type = 'poll' THEN 1 ELSE 0 END) as poll_posts,
        SUM(CASE WHEN type = 'text' THEN 1 ELSE 0 END) as text_posts,
        SUM(CASE WHEN media_urls != '[]' AND media_urls IS NOT NULL THEN 1 ELSE 0 END) as posts_with_media
       FROM nt_posts`
    );

    res.json({
      success: true,
      stats: stats[0]
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

  // Use transaction for bulk operation
  await executeTransaction(async (connection) => {
    for (const postId of postIds) {
      const request = connection.request();
      request.input('adminId', sql.Int, adminId);
      request.input('postId', sql.Int, postId);

      await request.query(
        `UPDATE nt_posts 
         SET status = 'approved', 
             approval_status = 'approved', 
             approved_by = @adminId, 
             approved_at = GETDATE() 
         WHERE id = @postId AND approval_status = 'waiting'`
      );
    }
  });

  res.json({ success: true, message: `${postIds.length} posts approved` });
};

export const bulkRejectPosts = async (req: AuthRequest, res: Response) => {
  const { postIds } = req.body;
  const adminId = req.user!.id;

  if (!postIds || !Array.isArray(postIds)) {
    throw new AppError('Invalid post IDs', 400);
  }

  // Use transaction for bulk operation
  await executeTransaction(async (connection) => {
    for (const postId of postIds) {
      const request = connection.request();
      request.input('adminId', sql.Int, adminId);
      request.input('postId', sql.Int, postId);

      await request.query(
        `UPDATE nt_posts 
         SET status = 'rejected', 
             approval_status = 'rejected' 
         WHERE id = @postId AND approval_status = 'waiting'`
      );
    }
  });

  res.json({ success: true, message: `${postIds.length} posts rejected` });
};

export const getAllUsers = async (req: AuthRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const role = req.query.role as string;
  const is_active = req.query.is_active as string;

  let query = `
    SELECT 
      id, 
      cuser_name as username, 
      cemail, 
      cuser_name as full_name, 
      cprofile_image_name as avatar_url, 
      role, 
      is_active, 
      email_verified, 
      created_at 
    FROM users 
    WHERE 1=1
  `;

  const params: any = {};

  if (role) {
    query += ' AND role = @role';
    params.role = role;
  }

  if (is_active !== undefined) {
    query += ' AND is_active = @is_active';
    params.is_active = is_active === 'true' ? 1 : 0;
  }

  query += ' ORDER BY created_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY';
  params.offset = offset;
  params.limit = limit;

  const users = await executeQuery<any>(query, params);

  const totalResult = await executeQuery<any>('SELECT COUNT(*) as total FROM users');
  const total = totalResult[0]?.total || 0;

  res.json({
    success: true,
    users,
    total,
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

  await executeNonQuery(
    'UPDATE users SET role = @role WHERE id = @userId',
    { role, userId: parseInt(id) }
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

  await executeNonQuery(
    'UPDATE users SET is_active = 0 WHERE id = @userId',
    { userId: parseInt(id) }
  );

  await executeNonQuery(
    'DELETE FROM nt_sessions WHERE cuserid = @userId',
    { userId: parseInt(id) }
  );

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

  await executeNonQuery(
    'UPDATE users SET is_active = 1 WHERE id = @userId',
    { userId: parseInt(id) }
  );

  res.json({ success: true, message: 'User activated' });
};

export const deleteUser = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  await executeNonQuery(
    'DELETE FROM users WHERE id = @userId',
    { userId: parseInt(id) }
  );

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
  const totalUsers = await executeQuery<any>('SELECT COUNT(*) as count FROM users');
  const totalPosts = await executeQuery<any>('SELECT COUNT(*) as count FROM nt_posts');
  const pendingPosts = await executeQuery<any>('SELECT COUNT(*) as count FROM nt_posts WHERE approval_status = "waiting"');
  const totalComments = await executeQuery<any>('SELECT COUNT(*) as count FROM nt_comments');
  const totalReactions = await executeQuery<any>('SELECT COUNT(*) as count FROM nt_reactions');

  const postsByDay = await executeQuery<any>(
    `SELECT FORMAT(created_at, 'yyyy-MM-dd') as date, COUNT(*) as count 
     FROM nt_posts 
     WHERE created_at >= DATEADD(day, -7, GETDATE())
     GROUP BY FORMAT(created_at, 'yyyy-MM-dd')`
  );

  res.json({
    success: true,
    stats: {
      totalUsers: totalUsers[0]?.count || 0,
      totalPosts: totalPosts[0]?.count || 0,
      pendingPosts: pendingPosts[0]?.count || 0,
      totalComments: totalComments[0]?.count || 0,
      totalReactions: totalReactions[0]?.count || 0,
      postsByDay
    }
  });
};

export const getActivityLogs = async (req: AuthRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;
  const action = req.query.action as string;
  const userId = req.query.userId as string;

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
  const reports = await executeQuery<any>(
    `SELECT 
      r.*, 
      p.content, 
      p.cuserid as post_owner_id, 
      u.cuser_name as reporter_username, 
      u2.cuser_name as post_owner_username
     FROM nt_reports r
     JOIN nt_posts p ON r.post_id = p.id
     JOIN users u ON r.cuserid = u.id
     JOIN users u2 ON p.cuserid = u2.id
     WHERE r.resolved = 0
     ORDER BY r.created_at DESC`
  );

  res.json({ success: true, reports: reports });
};

export const resolveReport = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { action } = req.body;

  if (action === 'delete_post') {
    const reports = await executeQuery<any>(
      'SELECT post_id FROM nt_reports WHERE id = @reportId',
      { reportId: parseInt(id) }
    );
    const report = reports[0];

    if (report) {
      await executeNonQuery(
        'UPDATE nt_posts SET status = "deleted" WHERE id = @postId',
        { postId: report.post_id }
      );
    }
  }

  await executeNonQuery(
    'UPDATE nt_reports SET resolved = 1, resolved_by = @adminId, resolved_at = GETDATE() WHERE id = @reportId',
    { adminId: req.user!.id, reportId: parseInt(id) }
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

  const userGrowth = await executeQuery<any>(
    `SELECT FORMAT(created_at, 'yyyy-MM-dd') as date, COUNT(*) as new_users 
     FROM users 
     WHERE created_at >= DATEADD(day, -@days, GETDATE())
     GROUP BY FORMAT(created_at, 'yyyy-MM-dd')`,
    { days }
  );

  const postActivity = await executeQuery<any>(
    `SELECT FORMAT(created_at, 'yyyy-MM-dd') as date, COUNT(*) as posts 
     FROM nt_posts 
     WHERE created_at >= DATEADD(day, -@days, GETDATE())
     GROUP BY FORMAT(created_at, 'yyyy-MM-dd')`,
    { days }
  );

  const topContributors = await executeQuery<any>(
    `SELECT TOP 10 
      u.cuser_name as username, 
      COUNT(p.id) as post_count 
     FROM users u
     JOIN nt_posts p ON u.id = p.cuserid
     WHERE p.created_at >= DATEADD(day, -30, GETDATE())
     GROUP BY u.id, u.cuser_name
     ORDER BY post_count DESC`
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

  let userQuery = 'SELECT cemail, cuser_name as username FROM users WHERE is_active = 1';
  if (audience === 'active') {
    userQuery += ' AND created_at >= DATEADD(day, -30, GETDATE())';
  }

  const users = await executeQuery<any>(userQuery);

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
};

export const getModerationQueue = async (req: AuthRequest, res: Response) => {
  const pendingPosts = await executeQuery<any>(
    'SELECT COUNT(*) as count FROM nt_posts WHERE approval_status = "waiting"'
  );

  const reportedPosts = await executeQuery<any>(
    'SELECT COUNT(*) as count FROM nt_reports WHERE resolved = 0'
  );

  res.json({
    success: true,
    queue: {
      pendingPosts: pendingPosts[0]?.count || 0,
      reportedPosts: reportedPosts[0]?.count || 0
    }
  });
};

export const assignModerator = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  await executeNonQuery(
    'UPDATE users SET role = "moderator" WHERE id = @userId',
    { userId: parseInt(id) }
  );

  res.json({ success: true, message: 'Moderator assigned' });
};

export const getSystemHealth = async (req: AuthRequest, res: Response) => {
  let sqlHealthy = false;
  try {
    await executeQuery('SELECT 1');
    sqlHealthy = true;
  } catch (error) {
    console.error('SQL Server health check failed', error);
  }

  res.json({
    success: true,
    status: sqlHealthy ? 'healthy' : 'degraded',
    services: {
      sql_server: sqlHealthy
    },
    timestamp: new Date()
  });
};