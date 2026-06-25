import { Request, Response } from 'express';
import { getSQLServerPool } from '../config/database';
import { ActivityLog } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import moment from 'moment-timezone';
import sql from 'mssql';

const getIo = (req: AuthRequest) => {
    return req.app.get('io');
};

// Helper function to process images
const processImage = async (filePath: string): Promise<string> => {
    try {
        const dir = path.dirname(filePath);
        const ext = path.extname(filePath);
        const filename = path.basename(filePath, ext);
        const outputPath = path.join(dir, `${filename}.webp`);

        await sharp(filePath)
            .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(outputPath);

        await fs.unlink(filePath);
        return outputPath;
    } catch (error) {
        console.error('Error processing image:', error);
        return filePath;
    }
};

// ==============================================
// CREATE POST
// ==============================================
export const createPost = async (req: AuthRequest, res: Response) => {
    try {
        const { content, type, pollData, hashtags } = req.body;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        console.log('📝 Creating post with data:', {
            content: content?.substring(0, 50),
            type,
            pollData: pollData ? JSON.stringify(pollData).substring(0, 100) : null,
            hashtags
        });

        // Process uploaded files
        const mediaUrls: string[] = [];
        const fileSizes: number[] = [];

        if (req.files && (req.files as any[]).length > 0) {
            console.log(`📁 Processing ${(req.files as any[]).length} files`);

            for (const file of req.files as any[]) {
                console.log(`📄 File: ${file.originalname}, Size: ${(file.size / (1024 * 1024)).toFixed(2)}MB, Type: ${file.mimetype}`);
                fileSizes.push(file.size);

                let filePath = file.path;

                if (file.mimetype.startsWith('image/')) {
                    try {
                        filePath = await processImage(file.path);
                        console.log(`🖼️ Image processed: ${filePath}`);
                    } catch (err) {
                        console.error('Error processing image:', err);
                    }
                } else {
                    console.log(`🎥 Video file saved: ${filePath}`);
                }

                let url = filePath.replace(/\\/g, '/');
                url = url.replace(/^backend\//, '');
                if (!url.startsWith('/uploads/')) {
                    url = `/uploads/${url}`;
                }
                mediaUrls.push(url);
            }
        }

        let finalPollData = null;
        if (pollData) {
            if (typeof pollData === 'string') {
                finalPollData = pollData;
            } else {
                finalPollData = JSON.stringify(pollData);
            }
            console.log('📊 Poll data prepared for storage:', finalPollData.substring(0, 200));
        }

        const result = await pool.request()
            .input('cuserid', sql.Int, userId)
            .input('content', sql.NVarChar, content || null)
            .input('type', sql.NVarChar, type || 'text')
            .input('media_urls', sql.NVarChar, JSON.stringify(mediaUrls))
            .input('poll_data', sql.NVarChar, finalPollData)
            .input('hashtags', sql.NVarChar, hashtags ? JSON.stringify(hashtags) : null)
            .query(`
                INSERT INTO nt_posts (
                    cuserid, content, type, media_urls, poll_data, hashtags, 
                    status, approval_status, created_at, approved_at
                ) OUTPUT INSERTED.id, INSERTED.created_at
                VALUES (@cuserid, @content, @type, @media_urls, @poll_data, @hashtags, 
                    'pending', 'waiting', GETDATE(), NULL)
            `);

        const inserted = result.recordset[0];
        const postId = inserted.id;

        const userResult = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT cuser_name as username, cuser_name as full_name, 
                       cprofile_image_name as avatar_url 
                FROM users WHERE id = @userId
            `);
        const user = userResult.recordset[0];

        const postResult = await pool.request()
            .input('postId', sql.Int, postId)
            .query(`
                SELECT 
                    id, cuserid, content, type, media_urls, poll_data, hashtags,
                    status, approval_status, likes_count, comments_count, shares_count,
                    created_at, approved_at,
                    FORMAT(created_at, 'yyyy-MM-dd HH:mm:ss') as created_at_formatted
                FROM nt_posts 
                WHERE id = @postId
            `);

        const createdPost = postResult.recordset[0];

        let responsePollData = null;
        if (finalPollData) {
            try {
                responsePollData = JSON.parse(finalPollData);
            } catch (e) {
                responsePollData = finalPollData;
            }
        }

        const newPost = {
            id: postId,
            userId: userId,
            content: content,
            type: type || 'text',
            mediaUrls: mediaUrls,
            hashtags: hashtags || [],
            pollData: responsePollData,
            status: 'pending',
            approval_status: 'waiting',
            likes_count: 0,
            comments_count: 0,
            shares_count: 0,
            created_at: createdPost.created_at,
            approved_at: null,
            user: user
        };

        const io = getIo(req);
        if (io) {
            io.emit('post_created', newPost);
            console.log(`📤 Emitted post_created for post ${postId}`);
        }

        res.status(201).json({
            success: true,
            message: 'Post created and awaiting admin approval',
            post: newPost,
            created_at: createdPost.created_at
        });
    } catch (error) {
        console.error('Error creating post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create post',
            error: error.message
        });
    }
};

// ==============================================
// GET POSTS
// ==============================================
export const getPosts = async (req: AuthRequest, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const userId = Number(req.user.id);

        const search = req.query.search as string || '';
        const filterType = req.query.filterType as string || 'all';
        const sortBy = req.query.sortBy as string || 'latest';
        const tab = req.query.tab as string || 'for-you';

        const pool = await getSQLServerPool();

        // Build WHERE clause
        let whereConditions: string[] = [
            "p.status = 'approved'",
            "p.approval_status = 'approved'",
            "(p.is_reshare = 0 OR p.is_reshare = 1)"
        ];

        // Search filter
        if (search) {
            const searchPattern = `%${search}%`;
            whereConditions.push(`(
                p.content LIKE @search 
                OR u.cuser_name LIKE @search 
                OR u.cuser_name LIKE @search 
                OR p.hashtags LIKE @search
            )`);
        }

        // Filter type: saved posts
        if (filterType === 'saved') {
            whereConditions.push(`sp.id IS NOT NULL`);
        }

        // Filter type: my posts
        if (filterType === 'my-posts') {
            whereConditions.push(`p.cuserid = @userId`);
        }

        // Following tab
        if (tab === 'following') {
            // Add followers table logic here if needed
        }

        const whereClause = whereConditions.join(' AND ');

        // Count query
        let countQuery = `
            SELECT COUNT(DISTINCT p.id) as total
            FROM nt_posts p
            JOIN users u ON p.cuserid = u.id
            LEFT JOIN nt_saved_posts sp ON p.id = sp.post_id AND sp.cuserid = @userId
            WHERE ${whereClause}
        `;

        // ORDER BY
        let orderByClause = '';
        switch (sortBy) {
            case 'latest':
                orderByClause = 'post_publish_time DESC, p.id DESC';
                break;
            case 'oldest':
                orderByClause = 'post_publish_time ASC, p.id ASC';
                break;
            case 'most-liked':
                orderByClause = 'likes_count DESC, post_publish_time DESC';
                break;
            case 'most-commented':
                orderByClause = 'comments_count DESC, post_publish_time DESC';
                break;
            default:
                orderByClause = 'post_publish_time DESC, p.id DESC';
        }

        // Main query
        const query = `
            SELECT 
                p.*, 
                u.cuser_name, 
                u.cuser_name as full_name, 
                u.cprofile_image_name as avatar_url,
                FORMAT(p.approved_at, 'yyyy-MM-dd HH:mm:ss') as approved_at_formatted,
                FORMAT(p.created_at, 'yyyy-MM-dd HH:mm:ss') as created_at_formatted,
                COUNT(DISTINCT r.id) as likes_count,
                COUNT(DISTINCT c.id) as comments_count,
                MAX(CASE WHEN ur.id IS NOT NULL THEN 1 ELSE 0 END) as user_liked,
                MAX(CASE WHEN sp.id IS NOT NULL THEN 1 ELSE 0 END) as user_saved,
                MAX(CASE WHEN res.id IS NOT NULL THEN 1 ELSE 0 END) as user_reshared,
                (SELECT option_id FROM nt_poll_votes WHERE post_id = p.id AND cuserid = @userId) as user_voted_option,
                op.id as original_id, 
                op.content as original_content, 
                op.cuserid as original_user_id,
                op.type as original_type,
                op.media_urls as original_media_urls,
                op.poll_data as original_poll_data,
                op.hashtags as original_hashtags,
                op.likes_count as original_likes_count,
                op.comments_count as original_comments_count,
                op.shares_count as original_shares_count,
                op.created_at as original_created_at,
                op.approved_at as original_approved_at,
                ou.cuser_name as original_username, 
                ou.cuser_name as original_full_name,
                ou.cprofile_image_name as original_avatar_url,
                COALESCE(p.approved_at, p.created_at) as post_publish_time
            FROM nt_posts p
            JOIN users u ON p.cuserid = u.id
            LEFT JOIN nt_reactions r ON p.id = r.post_id
            LEFT JOIN nt_comments c ON p.id = c.post_id AND c.status = 'active'
            LEFT JOIN nt_reactions ur ON p.id = ur.post_id AND ur.cuserid = @userId
            LEFT JOIN nt_saved_posts sp ON p.id = sp.post_id AND sp.cuserid = @userId
            LEFT JOIN nt_reshares res ON p.id = res.original_post_id AND res.cuserid = @userId
            LEFT JOIN nt_posts op ON p.original_post_id = op.id
            LEFT JOIN users ou ON op.cuserid = ou.id
            WHERE ${whereClause}
            GROUP BY 
                p.id, 
                u.cuser_name,
                u.cprofile_image_name,
                p.approved_at, 
                p.created_at,
                op.id, 
                op.content, 
                op.cuserid, 
                op.type, 
                op.media_urls, 
                op.poll_data, 
                op.hashtags,
                op.likes_count, 
                op.comments_count, 
                op.shares_count,
                op.created_at, 
                op.approved_at,
                ou.cuser_name,
                ou.cprofile_image_name
            ORDER BY ${orderByClause}
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `;

        const request = pool.request();
        request.input('userId', sql.Int, userId);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);

        if (search) {
            const searchPattern = `%${search}%`;
            request.input('search', sql.NVarChar, searchPattern);
        }

        const [countResult, postsResult] = await Promise.all([
            request.query(countQuery),
            request.query(query)
        ]);

        const total = countResult.recordset[0]?.total || 0;

        const postsWithMedia = postsResult.recordset.map(post => {
            let originalMediaUrls = [];
            let originalPollData = null;
            let originalHashtags = [];

            if (post.original_media_urls) {
                try {
                    originalMediaUrls = JSON.parse(post.original_media_urls);
                } catch {
                    originalMediaUrls = [];
                }
            }

            if (post.original_poll_data) {
                try {
                    originalPollData = JSON.parse(post.original_poll_data);
                } catch {
                    originalPollData = null;
                }
            }

            if (post.original_hashtags) {
                try {
                    originalHashtags = JSON.parse(post.original_hashtags);
                } catch {
                    originalHashtags = [];
                }
            }

            const originalPost = post.original_id ? {
                id: post.original_id,
                content: post.original_content,
                cuserid: post.original_user_id,
                username: post.original_username,
                full_name: post.original_full_name,
                avatar_url: post.original_avatar_url,
                type: post.original_type || 'text',
                mediaUrls: originalMediaUrls,
                pollData: originalPollData,
                hashtags: originalHashtags,
                likes_count: post.original_likes_count || 0,
                comments_count: post.original_comments_count || 0,
                shares_count: post.original_shares_count || 0,
                created_at: post.original_created_at,
                approved_at: post.original_approved_at,
                display_date: post.original_approved_at || post.original_created_at
            } : null;

            return {
                ...post,
                mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
                hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
                pollData: post.poll_data ? JSON.parse(post.poll_data) : null,
                userLiked: post.user_liked === 1,
                userReshared: post.user_reshared === 1,
                userVotedOption: post.user_voted_option !== null ? Number(post.user_voted_option) : null,
                userSaved: post.user_saved === 1,
                display_date: post.approved_at || post.created_at,
                post_publish_time: post.post_publish_time || post.approved_at || post.created_at,
                originalPost: originalPost
            };
        });

        res.json({
            success: true,
            posts: postsWithMedia,
            page,
            limit,
            total: total,
            totalPages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Error getting posts:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching posts',
            posts: []
        });
    }
};

// ==============================================
// GET SINGLE POST
// ==============================================
export const getPost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('postId', sql.Int, id)
            .input('userId', sql.Int, userId)
            .query(`
                SELECT 
                    p.*, 
                    u.cuser_name as username, 
                    u.cuser_name as full_name, 
                    u.cprofile_image_name as avatar_url,
                    (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id AND cuserid = @userId) as user_liked,
                    (SELECT option_id FROM nt_poll_votes WHERE post_id = p.id AND cuserid = @userId) as user_voted_option
                FROM nt_posts p
                JOIN users u ON p.cuserid = u.id
                WHERE p.id = @postId
            `);

        const post = result.recordset[0];

        if (!post) {
            return res.status(404).json({ success: false, message: 'Post not found' });
        }

        post.mediaUrls = post.media_urls ? JSON.parse(post.media_urls) : [];
        post.hashtags = post.hashtags ? JSON.parse(post.hashtags) : [];
        post.pollData = post.poll_data ? JSON.parse(post.poll_data) : null;
        post.userLiked = post.user_liked === 1;

        const [likesResult, commentsResult] = await Promise.all([
            pool.request()
                .input('postId', sql.Int, id)
                .query('SELECT COUNT(*) as count FROM nt_reactions WHERE post_id = @postId'),
            pool.request()
                .input('postId', sql.Int, id)
                .query('SELECT COUNT(*) as count FROM nt_comments WHERE post_id = @postId')
        ]);

        post.likes_count = likesResult.recordset[0]?.count || 0;
        post.comments_count = commentsResult.recordset[0]?.count || 0;

        res.json({ success: true, post });
    } catch (error) {
        console.error('Error getting post:', error);
        res.status(500).json({ success: false, message: 'Error fetching post' });
    }
};

// ==============================================
// UPDATE POST
// ==============================================
export const updatePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { content, mediaUrls } = req.body;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('content', sql.NVarChar, content)
            .input('mediaUrls', sql.NVarChar, mediaUrls ? JSON.stringify(mediaUrls) : null)
            .input('postId', sql.Int, id)
            .input('userId', sql.Int, userId)
            .query(`
                UPDATE nt_posts 
                SET content = @content, media_urls = @mediaUrls 
                WHERE id = @postId AND cuserid = @userId
            `);

        if (result.rowsAffected[0] === 0) {
            throw new AppError('Post not found or unauthorized', 404);
        }

        res.json({ success: true, message: 'Post updated successfully' });
    } catch (error) {
        console.error('Error updating post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update post',
            error: error.message
        });
    }
};

// ==============================================
// DELETE POST
// ==============================================
export const deletePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const userRole = req.user!.role;
        const pool = await getSQLServerPool();

        let query = 'DELETE FROM nt_posts WHERE id = @postId AND cuserid = @userId';
        let request = pool.request()
            .input('postId', sql.Int, id)
            .input('userId', sql.Int, userId);

        if (userRole === 'admin') {
            query = 'DELETE FROM nt_posts WHERE id = @postId';
            request = pool.request().input('postId', sql.Int, id);
        }

        const result = await request.query(query);

        if (result.rowsAffected[0] === 0) {
            throw new AppError('Post not found or unauthorized', 404);
        }

        res.json({ success: true, message: 'Post deleted successfully' });
    } catch (error) {
        console.error('Error deleting post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete post',
            error: error.message
        });
    }
};

// ==============================================
// GET COMMENTS
// ==============================================
export const getComments = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const userId = req.user.id;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('postId', sql.Int, id)
            .input('limit', sql.Int, limit)
            .input('offset', sql.Int, offset)
            .query(`
                SELECT 
                    c.*, 
                    u.cuser_name as username, 
                    u.cuser_name as full_name, 
                    u.cprofile_image_name as avatar_url
                FROM nt_comments c
                JOIN users u ON c.cuserid = u.id
                WHERE c.post_id = @postId AND c.status = 'active'
                ORDER BY c.created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);

        const comments = result.recordset;

        const commentsWithLikes = await Promise.all(comments.map(async (comment) => {
            const likedResult = await pool.request()
                .input('userId', sql.Int, userId)
                .input('commentId', sql.Int, comment.id)
                .query('SELECT id FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId');

            return {
                ...comment,
                userLiked: likedResult.recordset.length > 0,
                likesCount: comment.likes_count || 0,
                created_at: comment.created_at ? moment(comment.created_at).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss') : null,
                updated_at: comment.updated_at ? moment(comment.updated_at).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss') : null
            };
        }));

        res.json({
            success: true,
            comments: commentsWithLikes,
            page: Number(page),
            limit: Number(limit)
        });
    } catch (error) {
        console.error('Error getting comments:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching comments',
            comments: []
        });
    }
};

