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

// ✅ Get total count from database
async function getTotalCount(cuserid: number, folder: string): Promise<number> {
    const result = await executeQuery<any>(
        'SELECT COUNT(*) as total FROM nt_user_emails WHERE cuserid = @cuserid AND folder = @folder',
        { cuserid, folder }
    );
    return result[0]?.total || 0;
}

// ✅ Get label map
function getLabelMap(): Record<string, string> {
    return {
        'inbox': 'INBOX',
        'sent': 'SENT',
        'drafts': 'DRAFT',
        'trash': 'TRASH',
        'spam': 'SPAM'
    };
}

// ✅ Clear cache function
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
    console.log(`🧹 Cleared ${keysToDelete.length} cache entries for user ${cuserid}`);
};

// ==============================================
// AUTH HANDLERS
// ==============================================

export const handleGmailAuth = async (req: Request, res: Response) => {
    try {
        const { cuserid } = req.query;

        console.log('🔑 Gmail Auth Request:', { cuserid });

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

        const authUrl = gmailService.getAuthUrl(cuserid.toString());

        console.log(`🔑 User ${cuserid} starting Gmail auth`);

        res.redirect(authUrl);
    } catch (error) {
        console.error('Error initiating Gmail auth:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initiate Gmail authentication'
        });
    }
};

export const warmGmailCache = async (cuserid: number) => {
    try {
        console.log(`🔥 Warming cache for user ${cuserid}`);

        const tokens = await getGmailTokens(cuserid);
        if (!tokens) return;

        gmailService.setUserCredentials(tokens);

        // ✅ Fetch first page only
        const result = await gmailService.getEmailsOptimized(
            cuserid.toString(),
            undefined,
            10,
            ['INBOX'],
            undefined
        );

        const cacheKey = `${cuserid}_inbox_first_10_`;
        emailCache.set(cacheKey, {
            emails: result.emails,
            nextPageToken: result.nextPageToken,
            total: result.resultSizeEstimate,
            timestamp: Date.now()
        });

        console.log(`✅ Cache warmed for user ${cuserid}`);
    } catch (error) {
        console.error('Error warming cache:', error);
    }
};

export const preFetchEmails = async (cuserid: number) => {
    try {
        console.log(`🚀 Pre-fetching emails for user ${cuserid}`);
        await syncEmailsInBackground(cuserid, 'inbox');
        await syncEmailsInBackground(cuserid, 'sent');
        console.log(`✅ Pre-fetch completed for user ${cuserid}`);
    } catch (error) {
        console.error('Error pre-fetching emails:', error);
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

        console.log('📞 Callback received with state:', state);

        let cuserid: string;

        if (state) {
            try {
                const decoded = Buffer.from(state as string, 'base64').toString();
                const stateObj = JSON.parse(decoded);
                cuserid = stateObj.cuserid;
                console.log('✅ Decoded state from base64:', { cuserid });
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

        console.log(`📞 Callback received for user ${cuserid}`);

        const tokens = await gmailService.getTokens(code as string);

        gmailService.setUserCredentials(tokens);
        const profile = await gmailService.getUserProfile();
        const userEmail = profile.emailAddress;

        console.log(`✅ User ${cuserid} connected Gmail: ${userEmail}`);

        const cuseridNum = parseInt(cuserid as string);

        // Check if token exists
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
            console.log('✅ Token updated for user:', cuserid);
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
            console.log('✅ New token inserted for user:', cuserid);
        }
        await warmGmailCache(cuseridNum);
        setImmediate(() => {
            preFetchEmails(cuseridNum).catch(err =>
                console.error('Pre-fetch error:', err)
            );
        });
        res.redirect(`http://localhost:4200/#/user/email?gmail=connected`);

    } catch (error) {
        console.error('Error handling Gmail callback:', error);
        res.redirect(`http://localhost:4200/#/user/email?gmail=error&message=${encodeURIComponent(error.message)}`);
    }
};

// ==============================================
// OPTIMIZED GET EMAILS
// ==============================================
export const getGmailEmails = async (req: AuthRequest, res: Response) => {
    try {
        console.log("Reached getGmailEmails");
        const user = await getUserFromToken(req);
        const folder = req.query.folder as string || 'inbox';
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 20);
        const offset = (page - 1) * limit;

        console.log(`📧 Fetching emails for user ${user.cuserid} - folder: ${folder}`);

        // ✅ ALWAYS check database cache first (this is fast)
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

        // ✅ Get total count
        const countResult = await executeQuery<any>(
            'SELECT COUNT(*) as total FROM nt_user_emails WHERE cuserid = @cuserid AND folder = @folder',
            { cuserid: user.cuserid, folder: folder }
        );
        const totalFromDb = countResult[0]?.total || 0;

        // ✅ If we have cached emails, return them
        if (cachedEmails && cachedEmails.length > 0) {
            console.log(`📦 Returning ${cachedEmails.length} emails from database cache`);

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

            // ✅ Trigger background sync to check for new emails
            setImmediate(() => {
                syncEmailsInBackground(user.cuserid, folder).catch(err =>
                    console.error('Background sync error:', err)
                );
            });

            return res.json({
                success: true,
                emails: parsedEmails,
                page: page,
                limit: limit,
                total: totalFromDb,
                fromCache: true,
                count: parsedEmails.length
            });
        }

        // ✅ NO CACHE - Return empty response immediately
        // The first request will return empty, but subsequent requests will have data
        console.log('🔄 No cache found. Returning empty and starting background sync...');

        // ✅ Start background sync (don't await)
        setImmediate(() => {
            syncEmailsInBackground(user.cuserid, folder).catch(err =>
                console.error('Background sync error:', err)
            );
        });

        // ✅ Return empty array immediately (no waiting for Gmail API)
        res.json({
            success: true,
            emails: [],
            page: page,
            limit: limit,
            total: 0,
            fromCache: false,
            loading: true,
            message: 'Loading emails... Please refresh in a moment'
        });

    } catch (error) {
        console.error('Error fetching Gmail emails:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch emails',
            emails: [],
            total: 0
        });
    }
};
async function syncEmailsInBackground(cuserid: number, folder: string) {
    try {
        // ✅ Add a timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Background sync timeout')), 30000);
        });

        const syncPromise = (async () => {
            console.log(`🔄 Background sync started for user ${cuserid}, folder: ${folder}`);

            const tokens = await getGmailTokens(cuserid);
            if (!tokens) {
                console.log('❌ No tokens found for background sync');
                return;
            }

            gmailService.setUserCredentials(tokens);

            const result = await gmailService.getEmailsOptimized(
                cuserid.toString(),
                undefined,
                20,
                [getLabelMap()[folder] || 'INBOX'],
                undefined
            );

            if (result.emails.length > 0) {
                console.log(`📥 Found ${result.emails.length} emails, saving to cache...`);
                for (const email of result.emails) {
                    await saveEmailToDatabase(cuserid, email);
                }
                console.log(`✅ Background sync completed: ${result.emails.length} emails saved`);
            }
        })();

        await Promise.race([syncPromise, timeoutPromise]);
    } catch (error) {
        console.error('Error in background sync:', error);
    }
}

