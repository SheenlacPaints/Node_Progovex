import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { executeQuery, executeNonQuery, executeTransaction } from '../config/database';
import { google } from 'googleapis';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import sql from 'mssql';

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

// Store emails in SQL Server database
async function storeEmailsInDB(userId: number, provider: string, emails: any[]): Promise<void> {
    for (const email of emails) {
        // Use MERGE for upsert operation in SQL Server
        await executeNonQuery(
            `MERGE nt_synced_emails AS target
             USING (SELECT @userId AS cuserid, @provider AS provider, @emailId AS email_id) AS source
             ON target.cuserid = source.cuserid 
                AND target.provider = source.provider 
                AND target.email_id = source.email_id
             WHEN MATCHED THEN
                UPDATE SET 
                    subject = @subject,
                    body = @body,
                    is_read = @isRead,
                    is_starred = @isStarred,
                    synced_at = GETDATE()
             WHEN NOT MATCHED THEN
                INSERT (cuserid, provider, email_id, thread_id, from_email, from_name, to_emails, subject, body, is_read, is_starred, received_at, synced_at)
                VALUES (@userId, @provider, @emailId, @threadId, @fromEmail, @fromName, @toEmails, @subject, @body, @isRead, @isStarred, @receivedAt, GETDATE());`,
            {
                userId,
                provider,
                emailId: email.id,
                threadId: email.threadId,
                fromEmail: email.from,
                fromName: email.fromName,
                toEmails: email.to,
                subject: email.subject,
                body: email.body,
                isRead: email.isRead ? 1 : 0,
                isStarred: email.isStarred ? 1 : 0,
                receivedAt: email.receivedAt
            }
        );
    }
}