// ==============================================
// ADD COMMENT
// ==============================================
export const addComment = async (req: AuthRequest, res: Response) => {
    try {
        const { postId, content, parentCommentId } = req.body;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('postId', sql.Int, postId)
            .input('userId', sql.Int, userId)
            .input('parentCommentId', sql.Int, parentCommentId || null)
            .input('content', sql.NVarChar, content)
            .query(`
                INSERT INTO nt_comments (post_id, cuserid, parent_comment_id, content, status) 
                OUTPUT INSERTED.id
                VALUES (@postId, @userId, @parentCommentId, @content, 'active')
            `);

        const commentId = result.recordset[0]?.id;

        const commentResult = await pool.request()
            .input('commentId', sql.Int, commentId)
            .query(`
                SELECT c.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url 
                FROM nt_comments c 
                JOIN users u ON c.cuserid = u.id 
                WHERE c.id = @commentId
            `);

        const comment = commentResult.recordset[0];

        const countResult = await pool.request()
            .input('postId', sql.Int, postId)
            .query('SELECT comments_count FROM nt_posts WHERE id = @postId');
        const newCommentsCount = countResult.recordset[0]?.comments_count || 0;

        res.json({
            success: true,
            comment: comment,
            commentsCount: newCommentsCount
        });

        const io = req.app.get('io');
        if (io) {
            const eventData = {
                comment: comment,
                postId: postId,
                commentsCount: newCommentsCount,
                userId: userId
            };
            io.to(`post_${postId}`).emit('new_comment', eventData);
            console.log(`📤 Emitted new_comment for post ${postId}`);
        }
    } catch (error) {
        console.error('Error adding comment:', error);
        res.status(500).json({ success: false, message: 'Failed to add comment' });
    }
};

