import { executeQuery, executeNonQuery, getSQLConnection } from '../config/database';

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

let HAS_DELETED_FOR_USER = false;

export class ChatDbService {

    static async ensureTables(): Promise<void> {
        try {
            const conn = await getSQLConnection();
            const statements = [
                `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_chat_conversations')
                 CREATE TABLE nt_chat_conversations (
                     id INT IDENTITY(1,1) PRIMARY KEY,
                     conversation_type NVARCHAR(10) NOT NULL DEFAULT 'dm',
                     name NVARCHAR(200) NULL,
                     avatar_url NVARCHAR(1000) NULL,
                     description NVARCHAR(MAX) NULL,
                     created_by INT NOT NULL,
                     created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                     updated_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                 )`,
                `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_chat_conversation_members')
                 CREATE TABLE nt_chat_conversation_members (
                     id INT IDENTITY(1,1) PRIMARY KEY,
                     conversation_id INT NOT NULL,
                     user_id INT NOT NULL,
                     role NVARCHAR(10) NOT NULL DEFAULT 'member',
                     last_read_at DATETIME2 NULL,
                     joined_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                     CONSTRAINT UQ_chat_member UNIQUE (conversation_id, user_id)
                 )`,
                `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_chat_messages')
                 CREATE TABLE nt_chat_messages (
                     id INT IDENTITY(1,1) PRIMARY KEY,
                     conversation_id INT NOT NULL,
                     sender_id INT NOT NULL,
                     message_type NVARCHAR(20) NOT NULL DEFAULT 'text',
                     content NVARCHAR(MAX) NULL,
                     attachment_url NVARCHAR(1000) NULL,
                     created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                 )`,
                `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_chat_members_conv' AND object_id = OBJECT_ID('nt_chat_conversation_members'))
                 CREATE INDEX IX_chat_members_conv ON nt_chat_conversation_members (conversation_id)`,
                `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_chat_messages_conv' AND object_id = OBJECT_ID('nt_chat_messages'))
                 CREATE INDEX IX_chat_messages_conv ON nt_chat_messages (conversation_id)`,
                `IF COL_LENGTH('nt_chat_messages', 'reply_to_message_id') IS NULL
                 ALTER TABLE nt_chat_messages ADD reply_to_message_id INT NULL`,
                `IF COL_LENGTH('nt_chat_messages', 'attachment_name') IS NULL
                 ALTER TABLE nt_chat_messages ADD attachment_name NVARCHAR(1000) NULL`,
                `IF COL_LENGTH('nt_chat_conversation_members', 'deleted_for_user') IS NULL
                 ALTER TABLE nt_chat_conversation_members ADD deleted_for_user BIT NOT NULL DEFAULT 0`,
                `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_chat_message_reactions')
                 CREATE TABLE nt_chat_message_reactions (
                     id INT IDENTITY(1,1) PRIMARY KEY,
                     message_id INT NOT NULL,
                     user_id INT NOT NULL,
                     emoji NVARCHAR(64) NOT NULL,
                     created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                     CONSTRAINT UQ_chat_reaction UNIQUE (message_id, user_id, emoji)
                 )`,
                `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_chat_reactions_msg' AND object_id = OBJECT_ID('nt_chat_message_reactions'))
                 CREATE INDEX IX_chat_reactions_msg ON nt_chat_message_reactions (message_id)`,
                `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_chat_user_status')
                 CREATE TABLE nt_chat_user_status (
                     user_id INT PRIMARY KEY,
                     is_online BIT NOT NULL DEFAULT 0,
                     last_seen_at DATETIME2 NULL,
                     updated_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                 )`
            ];
            for (const sql of statements) {
                try {
                    await conn.request().query(sql);
                } catch (e: any) {
                    // Log but continue — column may already exist, or table may already exist
                    console.warn('[ChatDb] ensureTables statement skipped:', e?.message || e);
                }
            }
            console.log('[ChatDb] tables ensured');

            // Dedicated migration: ensure deleted_for_user column exists
            try {
                const colCheck = await conn.request().query(
                    `SELECT COL_LENGTH('nt_chat_conversation_members', 'deleted_for_user') AS col_exists`
                );
                if (!colCheck.recordset?.[0]?.col_exists) {
                    await conn.request().query(
                        `ALTER TABLE nt_chat_conversation_members ADD deleted_for_user BIT NOT NULL DEFAULT 0`
                    );
                    console.log('[ChatDb] Added deleted_for_user column');
                }
                HAS_DELETED_FOR_USER = true;
            } catch (e: any) {
                console.error('[ChatDb] Failed to ensure deleted_for_user column:', e?.message || e);
                HAS_DELETED_FOR_USER = false;
            }
        } catch (err) {
            console.error('[ChatDb] ensureTables error:', err);
        }
    }

