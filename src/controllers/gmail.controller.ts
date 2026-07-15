// backend/src/controllers/gmail.controller.ts
import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { gmailService } from '../services/gmail.service';
import { executeNonQuery, executeQuery } from '../config/database';

// ==============================================
// IN-MEMORY CACHE
// ==============================================
const emailCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ==============================================
// HELPER FUNCTIONS
// ==============================================

async function getUserFromToken(req: AuthRequest) {
    const user: any = req.user;
    if (!user) {
        throw new Error('User not authenticated');
    }

    return {
        cuserid: parseInt(user.sub || user.cuserid || user.id),
        email: user.email,
        username: user.username,
        fullName: user.FullName
    };
}

async function getGmailTokens(cuserid: number) {
    const result = await executeQuery<any>(
        `SELECT access_token, refresh_token, expires_at 
         FROM nt_user_gmail_tokens 
         WHERE cuserid = @cuserid AND is_active = 1`,
        { cuserid }
    );

    if (!result || result.length === 0) {
        return null;
    }

    return {
        access_token: result[0].access_token,
        refresh_token: result[0].refresh_token,
        expiry_date: result[0].expires_at ? new Date(result[0].expires_at).getTime() : undefined
    };
}

async function saveEmailToDatabase(cuserid: number, email: any) {
    try {
        const existing = await executeQuery<any>(
            'SELECT id FROM nt_user_emails WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { gmailId: email.id, cuserid }
        );

        const emailData = {
            gmailId: email.id,
            cuserid,
            fromName: email.from?.name || email.from?.email || '',
            fromEmail: email.from?.email || '',
            toEmails: JSON.stringify(email.to || []),
            ccEmails: JSON.stringify(email.cc || []),
            bccEmails: JSON.stringify(email.bcc || []),
            subject: email.subject || '(No Subject)',
            snippet: email.snippet || '',
            body: email.body || '',
            isRead: email.isRead ? 1 : 0,
            isStarred: email.isStarred ? 1 : 0,
            folder: getFolderFromLabels(email.labels),
            labels: JSON.stringify(email.labels || []),
            hasAttachments: email.hasAttachments ? 1 : 0,
            attachments: JSON.stringify(email.attachments || []),
            threadId: email.threadId || null,
            date: email.date || new Date()
        };

        if (existing && existing.length > 0) {
            await executeNonQuery(
                `UPDATE nt_user_emails SET
                    from_name = @fromName,
                    from_email = @fromEmail,
                    to_emails = @toEmails,
                    cc_emails = @ccEmails,
                    bcc_emails = @bccEmails,
                    subject = @subject,
                    snippet = @snippet,
                    body = @body,
                    is_read = @isRead,
                    is_starred = @isStarred,
                    folder = @folder,
                    labels = @labels,
                    has_attachments = @hasAttachments,
                    attachments = @attachments,
                    thread_id = @threadId,
                    updated_at = GETDATE()
                WHERE gmail_id = @gmailId AND cuserid = @cuserid`,
                emailData
            );
        } else {
            await executeNonQuery(
                `INSERT INTO nt_user_emails (
                    gmail_id, cuserid, from_name, from_email, to_emails, cc_emails, bcc_emails,
                    subject, snippet, body, is_read, is_starred, folder, labels,
                    has_attachments, attachments, thread_id, date, created_at, updated_at
                ) VALUES (
                    @gmailId, @cuserid, @fromName, @fromEmail, @toEmails, @ccEmails, @bccEmails,
                    @subject, @snippet, @body, @isRead, @isStarred, @folder, @labels,
                    @hasAttachments, @attachments, @threadId, @date, GETDATE(), GETDATE()
                )`,
                emailData
            );
        }
    } catch (error) {
        console.error('Error saving email to database:', error);
    }
}

function getFolderFromLabels(labels: string[]): string {
    if (!labels) return 'inbox';
    if (labels.includes('SENT')) return 'sent';
    if (labels.includes('DRAFT')) return 'drafts';
    if (labels.includes('TRASH')) return 'trash';
    if (labels.includes('SPAM')) return 'spam';
    if (labels.includes('INBOX')) return 'inbox';
    return 'inbox';
}

function getLabelMap(): Record<string, string> {
    return {
        'inbox': 'INBOX',
        'sent': 'SENT',
        'drafts': 'DRAFT',
        'trash': 'TRASH',
        'spam': 'SPAM'
    };
}

export const clearEmailCache = (cuserid: number) => {
    const keysToDelete: string[] = [];
    for (const key of emailCache.keys()) {
        if (key.startsWith(`${cuserid}_`)) {
            keysToDelete.push(key);
        }
    }
    for (const key of keysToDelete) {
        emailCache.delete(key);
    }
    console.log(`Cleared ${keysToDelete.length} cache entries for user ${cuserid}`);
};

// ==============================================
// AUTH HANDLERS
// ==============================================

