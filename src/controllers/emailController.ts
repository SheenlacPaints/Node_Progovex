// backend/src/controllers/emailController.ts
import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { mysqlPool } from '../config/database';
import { google } from 'googleapis';
import Imap from 'imap';
import { simpleParser } from 'mailparser';

const OAuth2 = google.auth.OAuth2;

// Google OAuth2 configuration
const googleOAuth2Client = new OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/api/email/google/callback`
);

// Helper function to parse Gmail message
function parseGmailMessage(message: any): any {
    const headers = message.payload.headers;

    const getHeader = (name: string) => {
        const header = headers.find((h: any) => h.name === name);
        return header ? header.value : '';
    };

    const getBody = (part: any): string => {
        if (part.mimeType === 'text/html' && part.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString();
        }
        if (part.mimeType === 'text/plain' && part.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString();
        }
        if (part.parts) {
            for (const subPart of part.parts) {
                const body = getBody(subPart);
                if (body) return body;
            }
        }
        return '';
    };

    return {
        id: message.id,
        threadId: message.threadId,
        from: getHeader('From'),
        fromName: getHeader('From').split('<')[0].trim().replace(/"/g, ''),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        snippet: message.snippet || '',
        body: getBody(message.payload),
        isRead: !message.labelIds?.includes('UNREAD'),
        isStarred: message.labelIds?.includes('STARRED') || false,
        receivedAt: new Date(parseInt(message.internalDate))
    };
}

// In emailController.ts, update the storeEmailsInDB function
async function storeEmailsInDB(userId: number, provider: string, emails: any[]): Promise<void> {
    for (const email of emails) {
        await mysqlPool.execute(
            `INSERT INTO nt_synced_emails (cuserid, provider, email_id, thread_id, from_email, from_name, to_emails, subject, body, is_read, is_starred, received_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
             subject = VALUES(subject),
             body = VALUES(body),
             is_read = VALUES(is_read),
             is_starred = VALUES(is_starred),
             synced_at = NOW()`,
            [
                userId, provider, email.id, email.threadId,
                email.from, email.fromName, email.to, email.subject,
                email.body, email.isRead ? 1 : 0,
                email.isStarred ? 1 : 0, email.receivedAt
            ]
        );
    }
}

// Get connected accounts
export const getConnectedAccounts = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        const [accounts] = await mysqlPool.execute(
            `SELECT provider, connected, email, connected_at 
             FROM nt_email_connections 
             WHERE cuserid = ?`,
            [userId]
        );

        const accountsMap: any = {
            gmail: false,
            outlook: false,
            icloud: false,
            imap: false
        };

        (accounts as any[]).forEach(account => {
            accountsMap[account.provider] = account.connected === 1;
        });

        res.json({
            success: true,
            accounts: accountsMap
        });
    } catch (error) {
        console.error('Error getting connected accounts:', error);
        res.status(500).json({ success: false, message: 'Failed to get connected accounts' });
    }
};

// Initiate OAuth flow
export const initiateOAuth = async (req: AuthRequest, res: Response) => {
    try {
        const { provider } = req.params;
        const userId = req.user!.id;

        let authUrl = '';

        switch (provider) {
            case 'gmail':
                const scopes = [
                    'https://www.googleapis.com/auth/gmail.readonly',
                    'https://www.googleapis.com/auth/gmail.send',
                    'https://www.googleapis.com/auth/gmail.modify',
                    'https://www.googleapis.com/auth/gmail.labels',
                    'https://www.googleapis.com/auth/userinfo.email',
                    'https://www.googleapis.com/auth/userinfo.profile'
                ];
                authUrl = googleOAuth2Client.generateAuthUrl({
                    access_type: 'offline',
                    scope: scopes,
                    state: userId.toString(),
                    prompt: 'consent'
                });
                break;

            case 'outlook':
                authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
                    `client_id=${process.env.MICROSOFT_CLIENT_ID}` +
                    `&response_type=code` +
                    `&redirect_uri=${encodeURIComponent(`${process.env.APP_URL}/api/email/outlook/callback`)}` +
                    `&response_mode=query` +
                    `&scope=offline_access Mail.Read Mail.Send Mail.ReadWrite User.Read` +
                    `&state=${userId}`;
                break;

            default:
                return res.status(400).json({ success: false, message: 'Unsupported provider' });
        }

        res.json({
            success: true,
            authUrl
        });
    } catch (error) {
        console.error('Error initiating OAuth:', error);
        res.status(500).json({ success: false, message: 'Failed to initiate OAuth' });
    }
};

// Google OAuth callback
export const googleCallback = async (req: Request, res: Response) => {
    try {
        const { code, state } = req.query;
        const userId = parseInt(state as string);

        const { tokens } = await googleOAuth2Client.getToken(code as string);

        await mysqlPool.execute(
            `INSERT INTO nt_email_connections (cuserid, provider, access_token, refresh_token, connected, connected_at)
             VALUES (?, 'gmail', ?, ?, true, NOW())
             ON DUPLICATE KEY UPDATE
             access_token = VALUES(access_token),
             refresh_token = VALUES(refresh_token),
             connected = true,
             connected_at = NOW()`,
            [userId, tokens.access_token, tokens.refresh_token]
        );

        // Return success page that closes popup
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Connection Successful</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                    }
                    .container {
                        text-align: center;
                        padding: 40px;
                        background: rgba(255,255,255,0.1);
                        border-radius: 16px;
                        backdrop-filter: blur(10px);
                    }
                    .success-icon { font-size: 64px; margin-bottom: 20px; }
                    h2 { margin: 0 0 10px 0; }
                    .auto-close { font-size: 12px; margin-top: 20px; opacity: 0.7; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success-icon">✅</div>
                    <h2>Connection Successful!</h2>
                    <p>Your Gmail account has been connected.</p>
                    <div class="auto-close">This window will close automatically...</div>
                </div>
                <script>
                    if (window.opener) {
                        window.opener.postMessage({
                            type: 'OAUTH_SUCCESS',
                            provider: 'gmail',
                            success: true
                        }, '*');
                        setTimeout(() => window.close(), 2000);
                    } else {
                        window.location.href = '${process.env.FRONTEND_URL}/settings/email?success=true&provider=gmail';
                    }
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error in Google callback:', error);
        res.send(`
            <!DOCTYPE html>
            <html>
            <body>
                <h2>Connection Failed</h2>
                <p>Error: ${error.message}</p>
                <script>
                    if (window.opener) {
                        window.opener.postMessage({
                            type: 'OAUTH_ERROR',
                            provider: 'gmail',
                            error: '${error.message}'
                        }, '*');
                        setTimeout(() => window.close(), 2000);
                    }
                </script>
            </body>
            </html>
        `);
    }
};

// Outlook callback
export const outlookCallback = async (req: Request, res: Response) => {
    try {
        const { code, state } = req.query;
        const userId = parseInt(state as string);

        const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.MICROSOFT_CLIENT_ID!,
                client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
                code: code as string,
                redirect_uri: `${process.env.APP_URL}/api/email/outlook/callback`,
                grant_type: 'authorization_code'
            })
        });

        const tokens = await tokenResponse.json() as any;

        await mysqlPool.execute(
            `INSERT INTO nt_email_connections (cuserid, provider, access_token, refresh_token, connected, connected_at)
             VALUES (?, 'outlook', ?, ?, true, NOW())
             ON DUPLICATE KEY UPDATE
             access_token = VALUES(access_token),
             refresh_token = VALUES(refresh_token),
             connected = true,
             connected_at = NOW()`,
            [userId, tokens.access_token, tokens.refresh_token]
        );

        res.redirect(`${process.env.FRONTEND_URL}/settings/email?success=true&provider=outlook`);
    } catch (error) {
        console.error('Error in Outlook callback:', error);
        res.redirect(`${process.env.FRONTEND_URL}/settings/email?error=true`);
    }
};

// Check OAuth status
export const checkOAuthStatus = async (req: AuthRequest, res: Response) => {
    try {
        const { provider } = req.params;
        const userId = req.user!.id;

        const [connections] = await mysqlPool.execute(
            'SELECT connected FROM nt_email_connections WHERE cuserid = ? AND provider = ?',
            [userId, provider]
        );

        const completed = (connections as any[]).length > 0 && (connections as any[])[0].connected === 1;

        res.json({ success: true, completed });
    } catch (error) {
        console.error('Error checking OAuth status:', error);
        res.status(500).json({ success: false, message: 'Failed to check status' });
    }
};

// Get Gmail emails
export const getGmailEmails = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const maxResults = limit;

        console.log(`📧 Getting emails for user ${userId}, page ${page}, limit ${limit}`);

        // Get user's Gmail tokens
        const [connections] = await mysqlPool.execute(
            'SELECT access_token, refresh_token FROM nt_email_connections WHERE cuserid = ? AND provider = ? AND connected = true',
            [userId, 'gmail']
        );

        if ((connections as any[]).length === 0) {
            return res.status(400).json({ success: false, message: 'Gmail not connected' });
        }

        const { access_token, refresh_token } = (connections as any[])[0];

        // Set up Gmail API client
        const auth = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );
        auth.setCredentials({
            access_token: access_token,
            refresh_token: refresh_token
        });

        const gmail = google.gmail({ version: 'v1', auth });

        // Get list of messages
        const response = await gmail.users.messages.list({
            userId: 'me',
            maxResults: maxResults,
            q: 'in:inbox'
        });

        const messages = response.data.messages || [];

        // Get full message details
        const emails = [];
        for (const message of messages) {
            try {
                const emailData = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id!,
                    format: 'full'
                });
                emails.push(parseGmailMessage(emailData.data));
            } catch (err) {
                console.error(`Error fetching email ${message.id}:`, err);
            }
        }

        // Store emails in database
        if (emails.length > 0) {
            await storeEmailsInDB(userId, 'gmail', emails);
        }

        // Get unread count
        const unreadResult = await gmail.users.messages.list({
            userId: 'me',
            q: 'in:inbox is:unread',
            maxResults: 500
        });
        const unreadCount = unreadResult.data.messages?.length || 0;

        console.log(`✅ Retrieved ${emails.length} emails, ${unreadCount} unread`);

        res.json({
            success: true,
            emails: emails,
            unreadCount: unreadCount,
            total: messages.length,
            page: page,
            limit: limit,
            hasMore: messages.length === limit
        });
    } catch (error) {
        console.error('Error getting Gmail emails:', error);
        res.status(500).json({ success: false, message: 'Failed to get emails', error: String(error) });
    }
};

// Get email by ID
export const getEmailById = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { provider, id } = req.params;

        // Check if email exists in local DB
        const [localEmails] = await mysqlPool.execute(
            'SELECT * FROM nt_synced_emails WHERE cuserid = ? AND provider = ? AND email_id = ?',
            [userId, provider, id]
        );

        if ((localEmails as any[]).length > 0) {
            return res.json({
                success: true,
                email: (localEmails as any[])[0]
            });
        }

        // Fetch from Gmail API
        if (provider === 'gmail') {
            const [connections] = await mysqlPool.execute(
                'SELECT access_token FROM nt_email_connections WHERE cuserid = ? AND provider = ?',
                [userId, provider]
            );

            if ((connections as any[]).length === 0) {
                return res.status(400).json({ success: false, message: 'Provider not connected' });
            }

            const { access_token } = (connections as any[])[0];
            const auth = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            auth.setCredentials({ access_token });

            const gmail = google.gmail({ version: 'v1', auth });
            const emailData = await gmail.users.messages.get({
                userId: 'me',
                id: id,
                format: 'full'
            });

            const email = parseGmailMessage(emailData.data);

            res.json({ success: true, email: email });
        } else {
            res.status(400).json({ success: false, message: 'Provider not supported' });
        }
    } catch (error) {
        console.error('Error getting email:', error);
        res.status(500).json({ success: false, message: 'Failed to get email' });
    }
};

// Mark email as read
export const markEmailAsRead = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { provider, id } = req.params;

        // Update local DB
        await mysqlPool.execute(
            'UPDATE nt_synced_emails SET is_read = true WHERE cuserid = ? AND provider = ? AND email_id = ?',
            [userId, provider, id]
        );

        // Update on Gmail
        if (provider === 'gmail') {
            const [connections] = await mysqlPool.execute(
                'SELECT access_token FROM nt_email_connections WHERE cuserid = ? AND provider = ?',
                [userId, provider]
            );

            if ((connections as any[]).length > 0) {
                const { access_token } = (connections as any[])[0];
                const auth = new google.auth.OAuth2(
                    process.env.GOOGLE_CLIENT_ID,
                    process.env.GOOGLE_CLIENT_SECRET
                );
                auth.setCredentials({ access_token });

                const gmail = google.gmail({ version: 'v1', auth });

                await gmail.users.messages.modify({
                    userId: 'me',
                    id: id,
                    requestBody: {
                        removeLabelIds: ['UNREAD']
                    }
                });
            }
        }

        res.json({ success: true, message: 'Email marked as read' });
    } catch (error) {
        console.error('Error marking email as read:', error);
        res.status(500).json({ success: false, message: 'Failed to mark as read' });
    }
};

// Sync emails (placeholder)
export const syncEmails = async (req: AuthRequest, res: Response) => {
    try {
        // Just call getGmailEmails to sync
        await getGmailEmails(req, res);
    } catch (error) {
        console.error('Error syncing emails:', error);
        res.status(500).json({ success: false, message: 'Failed to sync emails' });
    }
};

// Placeholder for other functions
export const markEmailAsStarred = async (req: AuthRequest, res: Response) => {
    res.json({ success: true, message: 'Feature coming soon' });
};

export const sendEmail = async (req: AuthRequest, res: Response) => {
    res.json({ success: true, message: 'Feature coming soon' });
};

export const deleteEmail = async (req: AuthRequest, res: Response) => {
    res.json({ success: true, message: 'Feature coming soon' });
};

export const testIMAPConnection = async (req: AuthRequest, res: Response) => {
    res.json({ success: true, message: 'Feature coming soon' });
};

export const connectIMAP = async (req: AuthRequest, res: Response) => {
    res.json({ success: true, message: 'Feature coming soon' });
};

export const disconnectEmail = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { provider } = req.params;

        await mysqlPool.execute(
            'UPDATE nt_email_connections SET connected = false WHERE cuserid = ? AND provider = ?',
            [userId, provider]
        );

        res.json({ success: true, message: 'Account disconnected successfully' });
    } catch (error) {
        console.error('Error disconnecting account:', error);
        res.status(500).json({ success: false, message: 'Failed to disconnect account' });
    }
};