// ==============================================
// DELETE COMMENT
// ==============================================
export const deleteComment = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const commentResult = await pool.request()
            .input('commentId', sql.Int, id)
            .input('userId', sql.Int, userId)
            .query('SELECT post_id FROM nt_comments WHERE id = @commentId AND cuserid = @userId');

        if (commentResult.recordset.length === 0) {
            throw new AppError('Comment not found or unauthorized', 404);
        }

        const postId = commentResult.recordset[0].post_id;

        await pool.request()
            .input('commentId', sql.Int, id)
            .query('UPDATE nt_comments SET status = "deleted" WHERE id = @commentId');

        await pool.request()
            .input('postId', sql.Int, postId)
            .query('UPDATE nt_posts SET comments_count = comments_count - 1 WHERE id = @postId');

        res.json({ success: true, message: 'Comment deleted successfully' });
    } catch (error) {
        console.error('Error deleting comment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete comment',
            error: error.message
        });
    }
};

// ==============================================
// TOGGLE LIKE
// ==============================================
export const addReaction = async (req: AuthRequest, res: Response) => {
    try {
        const { postId } = req.body;
        const userId = req.user.id;
        const pool = await getSQLServerPool();

        console.log('❤️ Toggling like for post:', postId, 'User:', userId);

        const existingResult = await pool.request()
            .input('userId', sql.Int, userId)
            .input('postId', sql.Int, postId)
            .query('SELECT id FROM nt_reactions WHERE cuserid = @userId AND post_id = @postId');

        let isLiked = false;
        let likesCount = 0;

        if (existingResult.recordset.length > 0) {
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('postId', sql.Int, postId)
                .query('DELETE FROM nt_reactions WHERE cuserid = @userId AND post_id = @postId');

            await pool.request()
                .input('postId', sql.Int, postId)
                .query('UPDATE nt_posts SET likes_count = likes_count - 1 WHERE id = @postId');
            isLiked = false;
        } else {
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('postId', sql.Int, postId)
                .query('INSERT INTO nt_reactions (cuserid, post_id, type) VALUES (@userId, @postId, "like")');

            await pool.request()
                .input('postId', sql.Int, postId)
                .query('UPDATE nt_posts SET likes_count = likes_count + 1 WHERE id = @postId');
            isLiked = true;
        }

        const countResult = await pool.request()
            .input('postId', sql.Int, postId)
            .query('SELECT likes_count FROM nt_posts WHERE id = @postId');
        likesCount = countResult.recordset[0]?.likes_count || 0;

        console.log(`📊 Updated likes count for post ${postId}: ${likesCount}`);

        const io = req.app.get('io');
        if (io) {
            const eventData = {
                postId: postId,
                count: likesCount,
                likesCount: likesCount,
                userId: userId,
                isLiked: isLiked
            };
            io.to(`post_${postId}`).emit('reaction_updated', eventData);
            io.emit('reaction_updated_global', eventData);
            console.log(`📤 Emitted reaction_updated for post ${postId}`);
        }

        res.json({
            success: true,
            likes_count: likesCount,
            isLiked: isLiked
        });
    } catch (error) {
        console.error('Error toggling like:', error);
        res.status(500).json({ success: false, message: 'Failed to toggle like' });
    }
};

