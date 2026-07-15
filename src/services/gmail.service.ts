// backend/src/services/gmail.service.ts

import { google } from 'googleapis';

export class GmailService {
    private oauth2Client: any;
    private gmail: any;

    constructor() {
        const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/node/api/gmail/callback';

        this.oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            redirectUri
        );

        this.gmail = google.gmail({
            version: 'v1',
            auth: this.oauth2Client
        });
    }

    /**
     * Get OAuth2 client instance
     */
    getOAuth2Client(): any {
        return this.oauth2Client;
    }

    /**
     * Get auth URL for Gmail
     */
    getAuthUrl(cuserid: string, forceReauth: boolean = false, promptConsent: boolean = false): string {
        // Full set of scopes needed
        const scopes = [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.compose',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.labels',
            'https://www.googleapis.com/auth/gmail.metadata',
            'https://www.googleapis.com/auth/gmail.settings.basic',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ];

        const stateData = JSON.stringify({ cuserid });
        const state = Buffer.from(stateData).toString('base64');

        console.log('State encoded:', { original: stateData, encoded: state });

        // Build auth URL options
        const authOptions: any = {
            access_type: 'offline',
            scope: scopes,
            state: state,
            include_granted_scopes: true
        };

        // Force consent if needed
        if (forceReauth || promptConsent) {
            authOptions.prompt = 'consent';
            authOptions.access_type = 'offline';
        }

        console.log('Auth options:', authOptions);

        return this.oauth2Client.generateAuthUrl(authOptions);
    }

    /**
     * Get tokens from authorization code
     */
    async getTokens(code: string) {
        try {
            const { tokens } = await this.oauth2Client.getToken(code);
            this.oauth2Client.setCredentials(tokens);
            return tokens;
        } catch (error) {
            console.error('Error getting tokens:', error);
            throw new Error('Failed to get tokens');
        }
    }

    /**
     * Set user credentials
     */
    setUserCredentials(tokens: any) {
        this.setCredentials(tokens);
    }

    /**
     * Set credentials
     */
    setCredentials(tokens: any) {
        this.oauth2Client.setCredentials({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expiry_date: tokens.expiry_date
        });
    }

    /**
     * Refresh token
     */
    async refreshToken(refreshToken: string) {
        try {
            this.oauth2Client.setCredentials({
                refresh_token: refreshToken
            });

            const { credentials } = await this.oauth2Client.refreshAccessToken();
            return credentials;
        } catch (error) {
            console.error('Error refreshing token:', error);
            throw new Error('Failed to refresh token');
        }
    }

    /**
     * Refresh user token (alias for refreshToken)
     */
    async refreshUserToken(refreshToken: string): Promise<any> {
        return this.refreshToken(refreshToken);
    }

    /**
     * Get email fast (metadata only)
     */
    async getEmailFast(messageId: string) {
        try {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Timeout fetching email ${messageId}`)), 3000);
            });

            const fetchPromise = this.gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'metadata',
                metadataHeaders: ['From', 'To', 'Subject', 'Date']
            });

            const response = await Promise.race([fetchPromise, timeoutPromise]);

            const message = response.data;
            const headers = this.extractHeaders(message);

            const fromHeader = headers['from'] || '';
            const fromMatch = fromHeader.match(/(.+?)?\s*<(.+?)>/);

            return {
                id: message.id,
                threadId: message.threadId,
                from: fromMatch ? {
                    name: fromMatch[1]?.trim() || '',
                    email: fromMatch[2]
                } : {
                    name: fromHeader,
                    email: fromHeader
                },
                to: this.parseRecipients(headers['to']),
                cc: this.parseRecipients(headers['cc']),
                bcc: this.parseRecipients(headers['bcc']),
                subject: headers['subject'] || '(No Subject)',
                snippet: message.snippet || '',
                date: headers['date'] ? new Date(headers['date']) : new Date(),
                isRead: !(message.labelIds || []).includes('UNREAD'),
                isStarred: (message.labelIds || []).includes('STARRED'),
                hasAttachments: false,
                labels: message.labelIds || [],
                sizeEstimate: message.sizeEstimate || 0,
                body: null
            };
        } catch (error) {
            console.error(`Error fetching email fast ${messageId}:`, error);
            return {
                id: messageId,
                threadId: null,
                from: { name: 'Unknown', email: 'unknown@example.com' },
                to: [],
                cc: [],
                bcc: [],
                subject: '(Unable to load)',
                snippet: 'Failed to load email content',
                date: new Date(),
                isRead: true,
                isStarred: false,
                hasAttachments: false,
                labels: [],
                sizeEstimate: 0,
                body: null,
                error: true
            };
        }
    }

    /**
     * Extract headers from message
     */
    private extractHeaders(message: any): Record<string, string> {
        const headers: Record<string, string> = {};
        if (message.payload?.headers) {
            for (const header of message.payload.headers) {
                if (header.name && header.value) {
                    headers[header.name.toLowerCase()] = header.value;
                }
            }
        }
        return headers;
    }

    /**
     * Parse recipients from header
     */
    private parseRecipients(header: string): string[] {
        if (!header) return [];
        const recipients: string[] = [];
        const parts = header.split(',');
        for (const part of parts) {
            const match = part.match(/(.+?)?\s*<(.+?)>/);
            if (match) {
                recipients.push(match[2].trim());
            } else {
                const email = part.trim();
                if (email) recipients.push(email);
            }
        }
        return recipients;
    }

    /**
     * Get full email
     */
    async getEmail(messageId: string) {
        try {
            const response = await this.gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full'
            });

            return this.parseEmail(response.data);
        } catch (error) {
            console.error('Error fetching email:', error);
            throw new Error('Failed to fetch email');
        }
    }

    /**
     * Parse email from Gmail API response
     */
    private parseEmail(message: any) {
        const headers: Record<string, string> = {};
        let subject = '(No Subject)';
        let from = { name: '', email: '' };
        let to: string[] = [];
        let cc: string[] = [];
        let bcc: string[] = [];
        let date = '';
        let body = '';
        let snippet = message.snippet || '';

        if (message.payload?.headers) {
            for (const header of message.payload.headers) {
                if (header.name && header.value) {
                    headers[header.name.toLowerCase()] = header.value;
                }
            }
        }

        subject = headers['subject'] || '(No Subject)';
        date = headers['date'] || '';

        const fromHeader = headers['from'] || '';
        const fromMatch = fromHeader.match(/(.+?)?\s*<(.+?)>/);
        if (fromMatch) {
            from = { name: fromMatch[1]?.trim() || '', email: fromMatch[2] };
        } else {
            from = { name: fromHeader, email: fromHeader };
        }

        const toHeader = headers['to'] || '';
        to = this.parseRecipients(toHeader);

        const ccHeader = headers['cc'] || '';
        if (ccHeader) {
            cc = this.parseRecipients(ccHeader);
        }

        const bccHeader = headers['bcc'] || '';
        if (bccHeader) {
            bcc = this.parseRecipients(bccHeader);
        }

        if (message.payload) {
            body = this.extractBody(message.payload);
        }

        const attachments = this.extractAttachments(message);
        const labels = message.labelIds || [];

        return {
            id: message.id,
            threadId: message.threadId,
            from,
            to,
            cc,
            bcc,
            subject,
            snippet,
            body,
            date: date ? new Date(date) : new Date(),
            isRead: !labels.includes('UNREAD'),
            isStarred: labels.includes('STARRED'),
            hasAttachments: attachments.length > 0,
            attachments,
            labels,
            sizeEstimate: message.sizeEstimate || 0,
            historyId: message.historyId,
            createdAt: date ? new Date(date) : new Date()
        };
    }

    /**
     * Extract body from email payload
     */
    private extractBody(payload: any): string {
        let body = '';

        if (payload.body?.data) {
            body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
        }

        if (payload.parts) {
            for (const part of payload.parts) {
                if (part.mimeType === 'text/plain' && part.body?.data) {
                    body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                    break;
                }
                if (part.mimeType === 'text/html' && part.body?.data && !body) {
                    const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
                    body = html;
                }
            }
        }

        return body;
    }

    /**
     * Extract attachments from email
     */
    private extractAttachments(message: any): any[] {
        const attachments: any[] = [];

        if (message.payload?.parts) {
            for (const part of message.payload.parts) {
                if (part.filename && part.body?.attachmentId) {
                    attachments.push({
                        attachmentId: part.body.attachmentId,
                        filename: part.filename,
                        mimeType: part.mimeType,
                        size: part.body.size || 0
                    });
                }
            }
        }

        return attachments;
    }

    /**
     * Get attachment
     */
    async getAttachment(messageId: string, attachmentId: string) {
        try {
            const response = await this.gmail.users.messages.attachments.get({
                userId: 'me',
                messageId,
                id: attachmentId
            });

            const data = response.data.data || '';
            const buffer = Buffer.from(data, 'base64');

            return buffer;
        } catch (error) {
            console.error('Error downloading attachment:', error);
            throw new Error('Failed to download attachment');
        }
    }

    /**
     * Send email
     */
    async sendEmail(
        to: string[],
        subject: string,
        body: string,
        cc?: string[],
        bcc?: string[],
        attachments?: { filename: string; content: Buffer; mimeType: string }[]
    ) {
        try {
            let emailParts = [
                `To: ${to.join(', ')}`,
                `Subject: ${subject}`,
                `MIME-Version: 1.0`,
                `Content-Type: multipart/mixed; boundary="boundary"`,
                '',
                '--boundary',
                `Content-Type: text/html; charset="UTF-8"`,
                'Content-Transfer-Encoding: quoted-printable',
                '',
                body,
                ''
            ];

            if (cc && cc.length > 0) {
                emailParts.splice(1, 0, `Cc: ${cc.join(', ')}`);
            }

            if (bcc && bcc.length > 0) {
                emailParts.splice(2, 0, `Bcc: ${bcc.join(', ')}`);
            }

            if (attachments && attachments.length > 0) {
                for (const att of attachments) {
                    emailParts.push('--boundary');
                    emailParts.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
                    emailParts.push('Content-Transfer-Encoding: base64');
                    emailParts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
                    emailParts.push('');
                    emailParts.push(att.content.toString('base64'));
                }
            }

            emailParts.push('--boundary--');

            const emailString = emailParts.join('\r\n');
            const encodedEmail = Buffer.from(emailString, 'utf-8').toString('base64url');

            const response = await this.gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedEmail
                }
            });

            return response.data;
        } catch (error) {
            console.error('Error sending email:', error);
            throw new Error('Failed to send email');
        }
    }

    /**
     * Get labels
     */
    async getLabels() {
        try {
            const response = await this.gmail.users.labels.list({
                userId: 'me'
            });
            return response.data.labels || [];
        } catch (error) {
            console.error('Error fetching labels:', error);
            throw new Error('Failed to fetch labels');
        }
    }

    /**
     * Create label
     */
    async createLabel(name: string, labelColor?: string) {
        try {
            const response = await this.gmail.users.labels.create({
                userId: 'me',
                requestBody: {
                    name: name,
                    labelListVisibility: 'labelShow',
                    messageListVisibility: 'show',
                    color: labelColor ? {
                        backgroundColor: labelColor,
                        textColor: this.getContrastColor(labelColor)
                    } : undefined
                }
            });
            return response.data;
        } catch (error) {
            console.error('Error creating label:', error);
            throw new Error('Failed to create label');
        }
    }

    /**
     * Add label to email
     */
    async addLabel(messageId: string, labelId: string) {
        try {
            const response = await this.gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    addLabelIds: [labelId]
                }
            });
            return response.data;
        } catch (error) {
            console.error('Error adding label:', error);
            throw new Error('Failed to add label');
        }
    }

    /**
     * Remove label from email
     */
    async removeLabel(messageId: string, labelId: string) {
        try {
            const response = await this.gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    removeLabelIds: [labelId]
                }
            });
            return response.data;
        } catch (error) {
            console.error('Error removing label:', error);
            throw new Error('Failed to remove label');
        }
    }

    /**
     * Search emails
     */
    async searchEmails(query: string, maxResults: number = 50, pageToken?: string) {
        try {
            const response = await this.gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults,
                pageToken: pageToken || undefined,
            });

            const messages = response.data.messages || [];
            const emails = [];

            for (const message of messages) {
                if (message.id) {
                    const email = await this.getEmail(message.id);
                    emails.push(email);
                }
            }

            return {
                emails,
                nextPageToken: response.data.nextPageToken || null,
                resultSizeEstimate: response.data.resultSizeEstimate || 0
            };
        } catch (error) {
            console.error('Error searching emails:', error);
            throw new Error('Failed to search emails');
        }
    }

    /**
     * Get contrast color for label
     */
    private getContrastColor(hexColor: string): string {
        const hex = hexColor.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance > 0.5 ? '#000000' : '#FFFFFF';
    }

    /**
     * Get emails in batch
     */
    async getEmailsBatch(
        userId: string,
        messageIds: string[],
        batchSize: number = 10
    ): Promise<any[]> {
        const emails: any[] = [];

        for (let i = 0; i < messageIds.length; i += batchSize) {
            const batch = messageIds.slice(i, i + batchSize);
            const batchPromises = batch.map(id => this.getEmailFast(id));
            const batchResults = await Promise.all(batchPromises);
            emails.push(...batchResults);
        }

        return emails;
    }

    /**
     * Get count of emails in a specific folder/label
     */
    async getFolderCount(label: string): Promise<number> {
        try {
            const response = await this.gmail.users.messages.list({
                userId: 'me',
                q: `label:${label}`,
                maxResults: 1
            });

            return response.data.resultSizeEstimate || 0;
        } catch (error) {
            console.error(`Error getting count for label ${label}:`, error);
            return 0;
        }
    }

    /**
     * Get emails optimized for bulk sync
     */
    async getEmailsOptimized(
        userId: string,
        pageToken?: string,
        maxResults: number = 100,
        labels: string[] = ['INBOX'],
        query?: string
    ): Promise<any> {
        try {
            // Build the query string
            let q = query || '';

            // Add label filter using label names
            if (labels && labels.length > 0) {
                const labelQueries = labels.map(label => `label:${label}`);
                if (q) {
                    q = `(${q}) AND (${labelQueries.join(' OR ')})`;
                } else {
                    q = labelQueries.join(' OR ');
                }
            }

            console.log(`Gmail API query: ${q}`);

            // Use q parameter for filtering (label:NAME format works with proper scopes)
            const response = await this.gmail.users.messages.list({
                userId: 'me',
                q: q, // Use q for filtering with label:NAME format
                maxResults: Math.min(maxResults, 500),
                pageToken: pageToken
            });

            const messages = response.data.messages || [];
            const emails = [];

            // Process emails in parallel with concurrency limit
            const batchSize = 10;
            for (let i = 0; i < messages.length; i += batchSize) {
                const batch = messages.slice(i, i + batchSize);
                const batchPromises = batch.map(async (message: any) => {
                    try {
                        return await this.getEmail(message.id);
                    } catch (error) {
                        console.error(`Error fetching email ${message.id}:`, error);
                        return null;
                    }
                });

                const batchResults = await Promise.all(batchPromises);
                const validResults = batchResults.filter(result => result !== null);
                emails.push(...validResults);
            }

            return {
                emails: emails,
                nextPageToken: response.data.nextPageToken,
                resultSizeEstimate: response.data.resultSizeEstimate || emails.length
            };
        } catch (error: any) {
            console.error('Error getting emails optimized:', error);

            // Check if it's a scope error
            if (error?.status === 403 && error?.response?.data?.error?.message?.includes('scope')) {
                throw new Error('INSUFFICIENT_SCOPES: Please reconnect your Gmail account with full permissions');
            }

            throw error;
        }
    }

    /**
     * Get user profile
     */
    async getUserProfile(): Promise<any> {
        try {
            const response = await this.gmail.users.getProfile({
                userId: 'me'
            });
            return response.data;
        } catch (error) {
            console.error('Error getting user profile:', error);
            throw error;
        }
    }

    /**
     * Get messages list (for sync)
     */
    async getMessagesList(
        pageToken?: string,
        maxResults: number = 100,
        query?: string
    ): Promise<any> {
        try {
            const response = await this.gmail.users.messages.list({
                userId: 'me',
                maxResults: Math.min(maxResults, 500),
                pageToken: pageToken,
                q: query || ''
            });

            return {
                messages: response.data.messages || [],
                nextPageToken: response.data.nextPageToken,
                resultSizeEstimate: response.data.resultSizeEstimate || 0
            };
        } catch (error) {
            console.error('Error getting messages list:', error);
            throw error;
        }
    }

    /**
     * Get emails with pagination (full email data)
     */
    async getEmails(
        pageToken?: string,
        maxResults: number = 20,
        query?: string
    ): Promise<any> {
        try {
            const response = await this.gmail.users.messages.list({
                userId: 'me',
                maxResults: maxResults,
                pageToken: pageToken,
                q: query || ''
            });

            const messages = response.data.messages || [];
            const emails = [];

            for (const message of messages) {
                try {
                    const email = await this.getEmail(message.id);
                    emails.push(email);
                } catch (error) {
                    console.error(`Error fetching email ${message.id}:`, error);
                }
            }

            return {
                emails: emails,
                nextPageToken: response.data.nextPageToken,
                resultSizeEstimate: response.data.resultSizeEstimate || emails.length
            };
        } catch (error) {
            console.error('Error getting emails:', error);
            throw error;
        }
    }
}

export const gmailService = new GmailService();