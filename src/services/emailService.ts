// backend/src/services/emailService.ts
import { executeQuery, executeNonQuery } from '../config/database';
import { s3Helper } from '../helpers/s3.helper';
import { v4 as uuidv4 } from 'uuid';

export class EmailService {
    async sendEmail(emailData: any): Promise<any> {
        // Implementation for sending actual emails
        // This could integrate with SendGrid, AWS SES, etc.
        console.log('Sending email:', emailData);
        return { success: true, messageId: uuidv4() };
    }

    async getEmailById(emailId: string, userId: number): Promise<any> {
        const emails = await executeQuery<any>(
            `SELECT * FROM nt_emails WHERE id = @emailId AND cuserid = @userId`,
            { emailId, userId }
        );
        return emails[0] || null;
    }

    async getEmailsByFolder(userId: number, folder: string, limit: number, offset: number): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT * FROM nt_emails 
             WHERE cuserid = @userId AND folder = @folder AND is_deleted = 0
             ORDER BY created_at DESC
             OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
            { userId, folder, offset, limit }
        );
    }

    async getUnreadCount(userId: number): Promise<number> {
        const result = await executeQuery<any>(
            'SELECT COUNT(*) as count FROM nt_emails WHERE cuserid = @userId AND is_read = 0 AND is_deleted = 0',
            { userId }
        );
        return result[0]?.count || 0;
    }

    async updateEmailStatus(emailId: string, updates: any): Promise<void> {
        const setClause = Object.keys(updates)
            .map(key => `${key} = @${key}`)
            .join(', ');

        await executeNonQuery(
            `UPDATE nt_emails SET ${setClause}, updated_at = GETDATE() WHERE id = @emailId`,
            { ...updates, emailId }
        );
    }

    async createThread(subject: string): Promise<string> {
        const threadId = `thr_${Date.now()}`;
        await executeNonQuery(
            'INSERT INTO nt_email_threads (id, subject) VALUES (@id, @subject)',
            { id: threadId, subject }
        );
        return threadId;
    }

    async getThreadEmails(threadId: string, userId: number): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT * FROM nt_emails 
             WHERE thread_id = @threadId AND cuserid = @userId
             ORDER BY created_at ASC`,
            { threadId, userId }
        );
    }

    
}