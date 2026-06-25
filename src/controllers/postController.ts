import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { Request, Response } from 'express';
import { mysqlPool } from '../config/database';
import { ActivityLog } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import moment from 'moment-timezone';

const getIo = (req: AuthRequest) => {
    return req.app.get('io');
};

// Add this helper function at the top of the file
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
        return filePath; // Return original path if processing fails
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

        // IMPORTANT: Save post with created_at = NOW() and approved_at = NULL
        // approved_at will be set when admin approves the post
        const [result] = await mysqlPool.execute(
            `INSERT INTO nt_posts (
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
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'waiting', NOW(), NULL)`,
            [userId, content || null, type || 'text', JSON.stringify(mediaUrls), finalPollData, hashtags ? JSON.stringify(hashtags) : null]
        );

        const postId = (result as any).insertId;

        // Get user info for the post
        const [userRows] = await mysqlPool.execute(
            'SELECT cuser_name as username, cuser_name as full_name, cprofile_image_name as avatar_url FROM users WHERE id = ?',
            [userId]
        );
        const user = (userRows as any[])[0];

        // Get the created post with timestamps
        const [newPostRows] = await mysqlPool.execute(
            `SELECT 
                id, cuserid, content, type, media_urls, poll_data, hashtags,
                status, approval_status, likes_count, comments_count, shares_count,
                created_at, approved_at,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') as created_at_formatted
             FROM nt_posts 
             WHERE id = ?`,
            [postId]
        );

        const createdPost = (newPostRows as any[])[0];

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
            approved_at: null, // Not approved yet
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
        const tab = req.query.tab as string || 'for-you';

        const connection = await mysqlPool.getConnection();

        try {
            // Build WHERE clause
            let whereConditions: string[] = [
                "p.status = 'approved'",
                "p.approval_status = 'approved'",
                "(p.is_reshare = 0 OR p.is_reshare = 1)"
            ];

            let params: any[] = [];

            // Search filter
            if (search) {
                const searchPattern = `%${search}%`;
                whereConditions.push(`(
                    p.content LIKE ? 
                    OR u.username LIKE ? 
                    OR u.full_name LIKE ? 
                    OR p.hashtags LIKE ?
                )`);
                params.push(searchPattern, searchPattern, searchPattern, searchPattern);
            }

            // Filter type: saved posts
            if (filterType === 'saved') {
                whereConditions.push(`sp.id IS NOT NULL`);
            }

            // Filter type: my posts
            if (filterType === 'my-posts') {
                whereConditions.push(`p.cuserid = ?`);
                params.push(userId);
            }

            // Following tab
            if (tab === 'following') {
                // You need a followers table - adjust as needed
                // whereConditions.push(`EXISTS (SELECT 1 FROM followers WHERE follower_id = ? AND followed_id = p.cuserid)`);
                // params.push(userId);
            }

            const whereClause = whereConditions.join(' AND ');

            // Count query
            let countQuery = `
                SELECT COUNT(DISTINCT p.id) as total
                FROM nt_posts p
                JOIN users u ON p.cuserid = u.cuserid
                LEFT JOIN nt_saved_posts sp ON p.id = sp.post_id AND sp.cuserid = ?
            `;

            let countParams: any[] = [userId];

            if (search) {
                const searchPattern = `%${search}%`;
                countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
            }

            if (filterType === 'my-posts') {
                countParams.push(userId);
            }

            countQuery += ` WHERE ${whereClause}`;

            const [countResult] = await connection.query(countQuery, countParams);
            const total = (countResult as any[])[0]?.total || 0;

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

            // Main query params
            let queryParams: any[] = [
                userId, userId, userId, userId
            ];

            if (search) {
                const searchPattern = `%${search}%`;
                queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
            }

            if (filterType === 'my-posts') {
                queryParams.push(userId);
            }

            queryParams.push(limit, offset);

            const query = `
                        SELECT 
                            p.*, 
                            u.cuser_name, 
                            u.cuser_name as full_name, 
                            u.cprofile_image_name as avatar_url,
                            DATE_FORMAT(p.approved_at, '%Y-%m-%d %H:%i:%s') as approved_at_formatted,
                            DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') as created_at_formatted,
                            COUNT(DISTINCT r.id) as likes_count,
                            COUNT(DISTINCT c.id) as comments_count,
                            MAX(CASE WHEN ur.id IS NOT NULL THEN 1 ELSE 0 END) as user_liked,
                            MAX(CASE WHEN sp.id IS NOT NULL THEN 1 ELSE 0 END) as user_saved,
                            MAX(CASE WHEN res.id IS NOT NULL THEN 1 ELSE 0 END) as user_reshared,
                            (SELECT option_id FROM nt_poll_votes WHERE post_id = p.id AND cuserid = ?) as user_voted_option,
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
                        LEFT JOIN nt_reactions r ON p.id = r.post_id
                        LEFT JOIN nt_comments c ON p.id = c.post_id AND c.status = 'active'
                        LEFT JOIN nt_reactions ur ON p.id = ur.post_id AND ur.cuserid = ?
                        LEFT JOIN nt_saved_posts sp ON p.id = sp.post_id AND sp.cuserid = ?
                        LEFT JOIN nt_reshares res ON p.id = res.original_post_id AND res.cuserid = ?
                        LEFT JOIN nt_posts op ON p.original_post_id = op.id
                        LEFT JOIN users ou ON op.cuserid = ou.cuserid
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
                        LIMIT ? OFFSET ? 
                    `;

            const [posts] = await connection.query(query, queryParams);

            connection.release();

            const postsWithMedia = (posts as any[]).map(post => {
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
                    userLiked: post.user_liked === 1 || post.user_liked === true,
                    userReshared: post.user_reshared === 1 || post.user_reshared === true,
                    userVotedOption: post.user_voted_option !== null ? Number(post.user_voted_option) : null,
                    userSaved: post.user_saved === 1 || post.user_saved === true,
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

        } catch (err) {
            connection.release();
            throw err;
        }
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

        const connection = await mysqlPool.getConnection();

        try {
            const query = `
                    SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.avatar_url,
                    (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id AND cuserid = ${userId}) as user_liked
                    FROM nt_posts p
                    JOIN users u ON p.cuserid = u.id
                    WHERE p.id = ${id}
                `;

            const [posts] = await connection.query(query);
            connection.release();

            const post = (posts as any[])[0];

            if (!post) {
                return res.status(404).json({ success: false, message: 'Post not found' });
            }

            // Parse JSON fields
            post.mediaUrls = post.media_urls ? JSON.parse(post.media_urls) : [];
            post.hashtags = post.hashtags ? JSON.parse(post.hashtags) : [];
            post.pollData = post.poll_data ? JSON.parse(post.poll_data) : null;
            post.userLiked = post.user_liked === 1 || post.user_liked === true;

            // Get likes and comments counts
            const [likesResult] = await mysqlPool.execute(
                'SELECT COUNT(*) as count FROM nt_reactions WHERE post_id = ?',
                [post.id]
            );
            const [commentsResult] = await mysqlPool.execute(
                'SELECT COUNT(*) as count FROM nt_comments WHERE post_id = ?',
                [post.id]
            );

            post.likes_count = (likesResult as any[])[0]?.count || 0;
            post.comments_count = (commentsResult as any[])[0]?.count || 0;

            res.json({ success: true, post });
        } catch (err) {
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error getting post:', error);
        res.status(500).json({ success: false, message: 'Error fetching post' });
    }
};

export const updatePost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { content, mediaUrls } = req.body;
    const userId = req.user!.id;

    const [result] = await mysqlPool.execute(
        'UPDATE nt_posts SET content = ?, media_urls = ? WHERE id = ? AND cuserid = ?',
        [content, mediaUrls ? JSON.stringify(mediaUrls) : null, id, userId]
    );

    if ((result as any).affectedRows === 0) {
        throw new AppError('Post not found or unauthorized', 404);
    }

    res.json({ success: true, message: 'Post updated successfully' });
};

