import { Request, Response } from 'express';
import { executeQuery, executeNonQuery, executeTransaction } from '../config/database';
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

        // Delete original file
        await fs.unlink(filePath);

        return outputPath;
    } catch (error) {
        console.error('Error processing image:', error);
        return filePath;
    }
};

export const createPost = async (req: AuthRequest, res: Response) => {
    try {
        const { content, type, pollData, hashtags } = req.body;
        const userId = req.user!.id;

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

                // Only process images (videos are kept as-is)
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

        // Ensure pollData is properly stringified if it exists
        let finalPollData = null;
        if (pollData) {
            if (typeof pollData === 'string') {
                finalPollData = pollData;
            } else {
                finalPollData = JSON.stringify(pollData);
            }
            console.log('📊 Poll data prepared for storage:', finalPollData.substring(0, 200));
        }

        // Insert post with SQL Server syntax - using OUTPUT INSERTED.id to get the ID
        const query = `
            INSERT INTO nt_posts (
                cuserid,  
                content, 
                type, 
                media_urls, 
                poll_data, 
                hashtags, 
                status, 
                approval_status,
                created_at,
                approved_at
            ) 
            OUTPUT INSERTED.id
            VALUES (@userId, @content, @type, @mediaUrls, @pollData, @hashtags, 'pending', 'waiting', GETDATE(), NULL)
        `;

        const result = await executeQuery<any>(
            query,
            {
                userId,
                content: content || null,
                type: type || 'text',
                mediaUrls: JSON.stringify(mediaUrls),
                pollData: finalPollData,
                hashtags: hashtags ? JSON.stringify(hashtags) : null
            }
        );

        // Get the inserted ID from the result
        const postId = result && result.length > 0 ? result[0].id : null;

        if (!postId) {
            throw new Error('Failed to get post ID after insertion');
        }

        console.log(`✅ Post created with ID: ${postId}`);

        // Get user info for the post
        const userRows = await executeQuery<any>(
            'SELECT cuser_name as username, cuser_name as full_name, cprofile_image_name as avatar_url FROM users WHERE id = @userId',
            { userId }
        );
        const user = userRows[0];

        // Get the created post with timestamps
        const newPostRows = await executeQuery<any>(
            `SELECT 
                id, cuserid, content, type, media_urls, poll_data, hashtags,
                status, approval_status, likes_count, comments_count, shares_count,
                created_at, approved_at,
                FORMAT(created_at, 'yyyy-MM-dd HH:mm:ss') as created_at_formatted
             FROM nt_posts 
             WHERE id = @postId`,
            { postId }
        );

        const createdPost = newPostRows[0];

        if (!createdPost) {
            throw new Error('Failed to retrieve created post');
        }

        // Parse pollData for response if it exists
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

        // EMIT SOCKET EVENT FOR NEW POST
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

export const getPosts = async (req: AuthRequest, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const userId = Number(req.user.id);

        const search = req.query.search as string || '';
        const filterType = req.query.filterType as string || 'all';
        const sortBy = req.query.sortBy as string || 'latest';

        // Build WHERE clause - Using correct column names
        let whereConditions: string[] = [
            "p.status = 'approved'",
            "p.approval_status = 'approved'",
            "(p.is_reshare = 0 OR p.is_reshare = 1)"
        ];

        let params: any = { userId };

        // Search filter - Using cuser_name
        if (search) {
            const searchPattern = `%${search}%`;
            whereConditions.push(`(
                p.content LIKE @searchPattern 
                OR u.cuser_name LIKE @searchPattern 
                OR p.hashtags LIKE @searchPattern
            )`);
            params.searchPattern = searchPattern;
        }

        // Filter type: saved posts - Only if table exists
        if (filterType === 'saved') {
            try {
                const tableCheck = await executeQuery<any>(
                    "SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_saved_posts'"
                );
                if (tableCheck && tableCheck.length > 0) {
                    whereConditions.push(`EXISTS (SELECT 1 FROM nt_saved_posts sp WHERE sp.post_id = p.id AND sp.cuserid = @userId)`);
                } else {
                    console.log('⚠️ nt_saved_posts table does not exist, skipping saved filter');
                    return res.json({
                        success: true,
                        posts: [],
                        page,
                        limit,
                        total: 0,
                        totalPages: 0
                    });
                }
            } catch (err) {
                console.log('⚠️ Error checking nt_saved_posts table:', err);
                return res.json({
                    success: true,
                    posts: [],
                    page,
                    limit,
                    total: 0,
                    totalPages: 0
                });
            }
        }

        // Filter type: my posts
        if (filterType === 'my-posts') {
            whereConditions.push(`p.cuserid = @userId`);
        }

        const whereClause = whereConditions.join(' AND ');

        // Main query
        const query = `
            SELECT 
                p.id,
                p.cuserid,
                p.content,
                p.type,
                p.media_urls,
                p.hashtags,
                p.poll_data,
                p.status,
                p.approval_status,
                p.likes_count,
                p.comments_count,
                p.shares_count,
                p.view_count,
                p.created_at,
                p.updated_at,
                p.original_post_id,
                p.is_reshare,
                p.approved_at,
                p.approved_by,
                u.cuser_name as username,
                u.cuser_name as full_name,
                u.cprofile_image_name as avatar_url,
                FORMAT(p.approved_at, 'yyyy-MM-dd HH:mm:ss') as approved_at_formatted,
                FORMAT(p.created_at, 'yyyy-MM-dd HH:mm:ss') as created_at_formatted,
                (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id) as likes_count_agg,
                (SELECT COUNT(*) FROM nt_comments WHERE post_id = p.id AND status = 'active') as comments_count_agg,
                (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id AND cuserid = @userId) as user_liked,
                (SELECT COUNT(*) FROM nt_reshares WHERE original_post_id = p.id AND cuserid = @userId) as user_reshared,
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
            JOIN users u ON p.cuserid = u.cuserid
            LEFT JOIN nt_posts op ON p.original_post_id = op.id
            LEFT JOIN users ou ON op.cuserid = ou.cuserid
            WHERE ${whereClause}
            ORDER BY post_publish_time DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;

        const queryParams = {
            ...params,
            offset,
            limit
        };

        const posts = await executeQuery<any>(query, queryParams);

        // Count query - FIXED: Use the same params that were used in the main query
        let countQuery = `
            SELECT COUNT(DISTINCT p.id) as total
            FROM nt_posts p
            JOIN users u ON p.cuserid = u.cuserid
            WHERE ${whereClause}
        `;

        // If filter is 'saved', we need to join with nt_saved_posts for count
        if (filterType === 'saved') {
            countQuery = `
                SELECT COUNT(DISTINCT p.id) as total
                FROM nt_posts p
                JOIN users u ON p.cuserid = u.cuserid
                JOIN nt_saved_posts sp ON p.id = sp.post_id AND sp.cuserid = @userId
                WHERE ${whereClause.replace(/EXISTS \(SELECT 1 FROM nt_saved_posts sp WHERE sp.post_id = p.id AND sp.cuserid = @userId\)/g, '1=1')}
            `;
        }

        // FIXED: Pass the same params to the count query
        const countResult = await executeQuery<any>(countQuery, params);
        const total = countResult[0]?.total || 0;

        // Process posts with media
        const postsWithMedia = posts.map(post => {
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

            const likesCount = post.likes_count_agg || post.likes_count || 0;
            const commentsCount = post.comments_count_agg || post.comments_count || 0;

            return {
                id: post.id,
                cuserid: post.cuserid,
                content: post.content,
                type: post.type,
                mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
                hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
                pollData: post.poll_data ? JSON.parse(post.poll_data) : null,
                status: post.status,
                approval_status: post.approval_status,
                likes_count: likesCount,
                comments_count: commentsCount,
                shares_count: post.shares_count || 0,
                view_count: post.view_count || 0,
                created_at: post.created_at,
                updated_at: post.updated_at,
                approved_at: post.approved_at,
                original_post_id: post.original_post_id,
                is_reshare: post.is_reshare,
                username: post.username,
                full_name: post.full_name,
                avatar_url: post.avatar_url,
                userLiked: post.user_liked === 1 || post.user_liked === true,
                userReshared: post.user_reshared === 1 || post.user_reshared === true,
                userVotedOption: post.user_voted_option !== null ? Number(post.user_voted_option) : null,
                userSaved: false,
                display_date: post.approved_at || post.created_at,
                post_publish_time: post.post_publish_time || post.approved_at || post.created_at,
                originalPost: post.original_id ? {
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
                    approved_at: post.original_approved_at
                } : null
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

export const getPost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const query = `
            SELECT 
                p.*, 
                u.cuser_name as username, 
                u.cuser_name as full_name, 
                u.avatar_url,
                (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id AND cuserid = @userId) as user_liked
            FROM nt_posts p
            JOIN users u ON p.cuserid = u.id
            WHERE p.id = @postId
        `;

        const posts = await executeQuery<any>(query, { postId: parseInt(id), userId });
        const post = posts[0];

        if (!post) {
            return res.status(404).json({ success: false, message: 'Post not found' });
        }

        // Parse JSON fields
        post.mediaUrls = post.media_urls ? JSON.parse(post.media_urls) : [];
        post.hashtags = post.hashtags ? JSON.parse(post.hashtags) : [];
        post.pollData = post.poll_data ? JSON.parse(post.poll_data) : null;
        post.userLiked = post.user_liked === 1 || post.user_liked === true;

        // Get likes and comments counts
        const likesResult = await executeQuery<any>(
            'SELECT COUNT(*) as count FROM nt_reactions WHERE post_id = @postId',
            { postId: parseInt(id) }
        );
        const commentsResult = await executeQuery<any>(
            'SELECT COUNT(*) as count FROM nt_comments WHERE post_id = @postId',
            { postId: parseInt(id) }
        );

        post.likes_count = likesResult[0]?.count || 0;
        post.comments_count = commentsResult[0]?.count || 0;

        res.json({ success: true, post });
    } catch (error) {
        console.error('Error getting post:', error);
        res.status(500).json({ success: false, message: 'Error fetching post' });
    }
};

export const updatePost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { content, mediaUrls } = req.body;
    const userId = req.user!.id;

    const result = await executeNonQuery(
        'UPDATE nt_posts SET content = @content, media_urls = @mediaUrls WHERE id = @postId AND cuserid = @userId',
        {
            content,
            mediaUrls: mediaUrls ? JSON.stringify(mediaUrls) : null,
            postId: parseInt(id),
            userId
        }
    );

    if (result.rowsAffected && result.rowsAffected[0] === 0) {
        throw new AppError('Post not found or unauthorized', 404);
    }

    res.json({ success: true, message: 'Post updated successfully' });
};

export const deletePost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    let query = 'DELETE FROM nt_posts WHERE id = @postId AND cuserid = @userId';
    let params: any = { postId: parseInt(id), userId };

    if (userRole === 'admin') {
        query = 'DELETE FROM nt_posts WHERE id = @postId';
        params = { postId: parseInt(id) };
    }

    const result = await executeNonQuery(query, params);

    if (result.rowsAffected && result.rowsAffected[0] === 0) {
        throw new AppError('Post not found or unauthorized', 404);
    }

    res.json({ success: true, message: 'Post deleted successfully' });
};

export const getComments = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const userId = req.user.id;

        console.log('📥 Getting comments for post:', id);

        // Get comments with user details
        const comments = await executeQuery<any>(
            `SELECT 
                c.*, 
                u.cuser_name as username, 
                u.cuser_name as full_name, 
                u.cprofile_image_name as avatar_url
             FROM nt_comments c
             JOIN users u ON c.cuserid = u.cuserid
             WHERE c.post_id = @postId AND c.status = 'active'
             ORDER BY c.created_at DESC
             OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
            { postId: parseInt(id), offset, limit }
        );

        // Format date to IST using moment-timezone
        const formatDateToIST = (date: any) => {
            if (!date) return null;
            return moment(date).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');
        };

        // Check if user liked each comment and format dates
        const commentsWithLikes = await Promise.all(comments.map(async (comment: any) => {
            const liked = await executeQuery<any>(
                'SELECT id FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId',
                { userId, commentId: comment.id }
            );

            return {
                ...comment,
                userLiked: liked && liked.length > 0,
                likesCount: comment.likes_count || 0,
                created_at: formatDateToIST(comment.created_at),
                updated_at: formatDateToIST(comment.updated_at)
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

export const addComment = async (req: AuthRequest, res: Response) => {
    try {
        const { postId, content, parentCommentId } = req.body;
        const userId = req.user!.id;

        // Insert comment
        const result = await executeNonQuery(
            `INSERT INTO nt_comments (post_id, cuserid, parent_comment_id, content, status) 
             VALUES (@postId, @userId, @parentCommentId, @content, 'active')`,
            {
                postId: parseInt(postId),
                userId,
                parentCommentId: parentCommentId || null,
                content
            }
        );

        const commentId = result.recordset?.[0]?.id || result.insertId;

        // Get the comment with user details
        const comments = await executeQuery<any>(
            `SELECT c.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url 
             FROM nt_comments c 
             JOIN users u ON c.cuserid = u.id 
             WHERE c.id = @commentId`,
            { commentId }
        );

        const comment = comments[0];

        // Update post comments count
        await executeNonQuery(
            'UPDATE nt_posts SET comments_count = comments_count WHERE id = @postId',
            { postId: parseInt(postId) }
        );

        // Get updated count
        const countResult = await executeQuery<any>(
            'SELECT comments_count FROM nt_posts WHERE id = @postId',
            { postId: parseInt(postId) }
        );
        const newCommentsCount = countResult[0]?.comments_count || 0;

        // Send HTTP response
        res.json({
            success: true,
            comment: comment,
            commentsCount: newCommentsCount
        });

        // Emit socket event for OTHER users
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

export const deleteComment = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    const comment = await executeQuery<any>(
        'SELECT post_id FROM nt_comments WHERE id = @commentId AND cuserid = @userId',
        { commentId: parseInt(id), userId }
    );

    if (!comment || comment.length === 0) {
        throw new AppError('Comment not found or unauthorized', 404);
    }

    const postId = comment[0].post_id;

    await executeNonQuery('UPDATE nt_comments SET status = "deleted" WHERE id = @commentId', { commentId: parseInt(id) });
    await executeNonQuery('UPDATE nt_posts SET comments_count = comments_count - 1 WHERE id = @postId', { postId });

    res.json({ success: true, message: 'Comment deleted successfully' });
};

export const addReaction = async (req: AuthRequest, res: Response) => {
    try {
        const { postId } = req.body;
        const userId = req.user.id;

        console.log('❤️ Toggling like for post:', postId, 'User:', userId);

        // Check if already liked
        const existing = await executeQuery<any>(
            'SELECT id FROM nt_reactions WHERE cuserid = @userId AND post_id = @postId',
            { userId, postId: parseInt(postId) }
        );

        let isLiked = false;
        let likesCount = 0;

        if (existing && existing.length > 0) {
            // Unlike - use square brackets for reserved keyword
            await executeNonQuery(
                'DELETE FROM nt_reactions WHERE cuserid = @userId AND post_id = @postId',
                { userId, postId: parseInt(postId) }
            );
            await executeNonQuery(
                'UPDATE nt_posts SET likes_count = likes_count - 1 WHERE id = @postId',
                { postId: parseInt(postId) }
            );
            isLiked = false;
        } else {
            // Like - use square brackets for reserved keyword
            await executeNonQuery(
                'INSERT INTO nt_reactions (cuserid, post_id, [type]) VALUES (@userId, @postId, @type)',
                { userId, postId: parseInt(postId), type: 'like' }
            );
            await executeNonQuery(
                'UPDATE nt_posts SET likes_count = likes_count + 1 WHERE id = @postId',
                { postId: parseInt(postId) }
            );
            isLiked = true;
        }

        // Get updated likes count
        const count = await executeQuery<any>(
            'SELECT likes_count FROM nt_posts WHERE id = @postId',
            { postId: parseInt(postId) }
        );
        likesCount = count[0]?.likes_count || 0;

        console.log(`📊 Updated likes count for post ${postId}: ${likesCount}`);

        // EMIT SOCKET EVENT FOR REAL-TIME UPDATE
        const io = req.app.get('io');
        if (io) {
            const eventData = {
                postId: parseInt(postId),
                count: likesCount,
                likesCount: likesCount,
                userId: userId,
                isLiked: isLiked
            };
            io.to(`post_${postId}`).emit('reaction_updated', eventData);
            io.emit('reaction_updated_global', eventData);
            console.log(`📤 Emitted reaction_updated for post ${postId}:`, eventData);
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

export const addCommentReaction = async (req: AuthRequest, res: Response) => {
    try {
        const commentId = parseInt(req.params.id);
        const userId = req.user!.id;

        console.log('❤️ Toggling like for comment:', commentId, 'User:', userId);

        // First check if comment exists
        const commentExists = await executeQuery<any>(
            'SELECT id FROM nt_comments WHERE id = @commentId',
            { commentId }
        );

        if (!commentExists || commentExists.length === 0) {
            return res.status(404).json({ success: false, message: 'Comment not found' });
        }

        // Check if already liked this comment
        const existing = await executeQuery<any>(
            'SELECT id FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId',
            { userId, commentId }
        );

        if (existing && existing.length > 0) {
            // Unlike - remove reaction
            await executeNonQuery(
                'DELETE FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId',
                { userId, commentId }
            );
            await executeNonQuery(
                'UPDATE nt_comments SET likes_count = likes_count - 1 WHERE id = @commentId',
                { commentId }
            );
            console.log('👎 Comment unliked');
        } else {
            // Like - add reaction - use square brackets for reserved keyword
            await executeNonQuery(
                'INSERT INTO nt_reactions (cuserid, comment_id, [type]) VALUES (@userId, @commentId, @type)',
                { userId, commentId, type: 'like' }
            );
            await executeNonQuery(
                'UPDATE nt_comments SET likes_count = likes_count + 1 WHERE id = @commentId',
                { commentId }
            );
            console.log('👍 Comment liked');
        }

        // Get updated likes count
        const count = await executeQuery<any>(
            'SELECT likes_count FROM nt_comments WHERE id = @commentId',
            { commentId }
        );
        const likesCount = count[0]?.likes_count || 0;

        res.json({
            success: true,
            likes_count: likesCount,
            isLiked: existing && existing.length === 0
        });
    } catch (error) {
        console.error('Error toggling comment like:', error);
        res.status(500).json({ success: false, message: 'Failed to toggle like' });
    }
};

export const removeCommentReaction = async (req: AuthRequest, res: Response) => {
    try {
        const commentId = parseInt(req.params.id);
        const userId = req.user!.id;

        console.log('👎 Removing like for comment:', commentId, 'User:', userId);

        // Check if the reaction exists
        const existing = await executeQuery<any>(
            'SELECT id FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId',
            { userId, commentId }
        );

        if (!existing || existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Reaction not found'
            });
        }

        // Delete the reaction
        await executeNonQuery(
            'DELETE FROM nt_reactions WHERE cuserid = @userId AND comment_id = @commentId',
            { userId, commentId }
        );

        // Update comment likes count
        await executeNonQuery(
            'UPDATE nt_comments SET likes_count = likes_count - 1 WHERE id = @commentId',
            { commentId }
        );

        // Get updated likes count
        const count = await executeQuery<any>(
            'SELECT likes_count FROM nt_comments WHERE id = @commentId',
            { commentId }
        );
        const likesCount = count[0]?.likes_count || 0;

        console.log('✅ Comment unliked successfully. New likes count:', likesCount);

        res.json({
            success: true,
            likes_count: likesCount,
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

export const removeReaction = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    const reaction = await executeQuery<any>(
        'SELECT post_id FROM nt_reactions WHERE id = @reactionId AND cuserid = @userId',
        { reactionId: parseInt(id), userId }
    );

    if (!reaction || reaction.length === 0) {
        throw new AppError('Reaction not found', 404);
    }

    const postId = reaction[0].post_id;

    await executeNonQuery('DELETE FROM nt_reactions WHERE id = @reactionId', { reactionId: parseInt(id) });
    await executeNonQuery('UPDATE nt_posts SET likes_count = likes_count - 1 WHERE id = @postId', { postId });

    res.json({ success: true, message: 'Reaction removed' });
};

export const getReactions = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    const reactions = await executeQuery<any>(
        `SELECT r.type, COUNT(*) as count 
         FROM nt_reactions r
         WHERE r.post_id = @postId
         GROUP BY r.type`,
        { postId: parseInt(id) }
    );

    res.json({ success: true, reactions });
};

export const sharePost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    await executeNonQuery(
        'UPDATE nt_posts SET shares_count = shares_count + 1 WHERE id = @postId',
        { postId: parseInt(id) }
    );

    res.json({ success: true, message: 'Post shared' });
};

export const getFeed = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        const query = `
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
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;

        const posts = await executeQuery<any>(query, { userId, offset, limit });

        // Parse JSON fields for each post
        const postsWithMedia = posts.map(post => ({
            ...post,
            mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
            hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
            pollData: post.poll_data ? JSON.parse(post.poll_data || 'null') : null,
            userLiked: post.user_liked === 1 || post.user_liked === true,
            userReshared: post.user_reshared === 1 || post.user_reshared === true,
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
            posts: postsWithMedia,
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

export const savePost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    try {
        // Check if already saved
        const existing = await executeQuery<any>(
            'SELECT id FROM nt_saved_posts WHERE cuserid = @userId AND post_id = @postId',
            { userId, postId: parseInt(id) }
        );

        if (existing && existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Post already saved'
            });
        }

        await executeNonQuery(
            'INSERT INTO nt_saved_posts (cuserid, post_id) VALUES (@userId, @postId)',
            { userId, postId: parseInt(id) }
        );

        res.json({ success: true, message: 'Post saved' });
    } catch (error) {
        console.error('Error saving post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save post'
        });
    }
};

export const unsavePost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    await executeNonQuery(
        'DELETE FROM nt_saved_posts WHERE cuserid = @userId AND post_id = @postId',
        { userId, postId: parseInt(id) }
    );

    res.json({ success: true, message: 'Post unsaved' });
};

export const getSavedPosts = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        const query = `
            SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url
            FROM nt_saved_posts sp
            JOIN nt_posts p ON sp.post_id = p.id
            JOIN users u ON p.cuserid = u.id
            WHERE sp.cuserid = @userId
            ORDER BY sp.created_at DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;

        const posts = await executeQuery<any>(query, { userId, offset, limit });

        // Parse JSON fields
        const postsWithMedia = posts.map(post => ({
            ...post,
            mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
            hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
            pollData: post.poll_data ? JSON.parse(post.poll_data) : null
        }));

        res.json({
            success: true,
            posts: postsWithMedia,
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

export const reportPost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { reason, description } = req.body;
    const userId = req.user!.id;

    await executeNonQuery(
        'INSERT INTO nt_reports (post_id, cuserid, reason, description) VALUES (@postId, @userId, @reason, @description)',
        { postId: parseInt(id), userId, reason, description }
    );

    res.json({ success: true, message: 'Post reported' });
};

export const getTrendingHashtags = async (req: AuthRequest, res: Response) => {
    const { period = 'day' } = req.query;

    try {
        const query = `
            SELECT 
                h.name,
                COUNT(DISTINCT ph.post_id) as post_count
            FROM nt_hashtags h
            LEFT JOIN nt_post_hashtags ph ON h.id = ph.hashtag_id
            LEFT JOIN nt_posts p ON ph.post_id = p.id
            WHERE p.created_at >= DATEADD(day, -1, GETDATE())
                OR p.created_at IS NULL
            GROUP BY h.id, h.name
            ORDER BY post_count DESC
            OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY
        `;

        const trending = await executeQuery<any>(query);

        res.json({
            success: true,
            trending: trending || [],
            period
        });
    } catch (error) {
        console.error('Error getting trending hashtags:', error);
        res.json({
            success: true,
            trending: [],
            period
        });
    }
};

export const getPostsSimple = async (req: AuthRequest, res: Response) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    try {
        const posts = await executeQuery<any>(
            `SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url
             FROM nt_posts p
             JOIN users u ON p.cuserid = u.id
             WHERE p.status = 'approved'
             ORDER BY p.created_at DESC
             OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
            { offset, limit }
        );

        res.json({
            success: true,
            posts,
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

export const votePoll = async (req: AuthRequest, res: Response) => {
    try {
        console.log('=== VOTE POLL FUNCTION STARTED ===');

        const { id } = req.params;
        let { optionId } = req.body;
        const userId = req.user!.id;

        const numericOptionId = Number(optionId);

        if (isNaN(numericOptionId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid option ID'
            });
        }

        // FIXED: Use single quotes for string values, not double quotes
        const posts = await executeQuery<any>(
            'SELECT * FROM nt_posts WHERE id = @postId AND [type] = @type',
            {
                postId: parseInt(id),
                type: 'poll'
            }
        );

        const post = posts[0];

        if (!post) {
            return res.status(404).json({
                success: false,
                message: 'Poll not found'
            });
        }

        // Parse poll data
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

        // Check if poll has expired
        if (pollData.expiresAt && new Date(pollData.expiresAt) < new Date()) {
            return res.status(400).json({
                success: false,
                message: 'This poll has ended. No more votes can be cast.'
            });
        }

        // Find the selected option
        const optionIndex = pollData.options.findIndex((opt: any) => Number(opt.id) === numericOptionId);

        if (optionIndex === -1) {
            return res.status(404).json({
                success: false,
                message: `Option not found`
            });
        }

        // Check if user has already voted
        const existingVote = await executeQuery<any>(
            'SELECT id, option_id FROM nt_poll_votes WHERE post_id = @postId AND cuserid = @userId',
            { postId: parseInt(id), userId }
        );

        let isNewVote = false;
        let voteChanged = false;

        if (existingVote && existingVote.length > 0) {
            const previousOptionId = existingVote[0].option_id;

            console.log('User already has a vote:', {
                previousOptionId,
                newOptionId: numericOptionId,
                isSameVote: Number(previousOptionId) === numericOptionId
            });

            // If different option, remove previous vote count
            if (Number(previousOptionId) !== numericOptionId) {
                const prevOptionIndex = pollData.options.findIndex((opt: any) => Number(opt.id) === Number(previousOptionId));
                if (prevOptionIndex !== -1) {
                    pollData.options[prevOptionIndex].votes = Math.max(0, (pollData.options[prevOptionIndex].votes || 0) - 1);
                    console.log('Removed previous vote from option:', previousOptionId);
                }
                voteChanged = true;
            }

            // Update vote record
            await executeNonQuery(
                'UPDATE nt_poll_votes SET option_id = @optionId WHERE post_id = @postId AND cuserid = @userId',
                { optionId: numericOptionId, postId: parseInt(id), userId }
            );
        } else {
            // First time voting
            console.log('First time voting for user');
            await executeNonQuery(
                'INSERT INTO nt_poll_votes (post_id, cuserid, option_id) VALUES (@postId, @userId, @optionId)',
                { postId: parseInt(id), userId, optionId: numericOptionId }
            );
            isNewVote = true;
        }

        // Add vote to selected option (if not same option vote)
        if (isNewVote || voteChanged) {
            pollData.options[optionIndex].votes = (pollData.options[optionIndex].votes || 0) + 1;
        }

        // Recalculate totalVotes from ALL options in the database
        const allVotes = await executeQuery<any>(
            'SELECT COUNT(*) as total FROM nt_poll_votes WHERE post_id = @postId',
            { postId: parseInt(id) }
        );
        const actualTotalVotes = allVotes[0]?.total || 0;

        // Use the actual database count as source of truth
        pollData.totalVotes = actualTotalVotes;

        console.log('Vote count verification:', {
            actualFromDatabase: actualTotalVotes,
            pollDataTotalVotes: pollData.totalVotes,
            isNewVote,
            voteChanged
        });

        // Save updated poll data
        await executeNonQuery(
            'UPDATE nt_posts SET poll_data = @pollData WHERE id = @postId',
            { pollData: JSON.stringify(pollData), postId: parseInt(id) }
        );

        // Get final user vote
        const finalVote = await executeQuery<any>(
            'SELECT option_id FROM nt_poll_votes WHERE post_id = @postId AND cuserid = @userId',
            { postId: parseInt(id), userId }
        );
        const userVotedOption = finalVote[0]?.option_id;

        // Prepare response message
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

        // Emit socket event for real-time updates
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

export const getUserPollVote = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const vote = await executeQuery<any>(
            'SELECT option_id FROM nt_poll_votes WHERE post_id = @postId AND cuserid = @userId',
            { postId: parseInt(id), userId }
        );

        const votedOptionId = vote[0]?.option_id || null;

        res.json({
            success: true,
            votedOptionId: votedOptionId
        });
    } catch (error) {
        console.error('Error checking user vote:', error);
        res.status(500).json({ success: false, message: 'Failed to check vote' });
    }
};

// Reshare a post
export const resharePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const { comment, includeOriginal = true } = req.body;

        console.log('🔄 Reshare request:', { originalPostId: id, userId, comment, includeOriginal });

        // Check if user already reshared with the EXACT SAME comment
        if (comment) {
            const existingReshare = await executeQuery<any>(
                'SELECT id FROM nt_reshares WHERE cuserid = @userId AND original_post_id = @postId AND comment = @comment',
                { userId, postId: parseInt(id), comment }
            );

            if (existingReshare && existingReshare.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'You have already reshared this post with the same comment'
                });
            }
        }

        // Get original post
        const originalPost = await executeQuery<any>(
            'SELECT * FROM nt_posts WHERE id = @postId',
            { postId: parseInt(id) }
        );

        if (!originalPost || originalPost.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Original post not found'
            });
        }

        let resharedPostId = null;

        // Create reshare post record
        const reshareContent = comment
            ? comment
            : `Reshared a post by @${originalPost[0].username || 'user'}`;

        const result = await executeNonQuery(
            `INSERT INTO nt_posts (cuserid, content, type, media_urls, original_post_id, is_reshare, status, approval_status, created_at)
             VALUES (@userId, @content, @type, @mediaUrls, @postId, 1, 'approved', 'approved', GETDATE())`,
            {
                userId,
                content: reshareContent,
                type: originalPost[0].type,
                mediaUrls: includeOriginal ? originalPost[0].media_urls : '[]',
                postId: parseInt(id)
            }
        );

        resharedPostId = result.recordset?.[0]?.id || result.insertId;

        // Create reshare record
        await executeNonQuery(
            `INSERT INTO nt_reshares (cuserid, original_post_id, reshared_post_id, comment, include_original)
             VALUES (@userId, @postId, @resharedPostId, @comment, @includeOriginal)`,
            {
                userId,
                postId: parseInt(id),
                resharedPostId,
                comment,
                includeOriginal: includeOriginal ? 1 : 0
            }
        );

        // Update share count on original post
        await executeNonQuery(
            'UPDATE nt_posts SET shares_count = shares_count + 1 WHERE id = @postId',
            { postId: parseInt(id) }
        );

        // Get updated share count
        const updatedPost = await executeQuery<any>(
            'SELECT shares_count FROM nt_posts WHERE id = @postId',
            { postId: parseInt(id) }
        );

        // Get user info for the reshare
        const userInfo = await executeQuery<any>(
            'SELECT cuser_name as username, cuser_name as full_name, cprofile_image_name as avatar_url FROM users WHERE id = @userId',
            { userId }
        );

        const resharedPost = {
            id: resharedPostId,
            cuserid: userId,
            content: reshareContent,
            type: originalPost[0].type,
            mediaUrls: includeOriginal ? JSON.parse(originalPost[0].media_urls || '[]') : [],
            original_post_id: parseInt(id),
            is_reshare: true,
            created_at: new Date(),
            user: userInfo[0],
            original_post: {
                id: originalPost[0].id,
                content: originalPost[0].content,
                cuserid: originalPost[0].cuserid,
                username: originalPost[0].username,
                full_name: originalPost[0].full_name,
                mediaUrls: JSON.parse(originalPost[0].media_urls || '[]')
            }
        };

        // Emit socket event
        const io = req.app.get('io');
        if (io) {
            io.emit('post_reshared', {
                reshare: resharedPost,
                originalPostId: parseInt(id),
                userId: userId,
                shares_count: updatedPost[0]?.shares_count || 0
            });
            console.log(`📤 Emitted post_reshared for post ${id}`);
        }

        res.status(201).json({
            success: true,
            message: 'Post reshared successfully',
            shares_count: updatedPost[0]?.shares_count || 0,
            reshare: resharedPost
        });

    } catch (error) {
        console.error('Error resharing post:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reshare post'
        });
    }
};

// Remove reshare
export const unResharePost = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        console.log('🔁 Removing reshare:', { originalPostId: id, userId });

        // Get reshare record
        const reshares = await executeQuery<any>(
            'SELECT * FROM nt_reshares WHERE cuserid = @userId AND original_post_id = @postId',
            { userId, postId: parseInt(id) }
        );

        if (!reshares || reshares.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Reshare not found'
            });
        }

        const reshare = reshares[0];

        // Delete reshared post if it exists
        if (reshare.reshared_post_id) {
            await executeNonQuery(
                'DELETE FROM nt_posts WHERE id = @resharedPostId',
                { resharedPostId: reshare.reshared_post_id }
            );
        }

        // Delete reshare record
        await executeNonQuery(
            'DELETE FROM nt_reshares WHERE id = @reshareId',
            { reshareId: reshare.id }
        );

        // Update share count (decrement)
        await executeNonQuery(
            'UPDATE nt_posts SET shares_count = shares_count - 1 WHERE id = @postId',
            { postId: parseInt(id) }
        );

        // Get updated share count
        const updatedPost = await executeQuery<any>(
            'SELECT shares_count FROM nt_posts WHERE id = @postId',
            { postId: parseInt(id) }
        );

        // Emit socket event
        const io = req.app.get('io');
        if (io) {
            io.emit('post_unreshared', {
                originalPostId: parseInt(id),
                userId: userId,
                shares_count: updatedPost[0]?.shares_count || 0
            });
            console.log(`📤 Emitted post_unreshared for post ${id}`);
        }

        res.json({
            success: true,
            message: 'Reshare removed',
            shares_count: updatedPost[0]?.shares_count || 0
        });

    } catch (error) {
        console.error('Error removing reshare:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove reshare'
        });
    }
};

// Check if user has reshared a post
export const getReshareStatus = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const reshares = await executeQuery<any>(
            'SELECT id FROM nt_reshares WHERE cuserid = @userId AND original_post_id = @postId',
            { userId, postId: parseInt(id) }
        );

        res.json({
            success: true,
            isReshared: reshares && reshares.length > 0
        });

    } catch (error) {
        console.error('Error checking reshare status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check reshare status'
        });
    }
};

// Get reshared posts feed
export const getResharedFeed = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        const query = `
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
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;

        const posts = await executeQuery<any>(query, { userId, offset, limit });

        // Parse JSON fields for each post
        const postsWithMedia = posts.map(post => ({
            ...post,
            mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
            hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
            pollData: post.poll_data ? JSON.parse(post.poll_data || 'null') : null,
            userLiked: post.user_liked === 1 || post.user_liked === true,
            userReshared: post.user_reshared === 1 || post.user_reshared === true,
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
            posts: postsWithMedia,
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