export const handleGmailAuth = async (req: Request, res: Response) => {
    try {
        const { cuserid, force, prompt } = req.query;

        console.log('Gmail Auth Request:', { cuserid, force, prompt });

        if (!cuserid) {
            return res.status(400).json({
                success: false,
                message: 'cuserid is required'
            });
        }

        if (isNaN(Number(cuserid))) {
            return res.status(400).json({
                success: false,
                message: 'cuserid must be a valid number',
                received: { cuserid }
            });
        }

        // Get auth URL with proper parameters
        const authUrl = gmailService.getAuthUrl(
            cuserid.toString(),
            force === 'true',
            prompt === 'consent'
        );

        console.log(`User ${cuserid} starting Gmail auth (force: ${force}, prompt: ${prompt})`);

        res.redirect(authUrl);
    } catch (error) {
        console.error('Error initiating Gmail auth:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initiate Gmail authentication'
        });
    }
};

export const handleGmailCallback = async (req: Request, res: Response) => {
    try {
        const { code, state } = req.query;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: 'Authorization code is required'
            });
        }

        console.log('Callback received with state:', state);

        let cuserid: string;

        if (state) {
            try {
                const decoded = Buffer.from(state as string, 'base64').toString();
                const stateObj = JSON.parse(decoded);
                cuserid = stateObj.cuserid;
                console.log('Decoded state from base64:', { cuserid });
            } catch (error) {
                console.error('Error decoding state:', error);
                return res.status(400).json({
                    success: false,
                    message: 'Invalid state parameter'
                });
            }
        } else {
            return res.status(400).json({
                success: false,
                message: 'State parameter is required'
            });
        }

        if (!cuserid) {
            console.error('Invalid user data:', { cuserid });
            return res.status(400).json({
                success: false,
                message: 'Invalid user data in state'
            });
        }

        console.log(`Callback received for user ${cuserid}`);

        const tokens = await gmailService.getTokens(code as string);

        gmailService.setUserCredentials(tokens);
        const profile = await gmailService.getUserProfile();
        const userEmail = profile.emailAddress;

        console.log(`User ${cuserid} connected Gmail: ${userEmail}`);

        const cuseridNum = parseInt(cuserid as string);

        const existingToken = await executeQuery<any>(
            'SELECT id FROM nt_user_gmail_tokens WHERE cuserid = @cuserid',
            { cuserid: cuseridNum }
        );

        if (existingToken && existingToken.length > 0) {
            await executeNonQuery(
                `UPDATE nt_user_gmail_tokens 
                 SET email = @email, 
                     access_token = @accessToken, 
                     refresh_token = @refreshToken, 
                     expires_at = @expiresAt, 
                     is_active = 1, 
                     updated_at = GETDATE() 
                 WHERE cuserid = @cuserid`,
                {
                    cuserid: cuseridNum,
                    email: userEmail,
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
                }
            );
            console.log('Token updated for user:', cuserid);
        } else {
            await executeNonQuery(
                `INSERT INTO nt_user_gmail_tokens (cuserid, email, access_token, refresh_token, expires_at, created_at, updated_at)
                 VALUES (@cuserid, @email, @accessToken, @refreshToken, @expiresAt, GETDATE(), GETDATE())`,
                {
                    cuserid: cuseridNum,
                    email: userEmail,
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
                }
            );
            console.log('New token inserted for user:', cuserid);
        }

        res.redirect(`http://localhost:4200/#/user/email?gmail=connected`);

    } catch (error) {
        console.error('Error handling Gmail callback:', error);
        res.redirect(`http://localhost:4200/#/user/email?gmail=error&message=${encodeURIComponent(error.message)}`);
    }
};