export const deletePost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;
    const userRole = req.user!.role;

    let query = 'DELETE FROM nt_posts WHERE id = ? AND cuserid = ?';
    let params = [id, userId];

    if (userRole === 'admin') {
        query = 'DELETE FROM nt_posts WHERE id = ?';
        params = [id];
    }

    const [result] = await mysqlPool.execute(query, params);

    if ((result as any).affectedRows === 0) {
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
        console.log('📊 Page:', page, 'Limit:', limit, 'Offset:', offset);

        const connection = await mysqlPool.getConnection();

        try {
            // Get comments with user details - no formatting in SQL
            const query = `
                SELECT 
                    c.*, 
                    u.cuser_name as username, 
                    u.cuser_name as full_name, 
                    u.cprofile_image_name as avatar_url
                FROM nt_comments c
                JOIN users u ON c.cuserid = u.cuserid
                WHERE c.post_id = ? AND c.status = 'active'
                ORDER BY c.created_at DESC
                LIMIT ? OFFSET ?
            `;

            console.log('📝 Executing comments query');
            const [comments] = await connection.query(query, [id, limit, offset]);
            connection.release();

            console.log("Raw comments from DB:", comments);

            // Format date to IST using moment-timezone
            const formatDateToIST = (date: any) => {
                if (!date) return null;
                // Parse the date and convert to IST
                return moment(date).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss');
            };

            // Check if user liked each comment and format dates
            const commentsWithLikes = await Promise.all((comments as any[]).map(async (comment) => {
                const [liked] = await mysqlPool.execute(
                    'SELECT id FROM nt_reactions WHERE cuserid = ? AND comment_id = ?',
                    [userId, comment.id]
                );

                // Format both created_at and updated_at
                const formattedCreatedAt = formatDateToIST(comment.created_at);
                const formattedUpdatedAt = formatDateToIST(comment.updated_at);

                console.log(`Comment ${comment.id} - Original: ${comment.created_at}, Formatted: ${formattedCreatedAt}`);

                return {
                    ...comment,
                    userLiked: (liked as any[]).length > 0,
                    likesCount: comment.likes_count || 0,
                    created_at: formattedCreatedAt,
                    updated_at: formattedUpdatedAt
                };
            }));

            res.json({
                success: true,
                comments: commentsWithLikes,
                page: Number(page),
                limit: Number(limit)
            });
        } catch (err) {
            connection.release();
            throw err;
        }
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
        const [result] = await mysqlPool.execute(
            `INSERT INTO nt_comments (post_id, cuserid, parent_comment_id, content, status) 
                VALUES (?, ?, ?, ?, 'active')`,
            [postId, userId, parentCommentId || null, content]
        );

        const commentId = (result as any).insertId;

        // Get the comment with user details
        const [comments] = await mysqlPool.execute(
            `SELECT c.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url 
                FROM nt_comments c 
                JOIN users u ON c.cuserid = u.id 
                WHERE c.id = ?`,
            [commentId]
        );

        const comment = (comments as any[])[0];

        // Update post comments count
        await mysqlPool.execute(
            'UPDATE nt_posts SET comments_count = comments_count WHERE id = ?',
            [postId]
        );

        // Get updated count
        const [countResult] = await mysqlPool.execute(
            'SELECT comments_count FROM nt_posts WHERE id = ?',
            [postId]
        );
        const newCommentsCount = (countResult as any[])[0]?.comments_count || 0;

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

            // Emit to all clients in the room
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

    const [comment] = await mysqlPool.execute(
        'SELECT post_id FROM nt_comments WHERE id = ? AND cuserid = ?',
        [id, userId]
    );

    if ((comment as any[]).length === 0) {
        throw new AppError('Comment not found or unauthorized', 404);
    }

    const postId = (comment as any[])[0].post_id;

    await mysqlPool.execute('UPDATE nt_comments SET status = "deleted" WHERE id = ?', [id]);
    await mysqlPool.execute('UPDATE nt_posts SET comments_count = comments_count - 1 WHERE id = ?', [postId]);

    res.json({ success: true, message: 'Comment deleted successfully' });
};

