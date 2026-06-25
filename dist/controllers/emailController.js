"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.disconnectEmail = exports.connectIMAP = exports.testIMAPConnection = exports.deleteEmail = exports.sendEmail = exports.markEmailAsStarred = exports.syncEmails = exports.markEmailAsRead = exports.getEmailById = exports.getGmailEmails = exports.checkOAuthStatus = exports.outlookCallback = exports.googleCallback = exports.initiateOAuth = exports.getConnectedAccounts = void 0;
const database_1 = require("../config/database");
const googleapis_1 = require("googleapis");
const mssql_1 = __importDefault(require("mssql"));
const OAuth2 = googleapis_1.google.auth.OAuth2;
// Google OAuth2 configuration
const googleOAuth2Client = new OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${process.env.APP_URL}/api/email/google/callback`);
// Helper function to parse Gmail message
function parseGmailMessage(message) {
    const headers = message.payload.headers;
    const getHeader = (name) => {
        const header = headers.find((h) => h.name === name);
        return header ? header.value : '';
    };
    const getBody = (part) => {
        if (part.mimeType === 'text/html' && part.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString();
        }
        if (part.mimeType === 'text/plain' && part.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString();
        }
        if (part.parts) {
            for (const subPart of part.parts) {
                const body = getBody(subPart);
                if (body)
                    return body;
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
// Store emails in database (SQL Server version)
async function storeEmailsInDB(userId, provider, emails) {
    const pool = await (0, database_1.getSQLServerPool)();
    for (const email of emails) {
        // Check if email exists
        const checkResult = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('provider', mssql_1.default.NVarChar, provider)
            .input('emailId', mssql_1.default.NVarChar, email.id)
            .query('SELECT id FROM nt_synced_emails WHERE cuserid = @userId AND provider = @provider AND email_id = @emailId');
        if (checkResult.recordset.length > 0) {
            // Update existing email
            await pool.request()
                .input('subject', mssql_1.default.NVarChar, email.subject || '')
                .input('body', mssql_1.default.NVarChar, email.body || '')
                .input('isRead', mssql_1.default.Bit, email.isRead ? 1 : 0)
                .input('isStarred', mssql_1.default.Bit, email.isStarred ? 1 : 0)
                .input('userId', mssql_1.default.Int, userId)
                .input('provider', mssql_1.default.NVarChar, provider)
                .input('emailId', mssql_1.default.NVarChar, email.id)
                .query(`
                    UPDATE nt_synced_emails 
                    SET subject = @subject, 
                        body = @body, 
                        is_read = @isRead, 
                        is_starred = @isStarred,
                        synced_at = GETDATE() 
                    WHERE cuserid = @userId AND provider = @provider AND email_id = @emailId
                `);
        }
        else {
            // Insert new email
            await pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .input('provider', mssql_1.default.NVarChar, provider)
                .input('emailId', mssql_1.default.NVarChar, email.id)
                .input('threadId', mssql_1.default.NVarChar, email.threadId || '')
                .input('fromEmail', mssql_1.default.NVarChar, email.from || '')
                .input('fromName', mssql_1.default.NVarChar, email.fromName || '')
                .input('toEmails', mssql_1.default.NVarChar, email.to || '')
                .input('subject', mssql_1.default.NVarChar, email.subject || '')
                .input('body', mssql_1.default.NVarChar, email.body || '')
                .input('isRead', mssql_1.default.Bit, email.isRead ? 1 : 0)
                .input('isStarred', mssql_1.default.Bit, email.isStarred ? 1 : 0)
                .input('receivedAt', mssql_1.default.DateTime, email.receivedAt)
                .query(`
                    INSERT INTO nt_synced_emails (cuserid, provider, email_id, thread_id, from_email, from_name, to_emails, subject, body, is_read, is_starred, received_at, synced_at)
                    VALUES (@userId, @provider, @emailId, @threadId, @fromEmail, @fromName, @toEmails, @subject, @body, @isRead, @isStarred, @receivedAt, GETDATE())
                `);
        }
    }
}
// Get connected accounts
const getConnectedAccounts = async (req, res) => {
    try {
        const userId = req.user.id;
        const pool = await (0, database_1.getSQLServerPool)();
        const result = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query(`
                SELECT provider, connected, email, connected_at 
                FROM nt_email_connections 
                WHERE cuserid = @userId
            `);
        const accountsMap = {
            gmail: false,
            outlook: false,
            icloud: false,
            imap: false
        };
        result.recordset.forEach(account => {
            accountsMap[account.provider] = account.connected === 1;
        });
        res.json({
            success: true,
            accounts: accountsMap
        });
    }
    catch (error) {
        console.error('Error getting connected accounts:', error);
        res.status(500).json({ success: false, message: 'Failed to get connected accounts' });
    }
};
exports.getConnectedAccounts = getConnectedAccounts;
// Initiate OAuth flow
const initiateOAuth = async (req, res) => {
    try {
        const { provider } = req.params;
        const userId = req.user.id;
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
    }
    catch (error) {
        console.error('Error initiating OAuth:', error);
        res.status(500).json({ success: false, message: 'Failed to initiate OAuth' });
    }
};
exports.initiateOAuth = initiateOAuth;
// Google OAuth callback
const googleCallback = async (req, res) => {
    try {
        const { code, state } = req.query;
        const userId = parseInt(state);
        const pool = await (0, database_1.getSQLServerPool)();
        const { tokens } = await googleOAuth2Client.getToken(code);
        // Check if connection exists
        const checkResult = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('provider', mssql_1.default.NVarChar, 'gmail')
            .query('SELECT id FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider');
        if (checkResult.recordset.length > 0) {
            // Update existing connection
            await pool.request()
                .input('accessToken', mssql_1.default.NVarChar, tokens.access_token)
                .input('refreshToken', mssql_1.default.NVarChar, tokens.refresh_token)
                .input('userId', mssql_1.default.Int, userId)
                .input('provider', mssql_1.default.NVarChar, 'gmail')
                .query(`
                    UPDATE nt_email_connections 
                    SET access_token = @accessToken, 
                        refresh_token = @refreshToken, 
                        connected = 1, 
                        connected_at = GETDATE() 
                    WHERE cuserid = @userId AND provider = @provider
                `);
        }
        else {
            // Insert new connection
            await pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .input('provider', mssql_1.default.NVarChar, 'gmail')
                .input('accessToken', mssql_1.default.NVarChar, tokens.access_token)
                .input('refreshToken', mssql_1.default.NVarChar, tokens.refresh_token)
                .query(`
                    INSERT INTO nt_email_connections (cuserid, provider, access_token, refresh_token, connected, connected_at)
                    VALUES (@userId, @provider, @accessToken, @refreshToken, 1, GETDATE())
                `);
        }
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
    }
    catch (error) {
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
exports.googleCallback = googleCallback;
// Outlook callback
const outlookCallback = async (req, res) => {
    try {
        const { code, state } = req.query;
        const userId = parseInt(state);
        const pool = await (0, database_1.getSQLServerPool)();
        const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.MICROSOFT_CLIENT_ID,
                client_secret: process.env.MICROSOFT_CLIENT_SECRET,
                code: code,
                redirect_uri: `${process.env.APP_URL}/api/email/outlook/callback`,
                grant_type: 'authorization_code'
            })
        });
        const tokens = await tokenResponse.json();
        // Check if connection exists
        const checkResult = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('provider', mssql_1.default.NVarChar, 'outlook')
            .query('SELECT id FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider');
        if (checkResult.recordset.length > 0) {
            await pool.request()
                .input('accessToken', mssql_1.default.NVarChar, tokens.access_token)
                .input('refreshToken', mssql_1.default.NVarChar, tokens.refresh_token)
                .input('userId', mssql_1.default.Int, userId)
                .input('provider', mssql_1.default.NVarChar, 'outlook')
                .query(`
                    UPDATE nt_email_connections 
                    SET access_token = @accessToken, 
                        refresh_token = @refreshToken, 
                        connected = 1, 
                        connected_at = GETDATE() 
                    WHERE cuserid = @userId AND provider = @provider
                `);
        }
        else {
            await pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .input('provider', mssql_1.default.NVarChar, 'outlook')
                .input('accessToken', mssql_1.default.NVarChar, tokens.access_token)
                .input('refreshToken', mssql_1.default.NVarChar, tokens.refresh_token)
                .query(`
                    INSERT INTO nt_email_connections (cuserid, provider, access_token, refresh_token, connected, connected_at)
                    VALUES (@userId, @provider, @accessToken, @refreshToken, 1, GETDATE())
                `);
        }
        res.redirect(`${process.env.FRONTEND_URL}/settings/email?success=true&provider=outlook`);
    }
    catch (error) {
        console.error('Error in Outlook callback:', error);
        res.redirect(`${process.env.FRONTEND_URL}/settings/email?error=true`);
    }
};
exports.outlookCallback = outlookCallback;
// Check OAuth status
const checkOAuthStatus = async (req, res) => {
    try {
        const { provider } = req.params;
        const userId = req.user.id;
        const pool = await (0, database_1.getSQLServerPool)();
        const result = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('provider', mssql_1.default.NVarChar, provider)
            .query('SELECT connected FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider');
        const completed = result.recordset.length > 0 && result.recordset[0].connected === 1;
        res.json({ success: true, completed });
    }
    catch (error) {
        console.error('Error checking OAuth status:', error);
        res.status(500).json({ success: false, message: 'Failed to check status' });
    }
};
exports.checkOAuthStatus = checkOAuthStatus;
// Get Gmail emails
const getGmailEmails = async (req, res) => {
    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const maxResults = limit;
        const pool = await (0, database_1.getSQLServerPool)();
        console.log(`📧 Getting emails for user ${userId}, page ${page}, limit ${limit}`);
        // Get user's Gmail tokens
        const connectionResult = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('provider', mssql_1.default.NVarChar, 'gmail')
            .query('SELECT access_token, refresh_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider AND connected = 1');
        if (connectionResult.recordset.length === 0) {
            return res.status(400).json({ success: false, message: 'Gmail not connected' });
        }
        const { access_token, refresh_token } = connectionResult.recordset[0];
        // Set up Gmail API client
        const auth = new googleapis_1.google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
        auth.setCredentials({
            access_token: access_token,
            refresh_token: refresh_token
        });
        const gmail = googleapis_1.google.gmail({ version: 'v1', auth });
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
                    id: message.id,
                    format: 'full'
                });
                emails.push(parseGmailMessage(emailData.data));
            }
            catch (err) {
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
    }
    catch (error) {
        console.error('Error getting Gmail emails:', error);
        res.status(500).json({ success: false, message: 'Failed to get emails', error: String(error) });
    }
};
exports.getGmailEmails = getGmailEmails;
// Get email by ID
const getEmailById = async (req, res) => {
    try {
        const userId = req.user.id;
        const { provider, id } = req.params;
        const pool = await (0, database_1.getSQLServerPool)();
        // Check if email exists in local DB
        const localResult = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('provider', mssql_1.default.NVarChar, provider)
            .input('emailId', mssql_1.default.NVarChar, id)
            .query('SELECT * FROM nt_synced_emails WHERE cuserid = @userId AND provider = @provider AND email_id = @emailId');
        if (localResult.recordset.length > 0) {
            return res.json({
                success: true,
                email: localResult.recordset[0]
            });
        }
        // Fetch from Gmail API
        if (provider === 'gmail') {
            const connectionResult = await pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .input('provider', mssql_1.default.NVarChar, provider)
                .query('SELECT access_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider');
            if (connectionResult.recordset.length === 0) {
                return res.status(400).json({ success: false, message: 'Provider not connected' });
            }
            const { access_token } = connectionResult.recordset[0];
            const auth = new googleapis_1.google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
            auth.setCredentials({ access_token });
            const gmail = googleapis_1.google.gmail({ version: 'v1', auth });
            const emailData = await gmail.users.messages.get({
                userId: 'me',
                id: id,
                format: 'full'
            });
            const email = parseGmailMessage(emailData.data);
            res.json({ success: true, email: email });
        }
        else {
            res.status(400).json({ success: false, message: 'Provider not supported' });
        }
    }
    catch (error) {
        console.error('Error getting email:', error);
        res.status(500).json({ success: false, message: 'Failed to get email' });
    }
};
exports.getEmailById = getEmailById;
// Mark email as read
const markEmailAsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const { provider, id } = req.params;
        const pool = await (0, database_1.getSQLServerPool)();
        // Update local DB
        await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('provider', mssql_1.default.NVarChar, provider)
            .input('emailId', mssql_1.default.NVarChar, id)
            .query('UPDATE nt_synced_emails SET is_read = 1 WHERE cuserid = @userId AND provider = @provider AND email_id = @emailId');
        // Update on Gmail
        if (provider === 'gmail') {
            const connectionResult = await pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .input('provider', mssql_1.default.NVarChar, provider)
                .query('SELECT access_token FROM nt_email_connections WHERE cuserid = @userId AND provider = @provider');
            if (connectionResult.recordset.length > 0) {
                const { access_token } = connectionResult.recordset[0];
                const auth = new googleapis_1.google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
                auth.setCredentials({ access_token });
                const gmail = googleapis_1.google.gmail({ version: 'v1', auth });
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
    }
    catch (error) {
        console.error('Error marking email as read:', error);
        res.status(500).json({ success: false, message: 'Failed to mark as read' });
    }
};
exports.markEmailAsRead = markEmailAsRead;
// Sync emails (placeholder)
const syncEmails = async (req, res) => {
    try {
        // Just call getGmailEmails to sync
        await (0, exports.getGmailEmails)(req, res);
    }
    catch (error) {
        console.error('Error syncing emails:', error);
        res.status(500).json({ success: false, message: 'Failed to sync emails' });
    }
};
exports.syncEmails = syncEmails;
// Placeholder for other functions
const markEmailAsStarred = async (req, res) => {
    res.json({ success: true, message: 'Feature coming soon' });
};
exports.markEmailAsStarred = markEmailAsStarred;
const sendEmail = async (req, res) => {
    res.json({ success: true, message: 'Feature coming soon' });
};
exports.sendEmail = sendEmail;
const deleteEmail = async (req, res) => {
    res.json({ success: true, message: 'Feature coming soon' });
};
exports.deleteEmail = deleteEmail;
const testIMAPConnection = async (req, res) => {
    res.json({ success: true, message: 'Feature coming soon' });
};
exports.testIMAPConnection = testIMAPConnection;
const connectIMAP = async (req, res) => {
    res.json({ success: true, message: 'Feature coming soon' });
};
exports.connectIMAP = connectIMAP;
const disconnectEmail = async (req, res) => {
    try {
        const userId = req.user.id;
        const { provider } = req.params;
        const pool = await (0, database_1.getSQLServerPool)();
        await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('provider', mssql_1.default.NVarChar, provider)
            .query('UPDATE nt_email_connections SET connected = 0 WHERE cuserid = @userId AND provider = @provider');
        res.json({ success: true, message: 'Account disconnected successfully' });
    }
    catch (error) {
        console.error('Error disconnecting account:', error);
        res.status(500).json({ success: false, message: 'Failed to disconnect account' });
    }
};
exports.disconnectEmail = disconnectEmail;
//# sourceMappingURL=emailController.js.map