// ==============================================
// GET EMAILS
// ==============================================
export const getGmailEmails = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const folder = req.query.folder as string || 'inbox';
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
        const offset = (page - 1) * limit;

        console.log(`Fetching emails for user ${user.cuserid} - folder: ${folder}, page: ${page}, limit: ${limit}`);

        // Get total count first (fast with index)
        const countResult = await executeQuery<any>(
            'SELECT COUNT(*) as total FROM nt_user_emails WHERE cuserid = @cuserid AND folder = @folder',
            { cuserid: user.cuserid, folder: folder }
        );

        // IMPORTANT: Make sure total is a number
        const totalFromDb = countResult && countResult.length > 0 ? Number(countResult[0]?.total || 0) : 0;

        console.log(`Total emails in DB for folder ${folder}: ${totalFromDb}`);

        // If no emails in DB, trigger sync and return empty with loading flag
        if (totalFromDb === 0) {
            console.log('No emails in DB, triggering background sync...');

            // Start background sync
            setImmediate(() => {
                syncEmailsInBackground(user.cuserid, folder).catch(err =>
                    console.error('Background sync error:', err)
                );
            });

            return res.json({
                success: true,
                emails: [],
                page: page,
                limit: limit,
                total: 0,
                hasMore: false,
                fromCache: false,
                loading: true,
                message: 'Loading emails...'
            });
        }

        // Get paginated emails with optimized query
        const cachedEmails = await executeQuery<any>(
            `SELECT * FROM nt_user_emails 
             WHERE cuserid = @cuserid AND folder = @folder
             ORDER BY date DESC
             OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
            {
                cuserid: user.cuserid,
                folder: folder,
                offset: offset,
                limit: limit
            }
        );

        // Parse emails
        const parsedEmails = cachedEmails.map(email => ({
            id: email.gmail_id,
            threadId: email.thread_id,
            from: { name: email.from_name, email: email.from_email },
            to: JSON.parse(email.to_emails || '[]'),
            cc: JSON.parse(email.cc_emails || '[]'),
            bcc: JSON.parse(email.bcc_emails || '[]'),
            subject: email.subject,
            snippet: email.snippet,
            body: email.body,
            isRead: email.is_read === 1,
            isStarred: email.is_starred === 1,
            hasAttachments: email.has_attachments === 1,
            attachments: JSON.parse(email.attachments || '[]'),
            labels: JSON.parse(email.labels || '[]'),
            date: email.date,
            createdAt: email.created_at
        }));

        // Check if we need to sync in background
        if (totalFromDb < 50) {
            setImmediate(() => {
                syncEmailsInBackground(user.cuserid, folder).catch(err =>
                    console.error('Background sync error:', err)
                );
            });
        }

        // Calculate if there are more pages
        const totalPages = Math.ceil(totalFromDb / limit);
        const hasMore = page < totalPages;

        console.log(`Returning ${parsedEmails.length} emails, total: ${totalFromDb}, hasMore: ${hasMore}`);

        res.json({
            success: true,
            emails: parsedEmails,
            page: page,
            limit: limit,
            total: totalFromDb, // This should be the actual total count
            totalPages: totalPages,
            hasMore: hasMore,
            fromCache: true,
            count: parsedEmails.length
        });

    } catch (error) {
        console.error('Error fetching Gmail emails:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch emails',
            emails: [],
            total: 0,
            hasMore: false
        });
    }
};

export const syncAllGmailEmails = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const maxResults = parseInt(req.query.maxResults as string) || 500;

        console.log(`Starting full sync for user ${user.cuserid} with max ${maxResults} emails`);

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);

        // Sync all folders
        const folders = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM'];
        let totalSynced = 0;
        const folderResults: Record<string, number> = {};

        // Emit progress via socket if available
        const io = req.app.get('io');

        for (const folder of folders) {
            console.log(`Syncing folder: ${folder}`);

            // Emit progress
            if (io) {
                io.to(`user_${user.cuserid}`).emit('sync_progress', {
                    folder: folder,
                    current: totalSynced,
                    total: maxResults * folders.length,
                    status: 'syncing'
                });
            }

            try {
                const result = await gmailService.getEmailsOptimized(
                    user.cuserid.toString(),
                    undefined,
                    Math.min(maxResults, 500), // Limit per folder to 500
                    [folder],
                    undefined
                );

                let folderCount = 0;
                for (const email of result.emails) {
                    await saveEmailToDatabase(user.cuserid, email);
                    folderCount++;
                    totalSynced++;
                }

                folderResults[folder] = folderCount;
                console.log(`Synced ${folderCount} emails from ${folder}`);

                // Update progress
                if (io) {
                    io.to(`user_${user.cuserid}`).emit('sync_progress', {
                        folder: folder,
                        current: totalSynced,
                        total: maxResults * folders.length,
                        status: 'completed',
                        folderCount: folderCount
                    });
                }
            } catch (folderError) {
                console.error(`Error syncing folder ${folder}:`, folderError);
                folderResults[folder] = 0;
            }
        }

        // Clear cache after sync
        clearEmailCache(user.cuserid);

        // Final progress update
        if (io) {
            io.to(`user_${user.cuserid}`).emit('sync_progress', {
                status: 'complete',
                total: totalSynced,
                folders: folderResults
            });
        }

        res.json({
            success: true,
            message: `Synced ${totalSynced} emails across all folders`,
            count: totalSynced,
            folders: folderResults
        });
    } catch (error) {
        console.error('Error syncing all emails:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to sync emails: ' + (error.message || 'Unknown error')
        });
    }
};

// Debug function to check email counts
export const debugEmailCount = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);

        // Get counts by folder
        const folders = ['inbox', 'sent', 'drafts', 'trash', 'spam'];
        const counts: Record<string, number> = {};

        for (const folder of folders) {
            const result = await executeQuery<any>(
                'SELECT COUNT(*) as count FROM nt_user_emails WHERE cuserid = @cuserid AND folder = @folder',
                { cuserid: user.cuserid, folder }
            );
            counts[folder] = result[0]?.count || 0;
        }

        // Get total
        const totalResult = await executeQuery<any>(
            'SELECT COUNT(*) as total FROM nt_user_emails WHERE cuserid = @cuserid',
            { cuserid: user.cuserid }
        );

        // Get sample of emails
        const sample = await executeQuery<any>(
            `SELECT TOP 5 gmail_id, subject, folder, date 
             FROM nt_user_emails 
             WHERE cuserid = @cuserid 
             ORDER BY date DESC`,
            { cuserid: user.cuserid }
        );

        // Get folder counts from Gmail API
        let gmailCounts: Record<string, number> = {};
        try {
            const tokens = await getGmailTokens(user.cuserid);
            if (tokens) {
                gmailService.setUserCredentials(tokens);
                const profile = await gmailService.getUserProfile();
                gmailCounts = {
                    inbox: await gmailService.getFolderCount('INBOX'),
                    sent: await gmailService.getFolderCount('SENT'),
                    drafts: await gmailService.getFolderCount('DRAFT'),
                    trash: await gmailService.getFolderCount('TRASH'),
                    spam: await gmailService.getFolderCount('SPAM')
                };
            }
        } catch (error) {
            console.error('Error getting Gmail counts:', error);
        }

        res.json({
            success: true,
            database: {
                counts,
                total: totalResult[0]?.total || 0,
                sample: sample || []
            },
            gmail: gmailCounts,
            user: {
                cuserid: user.cuserid,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Error debugging email count:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to debug email count'
        });
    }
};

async function syncEmailsInBackground(cuserid: number, folder: string) {
    try {
        console.log(`Background sync started for user ${cuserid}, folder: ${folder}`);

        const tokens = await getGmailTokens(cuserid);
        if (!tokens) {
            console.log('No tokens found for background sync');
            return;
        }

        gmailService.setUserCredentials(tokens);

        // Check how many emails we already have
        const countResult = await executeQuery<any>(
            'SELECT COUNT(*) as total FROM nt_user_emails WHERE cuserid = @cuserid AND folder = @folder',
            { cuserid, folder }
        );
        const total = countResult[0]?.total || 0;

        const syncLimit = total < 100 ? 500 : 50;

        console.log(`Current emails: ${total}, syncing ${syncLimit} emails`);

        // Map folder to Gmail label
        const folderToLabel: Record<string, string> = {
            'inbox': 'INBOX',
            'sent': 'SENT',
            'drafts': 'DRAFT',
            'trash': 'TRASH',
            'spam': 'SPAM'
        };

        const label = folderToLabel[folder] || 'INBOX';

        const result = await gmailService.getEmailsOptimized(
            cuserid.toString(),
            undefined,
            syncLimit,
            [label],
            undefined
        );

        if (result.emails.length > 0) {
            console.log(`Found ${result.emails.length} emails, saving to cache...`);
            let savedCount = 0;
            for (const email of result.emails) {
                await saveEmailToDatabase(cuserid, email);
                savedCount++;
            }
            console.log(`Background sync completed: ${savedCount} emails saved`);

            clearEmailCache(cuserid);
        } else {
            console.log('No emails found in background sync');
        }
    } catch (error: any) {
        console.error('Error in background sync:', error);

        // Check for scope error
        if (error?.message?.includes('INSUFFICIENT_SCOPES')) {
            console.error('User needs to reconnect Gmail with full permissions');
            // Could notify user via socket or database
        }
    }
}

// ==============================================
// OTHER CONTROLLER FUNCTIONS
// ==============================================
export const checkGmailStatus = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        console.log(`Checking Gmail status for user: ${user.cuserid}`);

        // First check if the user exists
        if (!user || !user.cuserid) {
            console.log('Invalid user data');
            return res.status(401).json({
                success: false,
                connected: false,
                message: 'Invalid user'
            });
        }

        // Check if the table exists and get token
        let result;
        try {
            result = await executeQuery<any>(
                `SELECT id, email, expires_at, access_token, refresh_token, is_active
                 FROM nt_user_gmail_tokens 
                 WHERE cuserid = @cuserid`,
                { cuserid: user.cuserid }
            );
        } catch (dbError: any) {
            console.error('Database error:', dbError);
            // Check if table doesn't exist
            if (dbError.message?.includes('Invalid object name')) {
                console.log('Table nt_user_gmail_tokens does not exist');
                return res.json({
                    success: true,
                    connected: false,
                    email: null,
                    needsReconnect: false,
                    message: 'Gmail tokens table not found'
                });
            }
            throw dbError;
        }

        console.log(`Token query result:`, result);

        // Check if token exists and is active
        const connected = result && result.length > 0 && result[0].is_active === 1;

        if (!connected) {
            console.log(`No active token found for user ${user.cuserid}`);
            return res.json({
                success: true,
                connected: false,
                email: null,
                needsReconnect: false,
                message: 'No active Gmail connection'
            });
        }

        const tokenData = result[0];
        console.log(`Found token for user ${user.cuserid}, email: ${tokenData.email}`);

        // Check if token has expired
        const now = new Date();
        const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at) : null;

        if (expiresAt && expiresAt < now) {
            console.log(`Token expired for user ${user.cuserid}, attempting refresh...`);
            try {
                const credentials = await gmailService.refreshUserToken(tokenData.refresh_token);

                await executeNonQuery(
                    `UPDATE nt_user_gmail_tokens 
                     SET access_token = @accessToken, 
                         expires_at = @expiresAt,
                         updated_at = GETDATE()
                     WHERE cuserid = @cuserid`,
                    {
                        cuserid: user.cuserid,
                        accessToken: credentials.access_token,
                        expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null
                    }
                );

                console.log(`Token refreshed for user ${user.cuserid}`);

                // Check scopes after refresh
                const hasScopes = await checkGmailScopes(user.cuserid);
                if (!hasScopes) {
                    console.log(`Insufficient scopes for user ${user.cuserid}`);
                    return res.json({
                        success: true,
                        connected: true,
                        email: tokenData.email,
                        needsReconnect: true,
                        message: 'Insufficient scopes. Please reconnect.'
                    });
                }

                return res.json({
                    success: true,
                    connected: true,
                    refreshed: true,
                    email: tokenData.email,
                    needsReconnect: false
                });
            } catch (refreshError: any) {
                console.error('Error refreshing token:', refreshError);
                // If refresh fails, mark as inactive
                try {
                    await executeNonQuery(
                        `UPDATE nt_user_gmail_tokens SET is_active = 0 WHERE cuserid = @cuserid`,
                        { cuserid: user.cuserid }
                    );
                } catch (updateError) {
                    console.error('Error updating token status:', updateError);
                }
                return res.json({
                    success: true,
                    connected: false,
                    email: null,
                    needsReconnect: true,
                    message: 'Token refresh failed. Please reconnect.'
                });
            }
        }

        // Check if token has proper scopes
        const hasScopes = await checkGmailScopes(user.cuserid);
        if (!hasScopes) {
            console.log(`Insufficient scopes for user ${user.cuserid}`);
            return res.json({
                success: true,
                connected: true,
                email: tokenData.email,
                needsReconnect: true,
                message: 'Insufficient scopes. Please reconnect.'
            });
        }

        console.log(`Gmail connection verified for user ${user.cuserid}`);
        res.json({
            success: true,
            connected: true,
            email: tokenData.email,
            needsReconnect: false,
            message: 'Connected'
        });
    } catch (error) {
        console.error('Error checking Gmail status:', error);
        // Don't return 500, return a proper response
        res.json({
            success: false,
            connected: false,
            message: error.message || 'Failed to check Gmail status',
            email: null,
            needsReconnect: false
        });
    }
};

async function checkGmailScopes(cuserid: number): Promise<boolean> {
    try {
        const tokens = await getGmailTokens(cuserid);
        if (!tokens) {
            console.log(`No tokens found for user ${cuserid}`);
            return false;
        }

        gmailService.setUserCredentials(tokens);

        // Try a simple operation that requires basic scope
        try {
            // Try to get user profile (requires basic scope)
            const profile = await gmailService.getUserProfile();
            console.log(`Profile fetched for user ${cuserid}:`, profile.emailAddress);

            // Try to list messages with a query (requires full scope)
            try {
                const result = await gmailService.getMessagesList(undefined, 1);
                console.log(`Messages list fetched for user ${cuserid}`);
                return true;
            } catch (queryError: any) {
                // If query fails with scope error, it might be a metadata-only token
                if (queryError?.status === 403 &&
                    (queryError?.response?.data?.error?.message?.includes('scope') ||
                        queryError?.message?.includes('Metadata scope'))) {
                    console.log(`User ${cuserid} has metadata-only scope, needs reconnection`);
                    return false;
                }
                // If query fails with other error, token might still be valid
                console.log(`Query failed but token might be valid:`, queryError?.message);
                return true;
            }
        } catch (error: any) {
            console.error(`Error checking scopes for user ${cuserid}:`, error);
            return false;
        }
    } catch (error) {
        console.error('Error in checkGmailScopes:', error);
        return false;
    }
}

export const debugTokenStatus = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);

        // Get token from database
        const result = await executeQuery<any>(
            `SELECT id, email, expires_at, is_active, created_at, updated_at
             FROM nt_user_gmail_tokens 
             WHERE cuserid = @cuserid`,
            { cuserid: user.cuserid }
        );

        let tokenValid = false;
        let scopeStatus = 'unknown';

        if (result && result.length > 0 && result[0].is_active === 1) {
            const tokenData = result[0];
            const now = new Date();
            const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at) : null;

            if (!expiresAt || expiresAt > now) {
                try {
                    const tokens = await getGmailTokens(user.cuserid);
                    if (tokens) {
                        gmailService.setUserCredentials(tokens);
                        const profile = await gmailService.getUserProfile();
                        tokenValid = true;
                        scopeStatus = 'valid';

                        // Check if can query
                        try {
                            await gmailService.getMessagesList(undefined, 1);
                            scopeStatus = 'full';
                        } catch (queryError: any) {
                            if (queryError?.message?.includes('Metadata scope')) {
                                scopeStatus = 'metadata_only';
                            } else {
                                scopeStatus = 'limited';
                            }
                        }
                    }
                } catch (error: any) {
                    console.error('Error validating token:', error);
                    scopeStatus = 'invalid';
                }
            }
        }

        res.json({
            success: true,
            user: {
                cuserid: user.cuserid,
                email: user.email
            },
            token: result && result.length > 0 ? {
                exists: true,
                email: result[0].email,
                expires_at: result[0].expires_at,
                is_active: result[0].is_active === 1,
                created_at: result[0].created_at,
                updated_at: result[0].updated_at
            } : null,
            tokenValid,
            scopeStatus,
            connected: tokenValid && scopeStatus !== 'metadata_only'
        });
    } catch (error) {
        console.error('Error debugging token:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to debug token'
        });
    }
};

export const getGmailEmail = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        const email = await gmailService.getEmail(id);

        await saveEmailToDatabase(user.cuserid, email);

        res.json({
            success: true,
            email
        });
    } catch (error) {
        console.error('Error fetching Gmail email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch email'
        });
    }
};

export const debugOAuthFlow = async (req: Request, res: Response) => {
    try {
        const { cuserid } = req.query;

        if (!cuserid) {
            return res.status(400).json({
                success: false,
                message: 'cuserid is required'
            });
        }

        // Get the auth URL
        const authUrl = gmailService.getAuthUrl(
            cuserid.toString(),
            false,
            false
        );

        // Check if token exists
        const tokenResult = await executeQuery<any>(
            'SELECT * FROM nt_user_gmail_tokens WHERE cuserid = @cuserid',
            { cuserid: parseInt(cuserid as string) }
        );

        res.json({
            success: true,
            cuserid: cuserid,
            authUrl: authUrl,
            tokenExists: tokenResult && tokenResult.length > 0,
            tokenDetails: tokenResult && tokenResult.length > 0 ? {
                email: tokenResult[0].email,
                is_active: tokenResult[0].is_active,
                expires_at: tokenResult[0].expires_at
            } : null,
            instructions: [
                '1. Click the authUrl to start OAuth flow',
                '2. Grant permissions to Google',
                '3. After redirect, check the token in the database'
            ]
        });
    } catch (error) {
        console.error('Error debugging OAuth flow:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to debug OAuth flow'
        });
    }
};

export const getGmailNavigation = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;

        const current = await executeQuery<any>(
            'SELECT date FROM nt_user_emails WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { gmailId: id, cuserid: user.cuserid }
        );

        if (!current || current.length === 0) {
            return res.json({
                success: true,
                previous: null,
                next: null
            });
        }

        const currentDate = current[0].date;

        const previous = await executeQuery<any>(
            `SELECT gmail_id FROM nt_user_emails 
             WHERE cuserid = @cuserid 
               AND folder = 'inbox' 
               AND date < @currentDate
             ORDER BY date DESC`,
            { cuserid: user.cuserid, currentDate }
        );

        const next = await executeQuery<any>(
            `SELECT gmail_id FROM nt_user_emails 
             WHERE cuserid = @cuserid 
               AND folder = 'inbox' 
               AND date > @currentDate
             ORDER BY date ASC`,
            { cuserid: user.cuserid, currentDate }
        );

        res.json({
            success: true,
            previous: previous[0]?.gmail_id || null,
            next: next[0]?.gmail_id || null
        });
    } catch (error) {
        console.error('Error getting navigation:', error);
        res.json({
            success: true,
            previous: null,
            next: null
        });
    }
};

export const getGmailFolderCounts = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);

        const folders = ['inbox', 'sent', 'drafts', 'trash', 'spam'];
        const counts: Record<string, number> = {};

        for (const folder of folders) {
            const result = await executeQuery<any>(
                'SELECT COUNT(*) as count FROM nt_user_emails WHERE cuserid = @cuserid AND folder = @folder',
                { cuserid: user.cuserid, folder }
            );
            counts[folder] = result[0]?.count || 0;
        }

        res.json({
            success: true,
            counts
        });
    } catch (error) {
        console.error('Error getting folder counts:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get folder counts'
        });
    }
};

export const getGmailLabels = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        const labels = await gmailService.getLabels();

        res.json({
            success: true,
            labels
        });
    } catch (error) {
        console.error('Error fetching labels:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch labels'
        });
    }
};

export const searchGmailEmails = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const query = req.query.q as string;
        const maxResults = parseInt(req.query.maxResults as string) || 50;
        const pageToken = req.query.pageToken as string;

        if (!query) {
            return res.status(400).json({
                success: false,
                message: 'Search query is required'
            });
        }

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        const result = await gmailService.searchEmails(query, maxResults, pageToken);

        res.json({
            success: true,
            emails: result.emails,
            nextPageToken: result.nextPageToken,
            total: result.resultSizeEstimate
        });
    } catch (error) {
        console.error('Error searching Gmail emails:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search emails'
        });
    }
};

export const syncGmailEmails = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const maxResults = parseInt(req.query.maxResults as string) || 100;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);

        const labelMap = getLabelMap();
        const result = await gmailService.getEmailsOptimized(
            user.cuserid.toString(),
            undefined,
            maxResults,
            ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM'],
            undefined
        );

        for (const email of result.emails) {
            await saveEmailToDatabase(user.cuserid, email);
        }

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: `Synced ${result.emails.length} emails`,
            total: result.resultSizeEstimate,
            emails: result.emails
        });
    } catch (error) {
        console.error('Error syncing Gmail emails:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to sync emails'
        });
    }
};

export const sendGmailEmail = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { to, subject, body, cc, bcc } = req.body;

        const toEmails = typeof to === 'string' ? JSON.parse(to) : to || [];
        const ccEmails = typeof cc === 'string' ? JSON.parse(cc || '[]') : cc || [];
        const bccEmails = typeof bcc === 'string' ? JSON.parse(bcc || '[]') : bcc || [];

        if (!toEmails || toEmails.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Recipients are required'
            });
        }

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);

        const attachments: any[] = [];
        if (req.files && (req.files as any[]).length > 0) {
            for (const file of req.files as any[]) {
                attachments.push({
                    filename: file.originalname,
                    content: file.buffer,
                    mimeType: file.mimetype
                });
            }
        }

        const result = await gmailService.sendEmail(
            toEmails,
            subject,
            body,
            ccEmails,
            bccEmails,
            attachments
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: 'Email sent successfully',
            result
        });
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send email'
        });
    }
};

export const saveGmailDraft = async (req: AuthRequest, res: Response) => {
    try {
        return sendGmailEmail(req, res);
    } catch (error) {
        console.error('Error saving draft:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save draft'
        });
    }
};

export const toggleGmailStar = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        const email = await gmailService.getEmail(id);
        const isStarred = email.isStarred;

        if (isStarred) {
            await gmailService.removeLabel(id, 'STARRED');
        } else {
            await gmailService.addLabel(id, 'STARRED');
        }

        await executeNonQuery(
            'UPDATE nt_user_emails SET is_starred = @isStarred WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { isStarred: !isStarred ? 1 : 0, gmailId: id, cuserid: user.cuserid }
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            isStarred: !isStarred,
            message: isStarred ? 'Unstarred' : 'Starred'
        });
    } catch (error) {
        console.error('Error toggling star:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle star'
        });
    }
};

export const markGmailRead = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        await gmailService.removeLabel(id, 'UNREAD');

        await executeNonQuery(
            'UPDATE nt_user_emails SET is_read = 1 WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { gmailId: id, cuserid: user.cuserid }
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: 'Marked as read'
        });
    } catch (error) {
        console.error('Error marking as read:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark as read'
        });
    }
};

export const markGmailUnread = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        await gmailService.addLabel(id, 'UNREAD');

        await executeNonQuery(
            'UPDATE nt_user_emails SET is_read = 0 WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { gmailId: id, cuserid: user.cuserid }
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: 'Marked as unread'
        });
    } catch (error) {
        console.error('Error marking as unread:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark as unread'
        });
    }
};

export const deleteGmailEmail = async (req: AuthRequest, res: Response) => {
    try {
        return moveGmailToTrash(req, res);
    } catch (error) {
        console.error('Error deleting email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete email'
        });
    }
};

export const moveGmailToTrash = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        await gmailService.addLabel(id, 'TRASH');

        await executeNonQuery(
            'UPDATE nt_user_emails SET folder = @folder WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { folder: 'trash', gmailId: id, cuserid: user.cuserid }
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: 'Moved to trash'
        });
    } catch (error) {
        console.error('Error moving to trash:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to move to trash'
        });
    }
};

export const moveGmailToSpam = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        await gmailService.addLabel(id, 'SPAM');

        await executeNonQuery(
            'UPDATE nt_user_emails SET folder = @folder WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { folder: 'spam', gmailId: id, cuserid: user.cuserid }
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: 'Marked as spam'
        });
    } catch (error) {
        console.error('Error moving to spam:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark as spam'
        });
    }
};

export const restoreGmailFromTrash = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        await gmailService.removeLabel(id, 'TRASH');

        await executeNonQuery(
            'UPDATE nt_user_emails SET folder = @folder WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { folder: 'inbox', gmailId: id, cuserid: user.cuserid }
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: 'Restored from trash'
        });
    } catch (error) {
        console.error('Error restoring from trash:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to restore from trash'
        });
    }
};

export const addGmailLabel = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id } = req.params;
        const { label } = req.body;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);

        const labels = await gmailService.getLabels();
        let labelId = labels.find((l: any) => l.name === label)?.id;

        if (!labelId) {
            const newLabel = await gmailService.createLabel(label);
            labelId = newLabel.id;
        }

        await gmailService.addLabel(id, labelId);

        const email = await executeQuery<any>(
            'SELECT labels FROM nt_user_emails WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { gmailId: id, cuserid: user.cuserid }
        );

        let emailLabels = [];
        if (email && email.length > 0 && email[0].labels) {
            try {
                emailLabels = JSON.parse(email[0].labels);
            } catch (e) {
                emailLabels = [];
            }
        }

        if (!emailLabels.includes(label)) {
            emailLabels.push(label);
        }

        await executeNonQuery(
            'UPDATE nt_user_emails SET labels = @labels WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { labels: JSON.stringify(emailLabels), gmailId: id, cuserid: user.cuserid }
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: 'Label added'
        });
    } catch (error) {
        console.error('Error adding label:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add label'
        });
    }
};

export const removeGmailLabel = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id, labelId } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        await gmailService.removeLabel(id, labelId);

        const email = await executeQuery<any>(
            'SELECT labels FROM nt_user_emails WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { gmailId: id, cuserid: user.cuserid }
        );

        let emailLabels = [];
        if (email && email.length > 0 && email[0].labels) {
            try {
                emailLabels = JSON.parse(email[0].labels);
            } catch (e) {
                emailLabels = [];
            }
        }

        const labels = await gmailService.getLabels();
        const label = labels.find((l: any) => l.id === labelId);
        const labelName = label?.name;

        if (labelName) {
            emailLabels = emailLabels.filter((l: string) => l !== labelName);
        }

        await executeNonQuery(
            'UPDATE nt_user_emails SET labels = @labels WHERE gmail_id = @gmailId AND cuserid = @cuserid',
            { labels: JSON.stringify(emailLabels), gmailId: id, cuserid: user.cuserid }
        );

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: 'Label removed'
        });
    } catch (error) {
        console.error('Error removing label:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove label'
        });
    }
};

export const downloadGmailAttachment = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { id, attachmentId } = req.params;

        const tokens = await getGmailTokens(user.cuserid);
        if (!tokens) {
            return res.status(400).json({
                success: false,
                message: 'Please connect your Gmail account first'
            });
        }

        gmailService.setUserCredentials(tokens);
        const buffer = await gmailService.getAttachment(id, attachmentId);

        const email = await gmailService.getEmail(id);
        const attachment = email.attachments.find((a: any) => a.attachmentId === attachmentId);

        if (!attachment) {
            return res.status(404).json({
                success: false,
                message: 'Attachment not found'
            });
        }

        res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
        res.send(buffer);
    } catch (error) {
        console.error('Error downloading attachment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to download attachment'
        });
    }
};

export const bulkDeleteEmails = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { emailIds } = req.body;

        if (emailIds && emailIds.length > 0) {
            // Build dynamic query
            const placeholders = emailIds.map((_: any, i: number) => `@id${i}`).join(',');
            const query = `DELETE FROM nt_user_emails WHERE gmail_id IN (${placeholders}) AND cuserid = @cuserid`;

            const params: any = { cuserid: user.cuserid };
            emailIds.forEach((id: string, index: number) => {
                params[`id${index}`] = id;
            });

            await executeNonQuery(query, params);
        }

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: `${emailIds?.length || 0} emails deleted`
        });
    } catch (error) {
        console.error('Error bulk deleting:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete emails'
        });
    }
};

export const bulkMoveToTrash = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { emailIds } = req.body;

        if (emailIds && emailIds.length > 0) {
            const placeholders = emailIds.map((_: any, i: number) => `@id${i}`).join(',');
            const query = `UPDATE nt_user_emails SET folder = 'trash' 
                           WHERE gmail_id IN (${placeholders}) AND cuserid = @cuserid`;

            const params: any = { cuserid: user.cuserid };
            emailIds.forEach((id: string, index: number) => {
                params[`id${index}`] = id;
            });

            await executeNonQuery(query, params);
        }

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: `${emailIds?.length || 0} emails moved to trash`
        });
    } catch (error) {
        console.error('Error bulk moving to trash:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to move emails to trash'
        });
    }
};

export const bulkMarkAsRead = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { emailIds } = req.body;

        if (emailIds && emailIds.length > 0) {
            const placeholders = emailIds.map((_: any, i: number) => `@id${i}`).join(',');
            const query = `UPDATE nt_user_emails SET is_read = 1 
                           WHERE gmail_id IN (${placeholders}) AND cuserid = @cuserid`;

            const params: any = { cuserid: user.cuserid };
            emailIds.forEach((id: string, index: number) => {
                params[`id${index}`] = id;
            });

            await executeNonQuery(query, params);
        }

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: `${emailIds?.length || 0} emails marked as read`
        });
    } catch (error) {
        console.error('Error bulk marking as read:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark emails as read'
        });
    }
};

export const bulkMarkAsUnread = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { emailIds } = req.body;

        if (emailIds && emailIds.length > 0) {
            const placeholders = emailIds.map((_: any, i: number) => `@id${i}`).join(',');
            const query = `UPDATE nt_user_emails SET is_read = 0 
                           WHERE gmail_id IN (${placeholders}) AND cuserid = @cuserid`;

            const params: any = { cuserid: user.cuserid };
            emailIds.forEach((id: string, index: number) => {
                params[`id${index}`] = id;
            });

            await executeNonQuery(query, params);
        }

        clearEmailCache(user.cuserid);

        res.json({
            success: true,
            message: `${emailIds?.length || 0} emails marked as unread`
        });
    } catch (error) {
        console.error('Error bulk marking as unread:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark emails as unread'
        });
    }
};

export const clearEmailCacheDev = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);

        clearEmailCache(user.cuserid);

        await executeNonQuery(
            'DELETE FROM nt_user_emails WHERE cuserid = @cuserid',
            { cuserid: user.cuserid }
        );

        res.json({
            success: true,
            message: 'Cache cleared successfully'
        });
    } catch (error) {
        console.error('Error clearing cache:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear cache'
        });
    }
};