    // ==================== USERS ====================

    static async searchUsers(search: string, excludeUserId: number, limit = 20): Promise<any[]> {
        const q = search ? search.trim() : '';
        const rows = await executeQuery<any>(
            `SELECT u.ID, u.cuserid as username,
                    COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''), CONCAT(u.cfirst_name, ' ', u.clast_name), u.cfirst_name) as full_name,
                    u.cprofile_image_name as avatar_url, u.cemail as email,
                    ISNULL(st.is_online, 0) as is_online, st.last_seen_at
             FROM users u
             LEFT JOIN nt_chat_user_status st ON st.user_id = u.ID
             WHERE u.ID <> @userId
               AND (u.cuser_name LIKE @term OR u.cfirst_name LIKE @term OR u.clast_name LIKE @term
                    OR u.cemail LIKE @term OR u.cuserid LIKE @term)
             ORDER BY u.cuser_name
             OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`,
            { userId: excludeUserId, term: `%${q}%`, limit }
        );
        return (rows || []).map(r => ({
            ...r,
            full_name: (r.full_name || '').trim() || null,
            avatar_url: r.avatar_url || null
        }));
    }

    static async getUsersByIds(ids: number[]): Promise<any[]> {
        if (!ids || ids.length === 0) return [];
        const placeholders = ids.map((_, i) => `@id${i}`).join(',');
        const params: any = {};
        ids.forEach((id, i) => params[`id${i}`] = id);
        const rows = await executeQuery<any>(
            `SELECT u.ID, u.cuserid as username,
                    COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''), CONCAT(u.cfirst_name, ' ', u.clast_name), u.cfirst_name) as full_name,
                    u.cprofile_image_name as avatar_url, u.cemail as email,
                    ISNULL(st.is_online, 0) as is_online, st.last_seen_at
             FROM users u
             LEFT JOIN nt_chat_user_status st ON st.user_id = u.ID
             WHERE u.ID IN (${placeholders})`,
            params
        );
        return (rows || []).map(r => ({
            ...r,
            full_name: (r.full_name || '').trim() || null,
            avatar_url: r.avatar_url || null
        }));
    }

    // ==================== CONVERSATIONS ====================

    static async getOrCreateDM(userA: number, userB: number): Promise<number> {
        const lo = Math.min(userA, userB);
        const hi = Math.max(userA, userB);

        const existing = await executeQuery<any>(
            `SELECT c.id
             FROM nt_chat_conversations c
             INNER JOIN nt_chat_conversation_members a ON a.conversation_id = c.id AND a.user_id = @lo
             INNER JOIN nt_chat_conversation_members b ON b.conversation_id = c.id AND b.user_id = @hi
             WHERE c.conversation_type = 'dm'
               AND NOT EXISTS (SELECT 1 FROM nt_chat_conversation_members m
                               WHERE m.conversation_id = c.id AND m.user_id NOT IN (@lo, @hi))`,
            { lo, hi }
        );

        if (existing && existing.length > 0) {
            const convId = existing[0].id;
            if (HAS_DELETED_FOR_USER) {
                await executeNonQuery(
                    `UPDATE nt_chat_conversation_members SET deleted_for_user = 0
                     WHERE conversation_id = @convId AND user_id = @userA AND deleted_for_user = 1`,
                    { convId, userA }
                );
            }
            return convId;
        }

        const insertResult = await executeNonQuery(
            `INSERT INTO nt_chat_conversations (conversation_type, created_by)
             OUTPUT INSERTED.id VALUES ('dm', @creator)`,
            { creator: lo }
        );
        const conversationId = insertResult.recordset[0].id;

        await executeNonQuery(
            `INSERT INTO nt_chat_conversation_members (conversation_id, user_id, role)
             VALUES (@convId, @userA, 'member'), (@convId, @userB, 'member')`,
            { convId: conversationId, userA, userB }
        );
        return conversationId;
    }