// Get connected accounts
export const getConnectedAccounts = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        const accounts = await executeQuery<any>(
            `SELECT provider, connected, email, connected_at 
             FROM nt_email_connections 
             WHERE cuserid = @userId`,
            { userId }
        );

        const accountsMap: any = {
            gmail: false,
            outlook: false,
            icloud: false,
            imap: false
        };

        accounts.forEach(account => {
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

        // Use MERGE for upsert in SQL Server
        await executeNonQuery(
            `MERGE nt_email_connections AS target
             USING (SELECT @userId AS cuserid, 'gmail' AS provider) AS source
             ON target.cuserid = source.cuserid AND target.provider = source.provider
             WHEN MATCHED THEN
                UPDATE SET 
                    access_token = @accessToken,
                    refresh_token = @refreshToken,
                    connected = 1,
                    connected_at = GETDATE()
             WHEN NOT MATCHED THEN
                INSERT (cuserid, provider, access_token, refresh_token, connected, connected_at)
                VALUES (@userId, 'gmail', @accessToken, @refreshToken, 1, GETDATE());`,
            {
                userId,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token
            }
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

        await executeNonQuery(
            `MERGE nt_email_connections AS target
             USING (SELECT @userId AS cuserid, 'outlook' AS provider) AS source
             ON target.cuserid = source.cuserid AND target.provider = source.provider
             WHEN MATCHED THEN
                UPDATE SET 
                    access_token = @accessToken,
                    refresh_token = @refreshToken,
                    connected = 1,
                    connected_at = GETDATE()
             WHEN NOT MATCHED THEN
                INSERT (cuserid, provider, access_token, refresh_token, connected, connected_at)
                VALUES (@userId, 'outlook', @accessToken, @refreshToken, 1, GETDATE());`,
            {
                userId,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token
            }
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

        const connections = await executeQuery<any>(
            'SELECT connected FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider',
            { userId, provider }
        );

        const completed = connections && connections.length > 0 && connections[0].connected === 1;

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
        const connections = await executeQuery<any>(
            'SELECT access_token, refresh_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider AND connected = 1',
            { userId, provider: 'gmail' }
        );

        if (!connections || connections.length === 0) {
            return res.status(400).json({ success: false, message: 'Gmail not connected' });
        }

        const { access_token, refresh_token } = connections[0];

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
        const localEmails = await executeQuery<any>(
            'SELECT * FROM nt_synced_emails WHERE cuserid = @userId AND provider = @provider AND email_id = @emailId',
            { userId, provider, emailId: id }
        );

        if (localEmails && localEmails.length > 0) {
            return res.json({
                success: true,
                email: localEmails[0]
            });
        }

        // Fetch from Gmail API
        if (provider === 'gmail') {
            const connections = await executeQuery<any>(
                'SELECT access_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider',
                { userId, provider }
            );

            if (!connections || connections.length === 0) {
                return res.status(400).json({ success: false, message: 'Provider not connected' });
            }

            const { access_token } = connections[0];
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
        await executeNonQuery(
            'UPDATE nt_synced_emails SET is_read = 1 WHERE cuserid = @userId AND provider = @provider AND email_id = @emailId',
            { userId, provider, emailId: id }
        );

        // Update on Gmail
        if (provider === 'gmail') {
            const connections = await executeQuery<any>(
                'SELECT access_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider',
                { userId, provider }
            );

            if (connections && connections.length > 0) {
                const { access_token } = connections[0];
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

// Mark email as starred
export const markEmailAsStarred = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { provider, id } = req.params;
        const { starred } = req.body;

        // Update local DB
        await executeNonQuery(
            'UPDATE nt_synced_emails SET is_starred = @starred WHERE cuserid = @userId AND provider = @provider AND email_id = @emailId',
            {
                userId,
                provider,
                emailId: id,
                starred: starred ? 1 : 0
            }
        );

        // Update on Gmail
        if (provider === 'gmail') {
            const connections = await executeQuery<any>(
                'SELECT access_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider',
                { userId, provider }
            );

            if (connections && connections.length > 0) {
                const { access_token } = connections[0];
                const auth = new google.auth.OAuth2(
                    process.env.GOOGLE_CLIENT_ID,
                    process.env.GOOGLE_CLIENT_SECRET
                );
                auth.setCredentials({ access_token });

                const gmail = google.gmail({ version: 'v1', auth });

                const modifyBody: any = {};
                if (starred) {
                    modifyBody.addLabelIds = ['STARRED'];
                } else {
                    modifyBody.removeLabelIds = ['STARRED'];
                }

                await gmail.users.messages.modify({
                    userId: 'me',
                    id: id,
                    requestBody: modifyBody
                });
            }
        }

        res.json({
            success: true,
            message: starred ? 'Email starred' : 'Email unstarred'
        });
    } catch (error) {
        console.error('Error marking email as starred:', error);
        res.status(500).json({ success: false, message: 'Failed to mark as starred' });
    }
};

// Send email
export const sendEmail = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { provider, to, subject, body, cc, bcc } = req.body;

        if (provider === 'gmail') {
            const connections = await executeQuery<any>(
                'SELECT access_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider AND connected = 1',
                { userId, provider: 'gmail' }
            );

            if (!connections || connections.length === 0) {
                return res.status(400).json({ success: false, message: 'Gmail not connected' });
            }

            const { access_token } = connections[0];
            const auth = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            auth.setCredentials({ access_token });

            const gmail = google.gmail({ version: 'v1', auth });

            // Construct email
            const emailLines = [
                `From: me`,
                `To: ${to}`,
                cc ? `Cc: ${cc}` : '',
                bcc ? `Bcc: ${bcc}` : '',
                `Subject: ${subject}`,
                '',
                body
            ];

            const email = emailLines.filter(line => line).join('\r\n');
            const encodedEmail = Buffer.from(email)
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const result = await gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedEmail
                }
            });

            // Log email sent
            await executeNonQuery(
                `INSERT INTO nt_email_logs (cuserid, provider, to_email, subject, sent_at)
                 VALUES (@userId, @provider, @to, @subject, GETDATE())`,
                { userId, provider, to, subject }
            );

            res.json({
                success: true,
                message: 'Email sent successfully',
                messageId: result.data.id
            });
        } else {
            res.status(400).json({ success: false, message: 'Provider not supported' });
        }
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({ success: false, message: 'Failed to send email' });
    }
};

// Delete email
export const deleteEmail = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { provider, id } = req.params;

        // Delete from local DB
        await executeNonQuery(
            'DELETE FROM nt_synced_emails WHERE cuserid = @userId AND provider = @provider AND email_id = @emailId',
            { userId, provider, emailId: id }
        );

        // Delete from Gmail
        if (provider === 'gmail') {
            const connections = await executeQuery<any>(
                'SELECT access_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider',
                { userId, provider }
            );

            if (connections && connections.length > 0) {
                const { access_token } = connections[0];
                const auth = new google.auth.OAuth2(
                    process.env.GOOGLE_CLIENT_ID,
                    process.env.GOOGLE_CLIENT_SECRET
                );
                auth.setCredentials({ access_token });

                const gmail = google.gmail({ version: 'v1', auth });

                await gmail.users.messages.trash({
                    userId: 'me',
                    id: id
                });
            }
        }

        res.json({ success: true, message: 'Email deleted successfully' });
    } catch (error) {
        console.error('Error deleting email:', error);
        res.status(500).json({ success: false, message: 'Failed to delete email' });
    }
};