export const addReaction = async (req: AuthRequest, res: Response) => {
    try {
        const { postId } = req.body;
        const userId = req.user.id;

        console.log('❤️ Toggling like for post:', postId, 'User:', userId);

        // Check if already liked
        const [existing] = await mysqlPool.execute(
            'SELECT id FROM nt_reactions WHERE cuserid = ? AND post_id = ?',
            [userId, postId]
        );

        let isLiked = false;
        let likesCount = 0;

        if ((existing as any[]).length > 0) {
            // Unlike
            await mysqlPool.execute(
                'DELETE FROM nt_reactions WHERE cuserid = ? AND post_id = ?',
                [userId, postId]
            );
            await mysqlPool.execute(
                'UPDATE nt_posts SET likes_count = likes_count - 1 WHERE id = ?',
                [postId]
            );
            isLiked = false;
        } else {
            // Like
            await mysqlPool.execute(
                'INSERT INTO nt_reactions (cuserid, post_id, type) VALUES (?, ?, "like")',
                [userId, postId]
            );
            await mysqlPool.execute(
                'UPDATE nt_posts SET likes_count = likes_count + 1 WHERE id = ?',
                [postId]
            );
            isLiked = true;
        }

        // Get updated likes count
        const [count] = await mysqlPool.execute(
            'SELECT likes_count FROM nt_posts WHERE id = ?',
            [postId]
        );
        likesCount = (count as any[])[0]?.likes_count || 0;

        console.log(`📊 Updated likes count for post ${postId}: ${likesCount}`);

        // EMIT SOCKET EVENT FOR REAL-TIME UPDATE
        const io = req.app.get('io');
        if (io) {
            const eventData = {
                postId: postId,
                count: likesCount,  // Use 'count' to match frontend expectation
                likesCount: likesCount,
                userId: userId,
                isLiked: isLiked
            };
            io.to(`post_${postId}`).emit('reaction_updated', eventData);

            io.emit('reaction_updated_global', eventData);
            console.log(`📤 Emitted reaction_updated for post ${postId}:`, eventData);

            const room = io.sockets.adapter.rooms.get(`post_${postId}`);
            const roomSize = room ? room.size : 0;
            console.log(`📊 Room post_${postId} size: ${roomSize} users`);
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
        const [commentExists] = await mysqlPool.execute(
            'SELECT id FROM nt_comments WHERE id = ?',
            [commentId]
        );

        if ((commentExists as any[]).length === 0) {
            return res.status(404).json({ success: false, message: 'Comment not found' });
        }

        // Check if already liked this comment
        const [existing] = await mysqlPool.execute(
            'SELECT id FROM nt_reactions WHERE cuserid = ? AND comment_id = ?',
            [userId, commentId]
        );

        if ((existing as any[]).length > 0) {
            // Unlike - remove reaction
            await mysqlPool.execute(
                'DELETE FROM nt_reactions WHERE cuserid = ? AND comment_id = ?',
                [userId, commentId]
            );
            await mysqlPool.execute(
                'UPDATE nt_comments SET likes_count = likes_count - 1 WHERE id = ?',
                [commentId]
            );
            console.log('👎 Comment unliked');
        } else {
            // Like - add reaction
            await mysqlPool.execute(
                'INSERT INTO nt_reactions (cuserid, comment_id, type) VALUES (?, ?, "like")',
                [userId, commentId]
            );
            await mysqlPool.execute(
                'UPDATE nt_comments SET likes_count = likes_count + 1 WHERE id = ?',
                [commentId]
            );
            console.log('👍 Comment liked');
        }

        // Get updated likes count
        const [count] = await mysqlPool.execute(
            'SELECT likes_count FROM nt_comments WHERE id = ?',
            [commentId]
        );
        const likesCount = (count as any[])[0]?.likes_count || 0;

        res.json({
            success: true,
            likes_count: likesCount,
            isLiked: (existing as any[]).length === 0
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
        const [existing] = await mysqlPool.execute(
            'SELECT id FROM nt_reactions WHERE cuserid = ? AND comment_id = ?',
            [userId, commentId]
        );

        if ((existing as any[]).length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Reaction not found'
            });
        }

        // Delete the reaction
        await mysqlPool.execute(
            'DELETE FROM nt_reactions WHERE cuserid = ? AND comment_id = ?',
            [userId, commentId]
        );

        // Update comment likes count
        await mysqlPool.execute(
            'UPDATE nt_comments SET likes_count = likes_count - 1 WHERE id = ?',
            [commentId]
        );

        // Get updated likes count
        const [count] = await mysqlPool.execute(
            'SELECT likes_count FROM nt_comments WHERE id = ?',
            [commentId]
        );
        const likesCount = (count as any[])[0]?.likes_count || 0;

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

    const [reaction] = await mysqlPool.execute(
        'SELECT post_id FROM nt_reactions WHERE id = ? AND cuserid = ?',
        [id, userId]
    );

    if ((reaction as any[]).length === 0) {
        throw new AppError('Reaction not found', 404);
    }

    const postId = (reaction as any[])[0].post_id;

    await mysqlPool.execute('DELETE FROM nt_reactions WHERE id = ?', [id]);
    await mysqlPool.execute('UPDATE nt_posts SET likes_count = likes_count - 1 WHERE id = ?', [postId]);

    res.json({ success: true, message: 'Reaction removed' });
};

export const getReactions = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    const [reactions] = await mysqlPool.execute(
        `SELECT r.type, COUNT(*) as count 
        FROM nt_reactions r
        WHERE r.post_id = ?
        GROUP BY r.type`,
        [id]
    );

    res.json({ success: true, reactions });
};

export const sharePost = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    await mysqlPool.execute(
        'UPDATE nt_posts SET shares_count = shares_count + 1 WHERE id = ?',
        [id]
    );

    res.json({ success: true, message: 'Post shared' });
};