    static async createGroup(data: { name: string; description?: string; avatar_url?: string; createdBy: number; memberIds: number[] }): Promise<number> {
        const insertResult = await executeNonQuery(
            `INSERT INTO nt_chat_conversations (conversation_type, name, description, avatar_url, created_by)
             OUTPUT INSERTED.id VALUES ('group', @name, @description, @avatarUrl, @createdBy)`,
            { name: data.name, description: data.description || null, avatarUrl: data.avatar_url || null, createdBy: data.createdBy }
        );
        const conversationId = insertResult.recordset[0].id;

        const members = Array.from(new Set<number>([data.createdBy, ...data.memberIds.map(m => toInt(m) || 0)]));
        for (const userId of members) {
            if (!userId) continue;
            const role = userId === data.createdBy ? 'owner' : 'member';
            await executeNonQuery(
                `INSERT INTO nt_chat_conversation_members (conversation_id, user_id, role)
                 VALUES (@convId, @userId, @role)`,
                { convId: conversationId, userId, role }
            );
        }
        return conversationId;
    }

    static async getConversation(id: number): Promise<any | null> {
        const rows = await executeQuery<any>(
            `SELECT id, conversation_type, name, avatar_url, description, created_by, created_at, updated_at
             FROM nt_chat_conversations WHERE id = @id`,
            { id }
        );
        return rows && rows.length > 0 ? rows[0] : null;
    }

    static async getConversationsForUser(userId: number): Promise<any[]> {
        const dfu = HAS_DELETED_FOR_USER;
        return executeQuery<any>(
            `SELECT
                 c.id as conversation_id,
                 c.conversation_type,
                 c.name as group_name,
                 c.avatar_url as group_avatar,
                 c.description,
                 c.created_by,
                 c.created_at,
                 c.updated_at,
                 me.role as my_role,
                 me.last_read_at,
                 (SELECT TOP 1 u.ID FROM nt_chat_conversation_members m
                  JOIN users u ON u.ID = m.user_id
                  WHERE m.conversation_id = c.id AND m.user_id <> @userId AND c.conversation_type = 'dm') as other_user_id,
                 (SELECT COUNT(*) FROM nt_chat_conversation_members m WHERE m.conversation_id = c.id${dfu ? ' AND ISNULL(m.deleted_for_user, 0) = 0' : ''}) as member_count,
                 (SELECT TOP 1 content FROM nt_chat_messages msg WHERE msg.conversation_id = c.id ORDER BY msg.created_at DESC) as last_message,
                 (SELECT TOP 1 created_at FROM nt_chat_messages msg WHERE msg.conversation_id = c.id ORDER BY msg.created_at DESC) as last_message_time,
                 (SELECT TOP 1 sender_id FROM nt_chat_messages msg WHERE msg.conversation_id = c.id ORDER BY msg.created_at DESC) as last_sender_id,
                 (SELECT COUNT(*) FROM nt_chat_messages msg
                  WHERE msg.conversation_id = c.id AND msg.sender_id <> @userId
                    AND (me.last_read_at IS NULL OR msg.created_at > me.last_read_at)) as unread_count
             FROM nt_chat_conversations c
             INNER JOIN nt_chat_conversation_members me ON me.conversation_id = c.id AND me.user_id = @userId${dfu ? ' AND ISNULL(me.deleted_for_user, 0) = 0' : ''}
             ORDER BY ISNULL((SELECT TOP 1 created_at FROM nt_chat_messages msg WHERE msg.conversation_id = c.id ORDER BY msg.created_at DESC), c.created_at) DESC`,
            { userId }
        );
    }