// Test IMAP connection
export const testIMAPConnection = async (req: AuthRequest, res: Response) => {
    try {
        const { host, port, username, password } = req.body;

        return new Promise((resolve, reject) => {
            const imap = new Imap({
                user: username,
                password: password,
                host: host,
                port: parseInt(port),
                tls: true,
                tlsOptions: { rejectUnauthorized: false }
            });

            imap.once('ready', () => {
                imap.end();
                res.json({ success: true, message: 'IMAP connection successful' });
                resolve(true);
            });

            imap.once('error', (err) => {
                res.status(400).json({
                    success: false,
                    message: 'IMAP connection failed',
                    error: err.message
                });
                resolve(false);
            });

            imap.connect();
        });
    } catch (error) {
        console.error('Error testing IMAP:', error);
        res.status(500).json({ success: false, message: 'Failed to test IMAP connection' });
    }
};

// Connect IMAP
export const connectIMAP = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { host, port, username, password, email } = req.body;

        // Store IMAP connection details
        await executeNonQuery(
            `MERGE nt_email_connections AS target
             USING (SELECT @userId AS cuserid, 'imap' AS provider) AS source
             ON target.cuserid = source.cuserid AND target.provider = source.provider
             WHEN MATCHED THEN
                UPDATE SET 
                    access_token = @password,
                    email = @email,
                    connected = 1,
                    connected_at = GETDATE()
             WHEN NOT MATCHED THEN
                INSERT (cuserid, provider, access_token, email, connected, connected_at)
                VALUES (@userId, 'imap', @password, @email, 1, GETDATE());`,
            {
                userId,
                password,
                email
            }
        );

        // Store IMAP config in a separate table (assuming it exists)
        await executeNonQuery(
            `MERGE nt_imap_config AS target
             USING (SELECT @userId AS cuserid) AS source
             ON target.cuserid = source.cuserid
             WHEN MATCHED THEN
                UPDATE SET 
                    imap_host = @host,
                    imap_port = @port,
                    imap_username = @username,
                    updated_at = GETDATE()
             WHEN NOT MATCHED THEN
                INSERT (cuserid, imap_host, imap_port, imap_username)
                VALUES (@userId, @host, @port, @username);`,
            { userId, host, port, username }
        );

        res.json({ success: true, message: 'IMAP connected successfully' });
    } catch (error) {
        console.error('Error connecting IMAP:', error);
        res.status(500).json({ success: false, message: 'Failed to connect IMAP' });
    }
};

// Disconnect email
export const disconnectEmail = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { provider } = req.params;

        await executeNonQuery(
            'UPDATE nt_email_connections SET connected = 0 WHERE cuserid = @userId AND provider = @provider',
            { userId, provider }
        );

        res.json({ success: true, message: 'Account disconnected successfully' });
    } catch (error) {
        console.error('Error disconnecting account:', error);
        res.status(500).json({ success: false, message: 'Failed to disconnect account' });
    }
};

// Get email sync status
export const getEmailSyncStatus = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        const stats = await executeQuery<any>(
            `SELECT 
                provider,
                COUNT(*) as total_emails,
                SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread_count,
                MAX(synced_at) as last_sync
             FROM nt_synced_emails
             WHERE cuserid = @userId
             GROUP BY provider`,
            { userId }
        );

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error getting email sync status:', error);
        res.status(500).json({ success: false, message: 'Failed to get sync status' });
    }
};

// Search emails
export const searchEmails = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { q, provider, limit = 20, offset = 0 } = req.query;

        let query = `
            SELECT * FROM nt_synced_emails 
            WHERE cuserid = @userId
        `;
        const params: any = { userId };

        if (provider) {
            query += ` AND provider = @provider`;
            params.provider = provider;
        }

        if (q) {
            query += ` AND (subject LIKE @searchTerm OR body LIKE @searchTerm OR from_email LIKE @searchTerm)`;
            params.searchTerm = `%${q}%`;
        }

        query += ` ORDER BY received_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
        params.offset = parseInt(offset as string);
        params.limit = parseInt(limit as string);

        const emails = await executeQuery<any>(query, params);

        // Get total count
        let countQuery = `
            SELECT COUNT(*) as total FROM nt_synced_emails 
            WHERE cuserid = @userId
        `;
        const countParams: any = { userId };

        if (provider) {
            countQuery += ` AND provider = @provider`;
            countParams.provider = provider;
        }

        if (q) {
            countQuery += ` AND (subject LIKE @searchTerm OR body LIKE @searchTerm OR from_email LIKE @searchTerm)`;
            countParams.searchTerm = `%${q}%`;
        }

        const totalResult = await executeQuery<any>(countQuery, countParams);
        const total = totalResult[0]?.total || 0;

        res.json({
            success: true,
            emails,
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string)
        });
    } catch (error) {
        console.error('Error searching emails:', error);
        res.status(500).json({ success: false, message: 'Failed to search emails' });
    }
};