export const clearEmailCacheDev = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);

        // Clear memory cache
        clearEmailCache(user.cuserid);

        // Clear database cache
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

// ==============================================
// STATUS & CONNECTION
// ==============================================

export const checkGmailStatus = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);

        const result = await executeQuery<any>(
            `SELECT id, email, expires_at 
             FROM nt_user_gmail_tokens 
             WHERE cuserid = @cuserid AND is_active = 1`,
            { cuserid: user.cuserid }
        );

        const connected = result && result.length > 0;

        if (connected && result[0].expires_at && new Date(result[0].expires_at) < new Date()) {
            try {
                const refreshResult = await executeQuery<any>(
                    'SELECT refresh_token FROM nt_user_gmail_tokens WHERE cuserid = @cuserid',
                    { cuserid: user.cuserid }
                );

                if (refreshResult && refreshResult.length > 0) {
                    const credentials = await gmailService.refreshUserToken(refreshResult[0].refresh_token);

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

                    return res.json({
                        success: true,
                        connected: true,
                        refreshed: true,
                        email: result[0].email
                    });
                }
            } catch (refreshError) {
                console.error('Error refreshing token:', refreshError);
            }
        }

        res.json({
            success: true,
            connected: connected,
            email: connected ? result[0].email : null
        });
    } catch (error) {
        console.error('Error checking Gmail status:', error);
        res.status(500).json({
            success: false,
            connected: false,
            message: 'Failed to check Gmail status'
        });
    }
};

// ==============================================
// EMAIL CRUD - OTHER METHODS
// ==============================================

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

// ==============================================
// LABELS
// ==============================================

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

        // Clear cache after label change
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

        // Clear cache after label change
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

// ==============================================
// SEARCH & SYNC
// ==============================================

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

        // Clear cache after sync
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

// ==============================================
// SEND EMAIL
// ==============================================

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

        // Clear cache after sending email
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

// ==============================================
// EMAIL ACTIONS
// ==============================================

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

        // Clear cache after action
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

        // Clear cache after action
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

        // Clear cache after action
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

        // Clear cache after action
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

        // Clear cache after action
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

        // Clear cache after action
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

// ==============================================
// ATTACHMENTS
// ==============================================

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

// ==============================================
// BULK OPERATIONS
// ==============================================

export const bulkDeleteEmails = async (req: AuthRequest, res: Response) => {
    try {
        const user = await getUserFromToken(req);
        const { emailIds } = req.body;

        if (emailIds && emailIds.length > 0) {
            const placeholders = emailIds.map(() => '?').join(',');
            const query = `DELETE FROM nt_user_emails WHERE gmail_id IN (${placeholders}) AND cuserid = @cuserid`;

            const params: any = { cuserid: user.cuserid };
            emailIds.forEach((id: string, index: number) => {
                params[`id${index}`] = id;
            });

            await executeNonQuery(query, params);
        }

        // Clear cache after bulk action
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
            const placeholders = emailIds.map(() => '?').join(',');
            const query = `UPDATE nt_user_emails SET folder = 'trash' 
                           WHERE gmail_id IN (${placeholders}) AND cuserid = @cuserid`;

            const params: any = { cuserid: user.cuserid };
            emailIds.forEach((id: string, index: number) => {
                params[`id${index}`] = id;
            });

            await executeNonQuery(query, params);
        }

        // Clear cache after bulk action
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
            const placeholders = emailIds.map(() => '?').join(',');
            const query = `UPDATE nt_user_emails SET is_read = 1 
                           WHERE gmail_id IN (${placeholders}) AND cuserid = @cuserid`;

            const params: any = { cuserid: user.cuserid };
            emailIds.forEach((id: string, index: number) => {
                params[`id${index}`] = id;
            });

            await executeNonQuery(query, params);
        }

        // Clear cache after bulk action
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
            const placeholders = emailIds.map(() => '?').join(',');
            const query = `UPDATE nt_user_emails SET is_read = 0 
                           WHERE gmail_id IN (${placeholders}) AND cuserid = @cuserid`;

            const params: any = { cuserid: user.cuserid };
            emailIds.forEach((id: string, index: number) => {
                params[`id${index}`] = id;
            });

            await executeNonQuery(query, params);
        }

        // Clear cache after bulk action
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