    static async getMembers(conversationId: number): Promise<any[]> {
        return executeQuery<any>(
            `SELECT m.id, m.conversation_id, m.user_id, m.role, m.joined_at, m.last_read_at,
                    u.cuserid as username,
                    COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''), CONCAT(u.cfirst_name, ' ', u.clast_name), u.cfirst_name) as full_name,
                    u.cprofile_image_name as avatar_url, u.cemail as email,
                    ISNULL(st.is_online, 0) as is_online, st.last_seen_at
             FROM nt_chat_conversation_members m
             JOIN users u ON u.ID = m.user_id
             LEFT JOIN nt_chat_user_status st ON st.user_id = u.ID
             WHERE m.conversation_id = @convId
             ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.cuser_name`,
            { convId: conversationId }
        );
    }

    static async getMemberRole(conversationId: number, userId: number): Promise<string | null> {
        const rows = await executeQuery<any>(
            `SELECT role FROM nt_chat_conversation_members WHERE conversation_id = @convId AND user_id = @userId`,
            { convId: conversationId, userId }
        );
        return rows && rows.length > 0 ? rows[0].role : null;
    }

    static async isMember(conversationId: number, userId: number): Promise<boolean> {
        const role = await this.getMemberRole(conversationId, userId);
        return role !== null;
    }

    static async addMember(conversationId: number, userId: number, role = 'member'): Promise<void> {
        await executeNonQuery(
            `IF NOT EXISTS (SELECT 1 FROM nt_chat_conversation_members WHERE conversation_id = @convId AND user_id = @userId)
             INSERT INTO nt_chat_conversation_members (conversation_id, user_id, role) VALUES (@convId, @userId, @role)
             ELSE
             UPDATE nt_chat_conversation_members SET role = @role WHERE conversation_id = @convId AND user_id = @userId`,
            { convId: conversationId, userId, role }
        );
        await executeNonQuery(`UPDATE nt_chat_conversations SET updated_at = GETUTCDATE() WHERE id = @convId`, { convId: conversationId });
    }

    static async removeMember(conversationId: number, userId: number): Promise<void> {
        await executeNonQuery(
            `DELETE FROM nt_chat_conversation_members WHERE conversation_id = @convId AND user_id = @userId`,
            { convId: conversationId, userId }
        );
        await executeNonQuery(`UPDATE nt_chat_conversations SET updated_at = GETUTCDATE() WHERE id = @convId`, { convId: conversationId });
    }

