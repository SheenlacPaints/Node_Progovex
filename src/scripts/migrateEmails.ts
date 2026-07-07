// backend/src/scripts/migrateEmails.ts
import { executeNonQuery } from '../config/database';

async function migrateEmailTables() {
    console.log('📧 Starting email tables migration...');

    const queries = [
        // Create main emails table
        `CREATE TABLE IF NOT EXISTS nt_emails (
            id VARCHAR(50) PRIMARY KEY,
            cuserid INT NOT NULL,
            from_email VARCHAR(255) NOT NULL,
            from_name VARCHAR(255),
            to_emails NVARCHAR(MAX) NOT NULL,
            cc_emails NVARCHAR(MAX),
            bcc_emails NVARCHAR(MAX),
            subject NVARCHAR(500),
            content NVARCHAR(MAX),
            body NVARCHAR(MAX),
            snippet NVARCHAR(500),
            attachments NVARCHAR(MAX),
            has_attachments BIT DEFAULT 0,
            folder VARCHAR(50) DEFAULT 'inbox',
            is_read BIT DEFAULT 0,
            is_starred BIT DEFAULT 0,
            is_deleted BIT DEFAULT 0,
            is_spam BIT DEFAULT 0,
            labels NVARCHAR(MAX),
            in_reply_to VARCHAR(50),
            thread_id VARCHAR(50),
            created_at DATETIME DEFAULT GETDATE(),
            updated_at DATETIME DEFAULT GETDATE()
        )`,

        `CREATE INDEX IF NOT EXISTS idx_emails_user_folder ON nt_emails(cuserid, folder)`,
        `CREATE INDEX IF NOT EXISTS idx_emails_created_at ON nt_emails(created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_emails_is_deleted ON nt_emails(is_deleted)`,
        `CREATE INDEX IF NOT EXISTS idx_emails_is_spam ON nt_emails(is_spam)`,

        // Create threads table
        `CREATE TABLE IF NOT EXISTS nt_email_threads (
            id VARCHAR(50) PRIMARY KEY,
            subject NVARCHAR(500),
            last_message_at DATETIME DEFAULT GETDATE(),
            created_at DATETIME DEFAULT GETDATE()
        )`,

        // Create recipients table
        `CREATE TABLE IF NOT EXISTS nt_email_recipients (
            email_id VARCHAR(50),
            user_id INT,
            recipient_type VARCHAR(20),
            is_read BIT DEFAULT 0,
            is_deleted BIT DEFAULT 0,
            PRIMARY KEY (email_id, user_id, recipient_type)
        )`
    ];

    for (const query of queries) {
        try {
            await executeNonQuery(query);
            console.log(`✅ Executed: ${query.substring(0, 50)}...`);
        } catch (error) {
            console.error(`❌ Error executing query:`, error);
        }
    }

    console.log('✅ Email tables migration complete!');
}

// Run migration
if (require.main === module) {
    migrateEmailTables().catch(console.error);
}

export { migrateEmailTables };