export const getFeed = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        const connection = await mysqlPool.getConnection();

        try {
            const query = `
                SELECT 
                    p.id, p.cuserid, p.content, p.type, p.media_urls, p.hashtags, p.poll_data,
                    p.status, p.approval_status, p.likes_count, p.comments_count, p.shares_count,
                    p.created_at, p.updated_at, p.original_post_id, p.is_reshare,
                    p.approved_at, p.approved_by,
                    DATE_FORMAT(p.approved_at, '%Y-%m-%d %H:%i:%s') as approved_at_formatted,
                    u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url,
                    (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id AND cuserid = ${userId}) as user_liked,
                    (SELECT COUNT(*) FROM nt_reshares WHERE original_post_id = p.id AND cuserid = ${userId}) as user_reshared,
                    (SELECT option_id FROM nt_poll_votes WHERE post_id = p.id AND cuserid = ${userId}) as user_voted_option,
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
                LIMIT ${limit} OFFSET ${offset}
            `;

            const [posts] = await connection.query(query);
            connection.release();

            // Parse JSON fields for each post
            const postsWithMedia = (posts as any[]).map(post => ({
                ...post,
                mediaUrls: post.media_urls ? JSON.parse(post.media_urls) : [],
                hashtags: post.hashtags ? JSON.parse(post.hashtags) : [],
                pollData: post.poll_data ? JSON.parse(post.poll_data || 'null') : null,
                userLiked: post.user_liked === 1 || post.user_liked === true,
                userReshared: post.user_reshared === 1 || post.user_reshared === true,
                userVotedOption: post.user_voted_option !== null ? Number(post.user_voted_option) : null,
                // Use approved_at or created_at for display
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
        } catch (err) {
            connection.release();
            throw err;
        }
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
        const [existing]: any = await mysqlPool.execute(
            'SELECT id FROM nt_saved_posts WHERE cuserid = ? AND post_id = ?',
            [userId, id]
        );

        if (existing && existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Post already saved'
            });
        }

        await mysqlPool.execute(
            'INSERT INTO nt_saved_posts (cuserid, post_id) VALUES (?, ?)',
            [userId, id]
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

    await mysqlPool.execute(
        'DELETE FROM nt_saved_posts WHERE cuserid = ? AND post_id = ?',
        [userId, id]
    );

    res.json({ success: true, message: 'Post unsaved' });
};

export const getSavedPosts = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        const connection = await mysqlPool.getConnection();

        try {
            const query = `
                    SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url
                    FROM nt_saved_posts sp
                    JOIN nt_posts p ON sp.post_id = p.id
                    JOIN users u ON p.cuserid = u.id
                    WHERE sp.cuserid = ${userId}
                    ORDER BY sp.created_at DESC
                    LIMIT ${limit} OFFSET ${offset}
                `;

            const [posts] = await connection.query(query);
            connection.release();

            // Parse JSON fields
            const postsWithMedia = (posts as any[]).map(post => ({
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
        } catch (err) {
            connection.release();
            throw err;
        }
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

    await mysqlPool.execute(
        'INSERT INTO nt_reports (post_id, cuserid, reason, description) VALUES (?, ?, ?, ?)',
        [id, userId, reason, description]
    );

    res.json({ success: true, message: 'Post reported' });
};

export const getTrendingHashtags = async (req: AuthRequest, res: Response) => {
    const { period = 'day' } = req.query;

    try {
        const connection = await mysqlPool.getConnection();

        try {
            const query = `
                    SELECT 
                        h.name,
                        COUNT(DISTINCT ph.post_id) as post_count
                    FROM nt_hashtags h
                    LEFT JOIN nt_post_hashtags ph ON h.id = ph.hashtag_id
                    LEFT JOIN nt_posts p ON ph.post_id = p.id
                    WHERE p.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
                        OR p.created_at IS NULL
                    GROUP BY h.id
                    ORDER BY post_count DESC
                    LIMIT 10
                `;

            const [trending] = await connection.query(query);
            connection.release();

            res.json({
                success: true,
                trending: trending || [],
                period
            });
        } catch (err) {
            connection.release();
            throw err;
        }
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
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    try {
        const [posts] = await mysqlPool.execute(
            `SELECT p.*, u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url
                FROM nt_posts p
                JOIN users u ON p.cuserid = u.id
                WHERE p.status = 'approved'
                ORDER BY p.created_at DESC
                LIMIT ? OFFSET ?`,
            [Number(limit), offset]
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

        // Get the post with poll data
        const [posts] = await mysqlPool.execute(
            'SELECT * FROM nt_posts WHERE id = ? AND type = "poll"',
            [id]
        );

        const post = (posts as any[])[0];

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
        const [existingVote] = await mysqlPool.execute(
            'SELECT id, option_id FROM nt_poll_votes WHERE post_id = ? AND cuserid = ?',
            [id, userId]
        );

        let isNewVote = false;
        let voteChanged = false;

        if ((existingVote as any[]).length > 0) {
            const previousOptionId = (existingVote as any[])[0].option_id;

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
            await mysqlPool.execute(
                'UPDATE nt_poll_votes SET option_id = ? WHERE post_id = ? AND cuserid = ?',
                [numericOptionId, id, userId]
            );
        } else {
            // First time voting
            console.log('First time voting for user');
            await mysqlPool.execute(
                'INSERT INTO nt_poll_votes (post_id, cuserid, option_id) VALUES (?, ?, ?)',
                [id, userId, numericOptionId]
            );
            isNewVote = true;
        }

        // Add vote to selected option (if not same option vote)
        if (isNewVote || voteChanged) {
            pollData.options[optionIndex].votes = (pollData.options[optionIndex].votes || 0) + 1;
        }

        // CRITICAL FIX: Recalculate totalVotes from ALL options in the database
        // Get all votes from poll_votes table for this post
        const [allVotes] = await mysqlPool.execute(
            'SELECT COUNT(*) as total FROM nt_poll_votes WHERE post_id = ?',
            [id]
        );
        const actualTotalVotes = (allVotes as any[])[0]?.total || 0;

        // Also calculate from options to verify
        let calculatedFromOptions = 0;
        for (const opt of pollData.options) {
            calculatedFromOptions += (opt.votes || 0);
        }

        // Use the actual database count as source of truth
        pollData.totalVotes = actualTotalVotes;

        console.log('Vote count verification:', {
            actualFromDatabase: actualTotalVotes,
            calculatedFromOptions: calculatedFromOptions,
            pollDataTotalVotes: pollData.totalVotes,
            isNewVote,
            voteChanged
        });

        // Save updated poll data
        await mysqlPool.execute(
            'UPDATE nt_posts SET poll_data = ? WHERE id = ?',
            [JSON.stringify(pollData), id]
        );

        // Get final user vote
        const [finalVote] = await mysqlPool.execute(
            'SELECT option_id FROM nt_poll_votes WHERE post_id = ? AND cuserid = ?',
            [id, userId]
        );
        const userVotedOption = (finalVote as any[])[0]?.option_id;

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

        const [vote] = await mysqlPool.execute(
            'SELECT option_id FROM nt_poll_votes WHERE post_id = ? AND cuserid = ?',
            [id, userId]
        );

        const votedOptionId = (vote as any[])[0]?.option_id || null;

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
        const { id } = req.params; // original post id
        const userId = req.user!.id;
        const { comment, includeOriginal = true } = req.body;

        console.log('🔄 Reshare request:', { originalPostId: id, userId, comment, includeOriginal });

        // Optional: Check if user already reshared with the EXACT SAME comment
        if (comment) {
            const [existingReshare] = await mysqlPool.execute<RowDataPacket[]>(
                'SELECT id FROM nt_reshares WHERE cuserid = ? AND original_post_id = ? AND comment = ?',
                [userId, id, comment]
            );

            if (existingReshare.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'You have already reshared this post with the same comment'
                });
            }
        }

        // Get original post
        const [originalPost] = await mysqlPool.execute<RowDataPacket[]>(
            'SELECT * FROM nt_posts WHERE id = ?',
            [id]
        );

        if (originalPost.length === 0) {
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

        const [insertResult] = await mysqlPool.execute<ResultSetHeader>(
            `INSERT INTO nt_posts (cuserid, content, type, media_urls, original_post_id, is_reshare, status, approval_status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'approved', 'approved', NOW())`,
            [
                userId,
                reshareContent,
                originalPost[0].type,
                includeOriginal ? originalPost[0].media_urls : '[]',
                id,
                true
            ]
        );

        resharedPostId = insertResult.insertId;

        // Create reshare record (allow multiple entries)
        await mysqlPool.execute(
            `INSERT INTO nt_reshares (cuserid, original_post_id, reshared_post_id, comment, include_original)
                VALUES (?, ?, ?, ?, ?)`,
            [userId, id, resharedPostId, comment, includeOriginal]
        );

        // Update share count on original post
        await mysqlPool.execute(
            'UPDATE nt_posts SET shares_count = shares_count + 1 WHERE id = ?',
            [id]
        );

        // Get updated share count
        const [updatedPost] = await mysqlPool.execute<RowDataPacket[]>(
            'SELECT shares_count FROM nt_posts WHERE id = ?',
            [id]
        );

        // Get user info for the reshare
        const [userInfo] = await mysqlPool.execute<RowDataPacket[]>(
            'SELECT cuser_name as username, cuser_name as full_name, cprofile_image_name as avatar_url FROM users WHERE id = ?',
            [userId]
        );

        const resharedPost = {
            id: resharedPostId,
            cuserid: userId,
            content: reshareContent,
            type: originalPost[0].type,
            mediaUrls: includeOriginal ? JSON.parse(originalPost[0].media_urls || '[]') : [],
            original_post_id: id,
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
        const { id } = req.params; // original post id
        const userId = req.user!.id;

        console.log('🔁 Removing reshare:', { originalPostId: id, userId });

        // Get reshare record
        const [reshares] = await mysqlPool.execute<RowDataPacket[]>(
            'SELECT * FROM nt_reshares WHERE cuserid = ? AND original_post_id = ?',
            [userId, id]
        );

        if (reshares.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Reshare not found'
            });
        }

        const reshare = reshares[0];

        // Delete reshared post if it exists
        if (reshare.reshared_post_id) {
            await mysqlPool.execute(
                'DELETE FROM nt_posts WHERE id = ?',
                [reshare.reshared_post_id]
            );
        }

        // Delete reshare record
        await mysqlPool.execute(
            'DELETE FROM nt_reshares WHERE id = ?',
            [reshare.id]
        );

        // Update share count (decrement)
        await mysqlPool.execute(
            'UPDATE nt_posts SET shares_count = shares_count - 1 WHERE id = ?',
            [id]
        );

        // Get updated share count
        const [updatedPost] = await mysqlPool.execute<RowDataPacket[]>(
            'SELECT shares_count FROM nt_posts WHERE id = ?',
            [id]
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

        const [reshares] = await mysqlPool.execute<RowDataPacket[]>(
            'SELECT id FROM nt_reshares WHERE cuserid = ? AND original_post_id = ?',
            [userId, id]
        );

        res.json({
            success: true,
            isReshared: reshares.length > 0
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

        const connection = await mysqlPool.getConnection();

        try {
            const query = `
                    SELECT 
                        p.id, p.cuserid, p.content, p.type, p.media_urls, p.hashtags, p.poll_data,
                        p.status, p.approval_status, p.likes_count, p.comments_count, p.shares_count,
                        p.created_at, p.updated_at, p.original_post_id, p.is_reshare,
                        u.cuser_name as username, u.cuser_name as full_name, u.cprofile_image_name as avatar_url,
                        (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id AND cuserid = ${userId}) as user_liked,
                        (SELECT COUNT(*) FROM nt_reshares WHERE original_post_id = p.id AND cuserid = ${userId}) as user_reshared,
                        op.id as original_id, op.content as original_content, op.cuserid as original_user_id,
                        ou.cuser_name as original_username, ou.cuser_name as original_full_name,
                        ou.cprofile_image_name as original_avatar_url, op.media_urls as original_media_urls
                    FROM nt_posts p
                    INNER JOIN users u ON p.cuserid = u.id
                    LEFT JOIN nt_posts op ON p.original_post_id = op.id
                    LEFT JOIN users ou ON op.cuserid = ou.id
                    WHERE p.status = 'approved' 
                        AND p.approval_status = 'approved'
                        AND (p.is_reshare = TRUE OR p.original_post_id IS NOT NULL)
                    ORDER BY p.created_at DESC
                    LIMIT ${limit} OFFSET ${offset}
                `;

            const [posts] = await connection.query(query);
            connection.release();

            // Parse JSON fields for each post
            const postsWithMedia = (posts as any[]).map(post => ({
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

        } catch (err) {
            connection.release();
            throw err;
        }

    } catch (error) {
        console.error('Error getting reshared feed:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching reshared feed',
            posts: []
        });
    }
};