// ==============================================
// ADD COMMENT REACTION
// ==============================================
export const addCommentReaction = async (req: AuthRequest, res: Response) => {
    try {
        const commentId = parseInt(req.params.id);
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        console.log('❤️ Toggling like for comment:', commentId, 'User:', userId);

        const commentExistsResult = await pool.request()
            .input('commentId', sql.Int, commentId)
            .query('SELECT id FROM nt_comments WHERE id = @commentId');

        if (commentExistsResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Comment not found' });
        }

        const existingResult = await pool.request()
            .input('userId', sql.Int, userId)
            .input('commentId', sql.Int, commentId)
            .query('SELECT id FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId');

        if (existingResult.recordset.length > 0) {
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('commentId', sql.Int, commentId)
                .query('DELETE FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId');

            await pool.request()
                .input('commentId', sql.Int, commentId)
                .query('UPDATE nt_comments SET likes_count = likes_count - 1 WHERE id = @commentId');

            const countResult = await pool.request()
                .input('commentId', sql.Int, commentId)
                .query('SELECT likes_count FROM nt_comments WHERE id = @commentId');

            res.json({
                success: true,
                likes_count: countResult.recordset[0]?.likes_count || 0,
                isLiked: false
            });
        } else {
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('commentId', sql.Int, commentId)
                .query('INSERT INTO nt_reactions (cuserid, comment_id, type) VALUES (@userId, @commentId, "like")');

            await pool.request()
                .input('commentId', sql.Int, commentId)
                .query('UPDATE nt_comments SET likes_count = likes_count + 1 WHERE id = @commentId');

            const countResult = await pool.request()
                .input('commentId', sql.Int, commentId)
                .query('SELECT likes_count FROM nt_comments WHERE id = @commentId');

            res.json({
                success: true,
                likes_count: countResult.recordset[0]?.likes_count || 0,
                isLiked: true
            });
        }
    } catch (error) {
        console.error('Error toggling comment like:', error);
        res.status(500).json({ success: false, message: 'Failed to toggle like' });
    }
};