    static async updateMemberRole(conversationId: number, userId: number, role: string): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_chat_conversation_members SET role = @role WHERE conversation_id = @convId AND user_id = @userId`,
            { convId: conversationId, userId, role }
        );
    }

    static async updateConversation(id: number, data: { name?: string; description?: string; avatar_url?: string }): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_chat_conversations
             SET name = COALESCE(@name, name),
                 description = COALESCE(@description, description),
                 avatar_url = COALESCE(@avatarUrl, avatar_url),
                 updated_at = GETUTCDATE()
             WHERE id = @id`,
            { id, name: data.name, description: data.description, avatarUrl: data.avatar_url }
        );
    }

    static async deleteConversation(id: number): Promise<void> {
        await executeNonQuery(`DELETE FROM nt_chat_message_reactions WHERE message_id IN (SELECT id FROM nt_chat_messages WHERE conversation_id = @id)`, { id });
        await executeNonQuery(`DELETE FROM nt_chat_messages WHERE conversation_id = @id`, { id });
        await executeNonQuery(`DELETE FROM nt_chat_conversation_members WHERE conversation_id = @id`, { id });
        await executeNonQuery(`DELETE FROM nt_chat_conversations WHERE id = @id`, { id });
    }

    static async hideConversationForUser(conversationId: number, userId: number): Promise<{ hidden: boolean; hardDeleted: boolean }> {
        if (!HAS_DELETED_FOR_USER) return { hidden: false, hardDeleted: false };
        await executeNonQuery(
            `UPDATE nt_chat_conversation_members SET deleted_for_user = 1
             WHERE conversation_id = @convId AND user_id = @userId`,
            { convId: conversationId, userId }
        );

        const conversation = await this.getConversation(conversationId);
        if (conversation?.conversation_type === 'dm') {
            const remaining = await executeQuery<any>(
                `SELECT COUNT(*) as cnt FROM nt_chat_conversation_members
                 WHERE conversation_id = @convId AND deleted_for_user = 0`,
                { convId: conversationId }
            );
            if (remaining[0]?.cnt === 0) {
                await this.deleteConversation(conversationId);
                return { hidden: true, hardDeleted: true };
            }
        }
        return { hidden: true, hardDeleted: false };
    }

    static async unhideConversationForUser(conversationId: number, userId: number): Promise<void> {
        if (!HAS_DELETED_FOR_USER) return;
        await executeNonQuery(
            `UPDATE nt_chat_conversation_members SET deleted_for_user = 0
             WHERE conversation_id = @convId AND user_id = @userId`,
            { convId: conversationId, userId }
        );
    }

    static async isHiddenForUser(conversationId: number, userId: number): Promise<boolean> {
        if (!HAS_DELETED_FOR_USER) return false;
        const rows = await executeQuery<any>(
            `SELECT 1 FROM nt_chat_conversation_members
             WHERE conversation_id = @convId AND user_id = @userId AND deleted_for_user = 1`,
            { convId: conversationId, userId }
        );
        return rows && rows.length > 0;
    }

    static async unhideForNewMessage(conversationId: number, senderId: number): Promise<void> {
        if (!HAS_DELETED_FOR_USER) return;
        await executeNonQuery(
            `UPDATE nt_chat_conversation_members SET deleted_for_user = 0
             WHERE conversation_id = @convId AND user_id <> @senderId AND deleted_for_user = 1`,
            { convId: conversationId, senderId }
        );
    }

    // ==================== MESSAGES ====================

    static async getMessages(conversationId: number, limit = 200, viewerId?: number): Promise<any[]> {
        const rows = await executeQuery<any>(
            `SELECT TOP (@limit) msg.id, msg.conversation_id, msg.sender_id, msg.message_type, msg.content,
                    msg.attachment_url, msg.attachment_name, msg.reply_to_message_id, msg.created_at,
                    COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''), CONCAT(u.cfirst_name, ' ', u.clast_name), u.cfirst_name) as sender_name,
                    u.cprofile_image_name as sender_avatar,
                    r.id as reply_id, r.sender_id as reply_sender_id, r.message_type as reply_message_type,
                    r.content as reply_content, r.attachment_url as reply_attachment_url, r.attachment_name as reply_attachment_name,
                    COALESCE(NULLIF(LTRIM(RTRIM(ru.cuser_name)), ''), CONCAT(ru.cfirst_name, ' ', ru.clast_name), ru.cfirst_name) as reply_sender_name
             FROM nt_chat_messages msg
             JOIN users u ON u.ID = msg.sender_id
             LEFT JOIN nt_chat_messages r ON r.id = msg.reply_to_message_id
             LEFT JOIN users ru ON ru.ID = r.sender_id
             WHERE msg.conversation_id = @convId
             ORDER BY msg.created_at DESC`,
            { convId: conversationId, limit }
        );

        const list = (rows || []).map(r => ({
            ...r,
            sender_name: (r.sender_name || '').trim() || null,
            sender_avatar: r.sender_avatar || null
        }));
        const ids = list.filter(r => r.id).map(r => r.id);
        const reactions = ids.length ? await this.getReactionsForMessages(ids, viewerId) : {};

        // Read-receipt: a viewer's own message is "read" when every other member's
        // last_read_at is at or after the message's created_at.
        const members = viewerId ? await this.getMembers(conversationId).catch(() => []) : [];
        const others = (members || []).filter(m => toInt(m.user_id) !== viewerId);
        const readTimes = new Map<number, number>();
        (members || []).forEach(m => {
            const t = m.last_read_at ? new Date(m.last_read_at).getTime() : NaN;
            if (!isNaN(t)) readTimes.set(toInt(m.user_id), t);
        });

        return list.map(r => {
            let is_read = false;
            if (r.sender_id === viewerId && others.length > 0) {
                const created = new Date(r.created_at).getTime();
                is_read = others.every(o => {
                    const t = readTimes.get(toInt(o.user_id));
                    return t !== undefined && t >= created;
                });
            }
            return {
                ...r,
                is_read,
                reply_to: r.reply_id ? {
                    id: r.reply_id,
                    sender_id: r.reply_sender_id,
                    sender_name: (r.reply_sender_name || '').trim() || null,
                    message_type: r.reply_message_type,
                    content: r.reply_content,
                    attachment_url: r.reply_attachment_url,
                    attachment_name: r.reply_attachment_name
                } : null,
                reactions: reactions[r.id] || []
            };
        });
    }

    static async getMessageById(id: number): Promise<any | null> {
        const rows = await executeQuery<any>(
            `SELECT msg.id, msg.conversation_id, msg.sender_id, msg.message_type, msg.content, msg.attachment_url, msg.attachment_name,
                    msg.reply_to_message_id, msg.created_at,
                    COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''), CONCAT(u.cfirst_name, ' ', u.clast_name), u.cfirst_name) as sender_name,
                    u.cprofile_image_name as sender_avatar
             FROM nt_chat_messages msg
             JOIN users u ON u.ID = msg.sender_id
             WHERE msg.id = @id`,
            { id }
        );
        return rows && rows.length > 0 ? rows[0] : null;
    }

    static async getAttachmentNameForUrl(attachmentUrl: string): Promise<string | null> {
        if (!attachmentUrl) return null;
        const rows = await executeQuery<any>(
            `SELECT TOP 1 attachment_name
             FROM nt_chat_messages
             WHERE attachment_url = @url AND attachment_name IS NOT NULL AND LTRIM(RTRIM(attachment_name)) <> ''`,
            { url: attachmentUrl }
        );
        return rows && rows.length > 0 ? rows[0].attachment_name : null;
    }

    static async saveMessage(data: {
        conversation_id: number;
        sender_id: number;
        message_type?: string;
        content?: string;
        attachment_url?: string;
        attachment_name?: string;
        reply_to_message_id?: number | null;
    }): Promise<any> {
        const insertResult = await executeNonQuery(
            `INSERT INTO nt_chat_messages (conversation_id, sender_id, message_type, content, attachment_url, attachment_name, reply_to_message_id)
             OUTPUT INSERTED.id, INSERTED.created_at
             VALUES (@convId, @senderId, @type, @content, @attachmentUrl, @attachmentName, @replyTo)`,
            {
                convId: data.conversation_id,
                senderId: data.sender_id,
                type: data.message_type || 'text',
                content: data.content || null,
                attachmentUrl: data.attachment_url || null,
                attachmentName: data.attachment_name || null,
                replyTo: data.reply_to_message_id || null
            }
        );
        await executeNonQuery(`UPDATE nt_chat_conversations SET updated_at = GETUTCDATE() WHERE id = @convId`, { convId: data.conversation_id });
        const row = insertResult.recordset[0];
        return { id: row.id, created_at: row.created_at };
    }

    // ==================== REACTIONS ====================

    static async getReactionsForMessages(messageIds: number[], viewerId?: number): Promise<Record<number, any[]>> {
        if (!messageIds || messageIds.length === 0) return {};
        const placeholders = messageIds.map((_, i) => `@id${i}`).join(',');
        const params: any = { me: viewerId || 0 };
        messageIds.forEach((id, i) => params[`id${i}`] = id);
        const rows = await executeQuery<any>(
            `SELECT r.message_id, r.emoji, COUNT(*) as count,
                    SUM(CASE WHEN r.user_id = @me THEN 1 ELSE 0 END) as reacted
             FROM nt_chat_message_reactions r
             WHERE r.message_id IN (${placeholders})
             GROUP BY r.message_id, r.emoji`,
            params
        );
        const map: Record<number, any[]> = {};
        (rows || []).forEach(r => {
            (map[r.message_id] = map[r.message_id] || []).push({
                emoji: r.emoji,
                count: r.count,
                reacted: !!r.reacted
            });
        });

        // Fetch individual user names for each reaction
        for (const msgId of Object.keys(map).map(Number)) {
            for (const reaction of map[msgId]) {
                const userRows = await executeQuery<any>(
                    `SELECT COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''),
                         LTRIM(RTRIM(ISNULL(u.cfirst_name, '') + ' ' + ISNULL(u.clast_name, ''))),
                         'User') as user_name
                     FROM nt_chat_message_reactions r
                     LEFT JOIN users u ON u.ID = r.user_id
                     WHERE r.message_id = @m AND r.emoji = @e`,
                    { m: msgId, e: reaction.emoji }
                );
                reaction.userNames = (userRows || []).map((u: any) => u.user_name).join(', ');
            }
        }
        return map;
    }

    static async getReactionsForMessage(messageId: number, viewerId?: number): Promise<any[]> {
        const map = await this.getReactionsForMessages([messageId], viewerId);
        return map[messageId] || [];
    }

    static async toggleReaction(messageId: number, userId: number, emoji: string): Promise<'added' | 'removed'> {
        const exists = await executeQuery<any>(
            `SELECT 1 FROM nt_chat_message_reactions WHERE message_id = @m AND user_id = @u AND emoji = @e`,
            { m: messageId, u: userId, e: emoji }
        );
        if (exists && exists.length > 0) {
            await executeNonQuery(
                `DELETE FROM nt_chat_message_reactions WHERE message_id = @m AND user_id = @u AND emoji = @e`,
                { m: messageId, u: userId, e: emoji }
            );
            return 'removed';
        }
        await executeNonQuery(
            `INSERT INTO nt_chat_message_reactions (message_id, user_id, emoji) VALUES (@m, @u, @e)`,
            { m: messageId, u: userId, e: emoji }
        );
        return 'added';
    }

    static async isMessageInConversation(messageId: number, conversationId: number): Promise<boolean> {
        const rows = await executeQuery<any>(
            `SELECT 1 FROM nt_chat_messages WHERE id = @m AND conversation_id = @c`,
            { m: messageId, c: conversationId }
        );
        return rows && rows.length > 0;
    }

    // ==================== PRESENCE / LAST SEEN ====================

    static async updateUserStatus(userId: number, isOnline: boolean): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_chat_user_status
             SET is_online = @online,
                 last_seen_at = CASE WHEN @online = 1 THEN NULL ELSE GETUTCDATE() END,
                 updated_at = GETUTCDATE()
             WHERE user_id = @userId;
             IF @@ROWCOUNT = 0
             INSERT INTO nt_chat_user_status (user_id, is_online, last_seen_at)
             VALUES (@userId, @online, CASE WHEN @online = 1 THEN NULL ELSE GETUTCDATE() END)`,
            { userId, online: isOnline ? 1 : 0 }
        );
    }

    static async getUserStatus(userId: number): Promise<{ is_online: boolean; last_seen_at: string | null } | null> {
        const rows = await executeQuery<any>(
            `SELECT is_online, last_seen_at FROM nt_chat_user_status WHERE user_id = @userId`,
            { userId }
        );
        if (!rows || rows.length === 0) return null;
        return {
            is_online: !!rows[0].is_online,
            last_seen_at: rows[0].last_seen_at || null
        };
    }

    static async markRead(conversationId: number, userId: number): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_chat_conversation_members SET last_read_at = GETUTCDATE() WHERE conversation_id = @convId AND user_id = @userId`,
            { convId: conversationId, userId }
        );
    }

    // ==================== SEARCH ====================

    static async searchChats(userId: number, query: string, limit = 50): Promise<any[]> {
        const q = query ? query.trim() : '';
        if (!q) return [];
        const dfu = HAS_DELETED_FOR_USER;
        const dfuFilter = dfu ? ' AND ISNULL(me.deleted_for_user, 0) = 0' : '';

        // Search conversations by group name
        const convByName = await executeQuery<any>(
            `SELECT DISTINCT c.id as conversation_id, c.name as group_name, c.avatar_url as group_avatar,
                    c.conversation_type, c.created_at,
                    'conversation_name' as match_type,
                    c.name as match_snippet
             FROM nt_chat_conversations c
             INNER JOIN nt_chat_conversation_members me ON me.conversation_id = c.id AND me.user_id = @userId${dfuFilter}
             WHERE c.conversation_type = 'group' AND c.name LIKE @term`,
            { userId, term: `%${q}%` }
        );

        // Search DM conversations by other user's name
        const dmByName = await executeQuery<any>(
            `SELECT DISTINCT c.id as conversation_id,
                    COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''), CONCAT(u.cfirst_name, ' ', u.clast_name), u.cfirst_name) as group_name,
                    u.cprofile_image_name as group_avatar,
                    c.conversation_type, c.created_at,
                    'user_name' as match_type,
                    COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''), CONCAT(u.cfirst_name, ' ', u.clast_name), u.cfirst_name) as match_snippet
             FROM nt_chat_conversations c
             INNER JOIN nt_chat_conversation_members me ON me.conversation_id = c.id AND me.user_id = @userId${dfuFilter}
             INNER JOIN nt_chat_conversation_members om ON om.conversation_id = c.id AND om.user_id <> @userId
             INNER JOIN users u ON u.ID = om.user_id
             WHERE c.conversation_type = 'dm'
               AND (u.cuser_name LIKE @term OR u.cfirst_name LIKE @term OR u.clast_name LIKE @term OR u.cemail LIKE @term)`,
            { userId, term: `%${q}%` }
        );

        // Search message content
        const msgMatches = await executeQuery<any>(
            `SELECT TOP (@limit) msg.conversation_id,
                    msg.id as message_id, msg.content as match_snippet, msg.sender_id, msg.created_at as message_time,
                    COALESCE(NULLIF(LTRIM(RTRIM(su.cuser_name)), ''), CONCAT(su.cfirst_name, ' ', su.clast_name), su.cfirst_name) as sender_name
             FROM nt_chat_messages msg
             INNER JOIN nt_chat_conversation_members me ON me.conversation_id = msg.conversation_id AND me.user_id = @userId${dfuFilter.replace('me.', 'me.')}
             INNER JOIN users su ON su.ID = msg.sender_id
             WHERE msg.content LIKE @term
             ORDER BY msg.created_at DESC`,
            { userId, term: `%${q}%`, limit }
        );

        // Combine results into a map by conversation_id
        const convMap = new Map<number, any>();

        // Add conversation name matches
        for (const row of [...convByName, ...dmByName]) {
            if (!convMap.has(row.conversation_id)) {
                convMap.set(row.conversation_id, {
                    conversation_id: row.conversation_id,
                    group_name: row.group_name,
                    group_avatar: row.group_avatar,
                    conversation_type: row.conversation_type,
                    created_at: row.created_at,
                    match_type: row.match_type,
                    match_snippet: row.match_snippet,
                    matching_messages: []
                });
            }
        }

        // Add message matches with snippets
        for (const row of msgMatches) {
            if (!convMap.has(row.conversation_id)) {
                // Need to fetch conversation info for message matches
                const conv = await this.getConversation(row.conversation_id);
                const convMembers = await this.getMembers(row.conversation_id);
                let displayName = conv?.name || '';
                let avatar = conv?.avatar_url || '';
                if (conv?.conversation_type === 'dm') {
                    const other = convMembers.find((m: any) => toInt(m.user_id) !== userId);
                    displayName = other?.full_name || 'User';
                    avatar = other?.avatar_url || '';
                }
                convMap.set(row.conversation_id, {
                    conversation_id: row.conversation_id,
                    group_name: displayName,
                    group_avatar: avatar,
                    conversation_type: conv?.conversation_type || 'dm',
                    created_at: conv?.created_at,
                    match_type: 'message_content',
                    match_snippet: row.match_snippet,
                    matching_messages: []
                });
            }
            const conv = convMap.get(row.conversation_id)!;
            conv.matching_messages.push({
                message_id: row.message_id,
                content: row.match_snippet,
                sender_name: row.sender_name,
                message_time: row.message_time
            });
        }

        return Array.from(convMap.values()).slice(0, limit);
    }
}