// ==============================================
// REMOVE COMMENT REACTION
// ==============================================
export const removeCommentReaction = async (req: AuthRequest, res: Response) => {
    try {
        const commentId = parseInt(req.params.id);
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        console.log('👎 Removing like for comment:', commentId, 'User:', userId);

        const existingResult = await pool.request()
            .input('userId', sql.Int, userId)
            .input('commentId', sql.Int, commentId)
            .query('SELECT id FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId');

        if (existingResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Reaction not found'
            });
        }

        await pool.request()
            .input('userId', sql.Int, userId)
            .input('commentId', sql.Int, commentId)
            .query('DELETE FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId');

        await pool.request()
            .input('commentId', sql.Int, commentId)
            .query('UPDATE nt_comments SET likes_count = likes_count - 1 WHERE id = @commentId');

        const countResult = await pool.request()
            .input('commentId', sql.Int, commentId)
            .query('SELECT likes_count FROM nt_comments WHERE id = @commentId');

        res.json({
            success: true,
            likes_count: countResult.recordset[0]?.likes_count || 0,
            isLiked: false
        });
    } catch (error) {
        console.error('Error removing comment reaction:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove reaction'
        });
    }
};

// ==============================================
// REMOVE REACTION
// ==============================================
export const removeReaction = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const reactionResult = await pool.request()
            .input('reactionId', sql.Int, id)
            .input('userId', sql.Int, userId)
            .query('SELECT post_id FROM nt_reactions WHERE id = @reactionId AND cuserid = @userId');

        if (reactionResult.recordset.length === 0) {
            throw new AppError('Reaction not found', 404);
        }

        const postId = reactionResult.recordset[0].post_id;

        await pool.request()
            .input('reactionId', sql.Int, id)
            .query('DELETE FROM nt_reactions WHERE id = @reactionId');

        await pool.request()
            .input('postId', sql.Int, postId)
            .query('UPDATE nt_posts SET likes_count = likes_count - 1 WHERE id = @postId');

        res.json({ success: true, message: 'Reaction removed' });
    } catch (error) {
        console.error('Error removing reaction:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove reaction',
            error: error.message
        });
    }
};

// ==============================================
// GET REACTIONS
// ==============================================
export const getReactions = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('postId', sql.Int, id)
            .query(`
                SELECT r.type, COUNT(*) as count 
                FROM nt_reactions r
                WHERE r.post_id = @postId
                GROUP BY r.type
            `);

        res.json({ success: true, reactions: result.recordset });
    } catch (error) {
        console.error('Error getting reactions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get reactions',
            error: error.message
        });
    }
};

// ==============================================
// SHARE POST
// ==============================================
export const sharePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const pool = await getSQLServerPool();

        await pool.request()
            .input('postId', sql.Int, id)
            .query('UPDATE nt_posts SET shares_count = shares_count + 1 WHERE id = @postId');

        res.json({ success: true, message: 'Post shared' });
    } catch (error) {
        console.error('Error sharing post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to share post',
            error: error.message
        });
    }
};

// ==============================================
// GET FEED
// ==============================================
export const getFeed = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .input('limit', sql.Int, limit)
            .input('offset', sql.Int, offset)
            .query(`
                SELECT 
                    p.id, p.cuserid, p.content, p.type, p.media_urls, p.hashtags, p.poll_data,
                    p.status, p.approval_status, p.likes_count, p.comments_count, p.shares_count,
                    p.created_at, p.updated_at, p.original_post_id, p.is_reshare,
                    p.approved_at, p.approved_by,
                    FORMAT(p.approved_at, 'yyyy-MM-dd HH:mm:ss') as approved_at_formatted,
                    u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url,
                    (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id AND cuserid = @userId) as user_liked,
                    (SELECT COUNT(*) FROM nt_reshares WHERE original_post_id = p.id AND cuserid = @userId) as user_reshared,
                    (SELECT option_id FROM nt_poll_votes WHERE post_id = p.id AND cuserid = @userId) as user_voted_option,
                    op.id as original_id, op.content as original_content, op.cuserid as original_user_id,
                    ou.cuser_name as original_username, ou.cuser_name as original_full_name,
                    ou.cprofile_image_name as original_avatar_url, op.media_urls as original_media_urls
                FROM nt_posts p
                INNER JOIN users u ON p.cuserid = u.id
                LEFT JOIN nt_posts op ON p.original_post_id = op.id
                LEFT JOIN users ou ON op.cuserid = ou.id
                WHERE p.status = 'approved' 
                    AND p.approval_status = 'approved'
                ORDER BY p.approved_at DESC, p.created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);

        const posts = result.recordset.map(post => ({
            ...post,
            mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
            hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
            pollData: post.poll_data ? JSON.parse(post.poll_data || 'null') : null,
            userLiked: post.user_liked === 1,
            userReshared: post.user_reshared === 1,
            userVotedOption: post.user_voted_option !== null ? Number(post.user_voted_option) : null,
            display_date: post.approved_at || post.created_at,
            originalPost: post.original_id ? {
                id: post.original_id,
                content: post.original_content,
                cuserid: post.original_user_id,
                username: post.original_username,
                full_name: post.original_full_name,
                avatar_url: post.original_avatar_url,
                mediaUrls: post.original_media_urls ? JSON.parse(post.original_media_urls) : []
            } : null
        }));

        res.json({
            success: true,
            posts: posts,
            page,
            limit
        });
    } catch (error) {
        console.error('Error getting feed:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching feed',
            posts: []
        });
    }
};

// ==============================================
// SAVE POST
// ==============================================
export const savePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const existingResult = await pool.request()
            .input('userId', sql.Int, userId)
            .input('postId', sql.Int, id)
            .query('SELECT id FROM nt_saved_posts WHERE cuserid = @userId AND post_id = @postId');

        if (existingResult.recordset.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Post already saved'
            });
        }

        await pool.request()
            .input('userId', sql.Int, userId)
            .input('postId', sql.Int, id)
            .query('INSERT INTO nt_saved_posts (cuserid, post_id) VALUES (@userId, @postId)');

        res.json({ success: true, message: 'Post saved' });
    } catch (error) {
        console.error('Error saving post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save post',
            error: error.message
        });
    }
};

// ==============================================
// UNSAVE POST
// ==============================================
export const unsavePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        await pool.request()
            .input('userId', sql.Int, userId)
            .input('postId', sql.Int, id)
            .query('DELETE FROM nt_saved_posts WHERE cuserid = @userId AND post_id = @postId');

        res.json({ success: true, message: 'Post unsaved' });
    } catch (error) {
        console.error('Error unsaving post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unsave post',
            error: error.message
        });
    }
};

// ==============================================
// GET SAVED POSTS
// ==============================================
export const getSavedPosts = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .input('limit', sql.Int, limit)
            .input('offset', sql.Int, offset)
            .query(`
                SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url
                FROM nt_saved_posts sp
                JOIN nt_posts p ON sp.post_id = p.id
                JOIN users u ON p.cuserid = u.id
                WHERE sp.cuserid = @userId
                ORDER BY sp.created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);

        const posts = result.recordset.map(post => ({
            ...post,
            mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
            hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
            pollData: post.poll_data ? JSON.parse(post.poll_data) : null
        }));

        res.json({
            success: true,
            posts: posts,
            page,
            limit
        });
    } catch (error) {
        console.error('Error getting saved posts:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching saved posts',
            posts: []
        });
    }
};

// ==============================================
// REPORT POST
// ==============================================
export const reportPost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { reason, description } = req.body;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        await pool.request()
            .input('postId', sql.Int, id)
            .input('userId', sql.Int, userId)
            .input('reason', sql.NVarChar, reason)
            .input('description', sql.NVarChar, description)
            .query(`
                INSERT INTO nt_reports (post_id, cuserid, reason, description) 
                VALUES (@postId, @userId, @reason, @description)
            `);

        res.json({ success: true, message: 'Post reported' });
    } catch (error) {
        console.error('Error reporting post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to report post',
            error: error.message
        });
    }
};

// ==============================================
// GET TRENDING HASHTAGS
// ==============================================
export const getTrendingHashtags = async (req: AuthRequest, res: Response) => {
    try {
        const period = (req.query as any).period || 'day';
        const pool = await getSQLServerPool();

        let days = 1;
        if (period === 'week') days = 7;
        if (period === 'month') days = 30;

        const result = await pool.request()
            .input('days', sql.Int, days)
            .query(`
                SELECT 
                    h.name,
                    COUNT(DISTINCT ph.post_id) as post_count
                FROM nt_hashtags h
                LEFT JOIN nt_post_hashtags ph ON h.id = ph.hashtag_id
                LEFT JOIN nt_posts p ON ph.post_id = p.id
                WHERE p.created_at >= DATEADD(DAY, -@days, GETDATE()) OR p.created_at IS NULL
                GROUP BY h.id, h.name
                ORDER BY post_count DESC
            `);

        res.json({
            success: true,
            trending: result.recordset || [],
            period
        });
    } catch (error) {
        console.error('Error getting trending hashtags:', error);
        res.json({
            success: true,
            trending: [],
            period: 'day'
        });
    }
};

// ==============================================
// GET POSTS SIMPLE
// ==============================================
export const getPostsSimple = async (req: AuthRequest, res: Response) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('limit', sql.Int, Number(limit))
            .input('offset', sql.Int, offset)
            .query(`
                SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url
                FROM nt_posts p
                JOIN users u ON p.cuserid = u.id
                WHERE p.status = 'approved'
                ORDER BY p.created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);

        res.json({
            success: true,
            posts: result.recordset,
            page: Number(page),
            limit: Number(limit)
        });
    } catch (error) {
        console.error('Error getting posts:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching posts',
            posts: []
        });
    }
};

// ==============================================
// VOTE POLL
// ==============================================
export const votePoll = async (req: AuthRequest, res: Response) => {
    try {
        console.log('=== VOTE POLL FUNCTION STARTED ===');

        const { id } = req.params;
        let { optionId } = req.body;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const numericOptionId = Number(optionId);

        if (isNaN(numericOptionId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid option ID'
            });
        }

        const postResult = await pool.request()
            .input('postId', sql.Int, id)
            .query('SELECT * FROM nt_posts WHERE id = @postId AND type = "poll"');

        const post = postResult.recordset[0];

        if (!post) {
            return res.status(404).json({
                success: false,
                message: 'Poll not found'
            });
        }

        let pollData = null;
        if (post.poll_data) {
            try {
                pollData = typeof post.poll_data === 'string'
                    ? JSON.parse(post.poll_data)
                    : post.poll_data;
            } catch (parseError) {
                console.error('Error parsing poll data:', parseError);
                return res.status(500).json({
                    success: false,
                    message: 'Invalid poll data format'
                });
            }
        }

        if (!pollData || !pollData.options || !Array.isArray(pollData.options)) {
            return res.status(400).json({
                success: false,
                message: 'Poll data is corrupted'
            });
        }

        if (pollData.expiresAt && new Date(pollData.expiresAt) < new Date()) {
            return res.status(400).json({
                success: false,
                message: 'This poll has ended. No more votes can be cast.'
            });
        }

        const optionIndex = pollData.options.findIndex((opt: any) => Number(opt.id) === numericOptionId);

        if (optionIndex === -1) {
            return res.status(404).json({
                success: false,
                message: `Option not found`
            });
        }

        const existingVoteResult = await pool.request()
            .input('postId', sql.Int, id)
            .input('userId', sql.Int, userId)
            .query('SELECT id, option_id FROM nt_poll_votes WHERE post_id = @postId AND cuserid = @userId');

        let isNewVote = false;
        let voteChanged = false;

        if (existingVoteResult.recordset.length > 0) {
            const previousOptionId = existingVoteResult.recordset[0].option_id;

            if (Number(previousOptionId) !== numericOptionId) {
                const prevOptionIndex = pollData.options.findIndex((opt: any) => Number(opt.id) === Number(previousOptionId));
                if (prevOptionIndex !== -1) {
                    pollData.options[prevOptionIndex].votes = Math.max(0, (pollData.options[prevOptionIndex].votes || 0) - 1);
                }
                voteChanged = true;
            }

            await pool.request()
                .input('postId', sql.Int, id)
                .input('userId', sql.Int, userId)
                .input('optionId', sql.Int, numericOptionId)
                .query('UPDATE nt_poll_votes SET option_id = @optionId WHERE post_id = @postId AND cuserid = @userId');
        } else {
            await pool.request()
                .input('postId', sql.Int, id)
                .input('userId', sql.Int, userId)
                .input('optionId', sql.Int, numericOptionId)
                .query('INSERT INTO nt_poll_votes (post_id, cuserid, option_id) VALUES (@postId, @userId, @optionId)');
            isNewVote = true;
        }

        if (isNewVote || voteChanged) {
            pollData.options[optionIndex].votes = (pollData.options[optionIndex].votes || 0) + 1;
        }

        const totalVotesResult = await pool.request()
            .input('postId', sql.Int, id)
            .query('SELECT COUNT(*) as total FROM nt_poll_votes WHERE post_id = @postId');
        const actualTotalVotes = totalVotesResult.recordset[0]?.total || 0;
        pollData.totalVotes = actualTotalVotes;

        await pool.request()
            .input('postId', sql.Int, id)
            .input('pollData', sql.NVarChar, JSON.stringify(pollData))
            .query('UPDATE nt_posts SET poll_data = @pollData WHERE id = @postId');

        const finalVoteResult = await pool.request()
            .input('postId', sql.Int, id)
            .input('userId', sql.Int, userId)
            .query('SELECT option_id FROM nt_poll_votes WHERE post_id = @postId AND cuserid = @userId');
        const userVotedOption = finalVoteResult.recordset[0]?.option_id;

        let message = '';
        if (isNewVote) {
            message = 'Vote recorded successfully!';
        } else if (voteChanged) {
            message = 'Your vote has been changed successfully!';
        } else {
            message = 'Your vote has been updated!';
        }

        res.json({
            success: true,
            pollData: pollData,
            userVotedOption: userVotedOption,
            message: message,
            isNewVote: isNewVote,
            voteChanged: voteChanged,
            totalVotes: actualTotalVotes
        });

        const io = req.app.get('io');
        if (io) {
            io.to(`post_${id}`).emit('poll_updated', {
                postId: parseInt(id),
                pollData: pollData,
                userId: userId,
                optionId: numericOptionId,
                userVotedOption: userVotedOption,
                voteChanged: voteChanged,
                totalVotes: actualTotalVotes
            });
            console.log('Emitted poll_updated event');
        }
    } catch (error) {
        console.error('Error voting on poll:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to vote on poll',
            error: error.message
        });
    }
};

// ==============================================
// GET USER POLL VOTE
// ==============================================
export const getUserPollVote = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('postId', sql.Int, id)
            .input('userId', sql.Int, userId)
            .query('SELECT option_id FROM nt_poll_votes WHERE post_id = @postId AND cuserid = @userId');

        const votedOptionId = result.recordset[0]?.option_id || null;

        res.json({
            success: true,
            votedOptionId: votedOptionId
        });
    } catch (error) {
        console.error('Error checking user vote:', error);
        res.status(500).json({ success: false, message: 'Failed to check vote' });
    }
};

// ==============================================
// RESHARE POST
// ==============================================
export const resharePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const { comment, includeOriginal = true } = req.body;
        const pool = await getSQLServerPool();

        console.log('🔄 Reshare request:', { originalPostId: id, userId, comment, includeOriginal });

        if (comment) {
            const existingResult = await pool.request()
                .input('userId', sql.Int, userId)
                .input('postId', sql.Int, id)
                .input('comment', sql.NVarChar, comment)
                .query('SELECT id FROM nt_reshares WHERE cuserid = @userId AND original_post_id = @postId AND comment = @comment');

            if (existingResult.recordset.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'You have already reshared this post with the same comment'
                });
            }
        }

        const originalPostResult = await pool.request()
            .input('postId', sql.Int, id)
            .query('SELECT * FROM nt_posts WHERE id = @postId');

        if (originalPostResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Original post not found'
            });
        }

        const originalPost = originalPostResult.recordset[0];

        // Get user name for the reshare message
        const username = originalPost.cuser_name || 'user';

        const reshareContent = comment || `Reshared a post by @${username}`;

        const insertResult = await pool.request()
            .input('userId', sql.Int, userId)
            .input('content', sql.NVarChar, reshareContent)
            .input('type', sql.NVarChar, originalPost.type)
            .input('mediaUrls', sql.NVarChar, includeOriginal ? originalPost.media_urls : '[]')
            .input('originalPostId', sql.Int, id)
            .query(`
                INSERT INTO nt_posts (cuserid, content, type, media_urls, original_post_id, is_reshare, status, approval_status, created_at)
                OUTPUT INSERTED.id
                VALUES (@userId, @content, @type, @mediaUrls, @originalPostId, 1, 'approved', 'approved', GETDATE())
            `);

        const resharedPostId = insertResult.recordset[0]?.id;

        await pool.request()
            .input('userId', sql.Int, userId)
            .input('originalPostId', sql.Int, id)
            .input('resharedPostId', sql.Int, resharedPostId)
            .input('comment', sql.NVarChar, comment)
            .input('includeOriginal', sql.Bit, includeOriginal ? 1 : 0)
            .query(`
                INSERT INTO nt_reshares (cuserid, original_post_id, reshared_post_id, comment, include_original)
                VALUES (@userId, @originalPostId, @resharedPostId, @comment, @includeOriginal)
            `);

        await pool.request()
            .input('postId', sql.Int, id)
            .query('UPDATE nt_posts SET shares_count = shares_count + 1 WHERE id = @postId');

        const updatedPostResult = await pool.request()
            .input('postId', sql.Int, id)
            .query('SELECT shares_count FROM nt_posts WHERE id = @postId');

        const userInfoResult = await pool.request()
            .input('userId', sql.Int, userId)
            .query('SELECT cuser_name as username, cuser_name as full_name, cprofile_image_name as avatar_url FROM users WHERE id = @userId');

        const resharedPost = {
            id: resharedPostId,
            cuserid: userId,
            content: reshareContent,
            type: originalPost.type,
            mediaUrls: includeOriginal ? JSON.parse(originalPost.media_urls || '[]') : [],
            original_post_id: id,
            is_reshare: true,
            created_at: new Date(),
            user: userInfoResult.recordset[0],
            original_post: {
                id: originalPost.id,
                content: originalPost.content,
                cuserid: originalPost.cuserid,
                username: originalPost.cuser_name || 'unknown',
                full_name: originalPost.cuser_name || 'Unknown User',
                mediaUrls: JSON.parse(originalPost.media_urls || '[]')
            }
        };

        const io = req.app.get('io');
        if (io) {
            io.emit('post_reshared', {
                reshare: resharedPost,
                originalPostId: parseInt(id),
                userId: userId,
                shares_count: updatedPostResult.recordset[0]?.shares_count || 0
            });
            console.log(`📤 Emitted post_reshared for post ${id}`);
        }

        res.status(201).json({
            success: true,
            message: 'Post reshared successfully',
            shares_count: updatedPostResult.recordset[0]?.shares_count || 0,
            reshare: resharedPost
        });
    } catch (error) {
        console.error('Error resharing post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reshare post',
            error: error.message
        });
    }
};

// ==============================================
// UNRESHARE POST
// ==============================================
export const unResharePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        console.log('🔁 Removing reshare:', { originalPostId: id, userId });

        const reshareResult = await pool.request()
            .input('userId', sql.Int, userId)
            .input('postId', sql.Int, id)
            .query('SELECT * FROM nt_reshares WHERE cuserid = @userId AND original_post_id = @postId');

        if (reshareResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Reshare not found'
            });
        }

        const reshare = reshareResult.recordset[0];

        if (reshare.reshared_post_id) {
            await pool.request()
                .input('resharedPostId', sql.Int, reshare.reshared_post_id)
                .query('DELETE FROM nt_posts WHERE id = @resharedPostId');
        }

        await pool.request()
            .input('reshareId', sql.Int, reshare.id)
            .query('DELETE FROM nt_reshares WHERE id = @reshareId');

        await pool.request()
            .input('postId', sql.Int, id)
            .query('UPDATE nt_posts SET shares_count = shares_count - 1 WHERE id = @postId');

        const updatedPostResult = await pool.request()
            .input('postId', sql.Int, id)
            .query('SELECT shares_count FROM nt_posts WHERE id = @postId');

        const io = req.app.get('io');
        if (io) {
            io.emit('post_unreshared', {
                originalPostId: parseInt(id),
                userId: userId,
                shares_count: updatedPostResult.recordset[0]?.shares_count || 0
            });
            console.log(`📤 Emitted post_unreshared for post ${id}`);
        }

        res.json({
            success: true,
            message: 'Reshare removed',
            shares_count: updatedPostResult.recordset[0]?.shares_count || 0
        });
    } catch (error) {
        console.error('Error removing reshare:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove reshare',
            error: error.message
        });
    }
};

// ==============================================
// GET RESHARE STATUS
// ==============================================
export const getReshareStatus = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .input('postId', sql.Int, id)
            .query('SELECT id FROM nt_reshares WHERE cuserid = @userId AND original_post_id = @postId');

        res.json({
            success: true,
            isReshared: result.recordset.length > 0
        });
    } catch (error) {
        console.error('Error checking reshare status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check reshare status',
            error: error.message
        });
    }
};

// ==============================================
// GET RESHARED FEED
// ==============================================
export const getResharedFeed = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const pool = await getSQLServerPool();

        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .input('limit', sql.Int, limit)
            .input('offset', sql.Int, offset)
            .query(`
                SELECT 
                    p.id, p.cuserid, p.content, p.type, p.media_urls, p.hashtags, p.poll_data,
                    p.status, p.approval_status, p.likes_count, p.comments_count, p.shares_count,
                    p.created_at, p.updated_at, p.original_post_id, p.is_reshare,
                    u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url,
                    (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id AND cuserid = @userId) as user_liked,
                    (SELECT COUNT(*) FROM nt_reshares WHERE original_post_id = p.id AND cuserid = @userId) as user_reshared,
                    op.id as original_id, op.content as original_content, op.cuserid as original_user_id,
                    ou.cuser_name as original_username, ou.cuser_name as original_full_name,
                    ou.cprofile_image_name as original_avatar_url, op.media_urls as original_media_urls
                FROM nt_posts p
                INNER JOIN users u ON p.cuserid = u.id
                LEFT JOIN nt_posts op ON p.original_post_id = op.id
                LEFT JOIN users ou ON op.cuserid = ou.id
                WHERE p.status = 'approved' 
                    AND p.approval_status = 'approved'
                    AND (p.is_reshare = 1 OR p.original_post_id IS NOT NULL)
                ORDER BY p.created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);

        const posts = result.recordset.map(post => ({
            ...post,
            mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
            hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
            pollData: post.poll_data ? JSON.parse(post.poll_data || 'null') : null,
            userLiked: post.user_liked === 1,
            userReshared: post.user_reshared === 1,
            originalPost: post.original_id ? {
                id: post.original_id,
                content: post.original_content,
                cuserid: post.original_user_id,
                username: post.original_username,
                full_name: post.original_full_name,
                avatar_url: post.original_avatar_url,
                mediaUrls: post.original_media_urls ? JSON.parse(post.original_media_urls) : []
            } : null
        }));

        res.json({
            success: true,
            posts: posts,
            page,
            limit
        });
    } catch (error) {
        console.error('Error getting reshared feed:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching reshared feed',
            posts: []
        });
    }
};