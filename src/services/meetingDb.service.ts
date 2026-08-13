import { executeQuery, executeNonQuery, getSQLConnection } from '../config/database';

function generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 10; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function generatePassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let pass = '';
    for (let i = 0; i < 8; i++) {
        pass += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return pass;
}

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

export class MeetingDbService {

    static async ensureTables(): Promise<void> {
        try {
            const conn = await getSQLConnection();
            const tables = [
                {
                    name: 'nt_meetings',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meetings')
                    CREATE TABLE nt_meetings (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_code NVARCHAR(20) NOT NULL UNIQUE,
                        meeting_password NVARCHAR(100) NULL,
                        title NVARCHAR(500) NOT NULL DEFAULT 'Quick Meeting',
                        description NVARCHAR(MAX) NULL,
                        meeting_type NVARCHAR(20) NOT NULL DEFAULT 'instant',
                        visibility NVARCHAR(20) NOT NULL DEFAULT 'public',
                        host_user_id INT NOT NULL,
                        co_hosts NVARCHAR(MAX) NULL,
                        status NVARCHAR(20) NOT NULL DEFAULT 'scheduled',
                        start_time DATETIME2 NULL,
                        end_time DATETIME2 NULL,
                        actual_start DATETIME2 NULL,
                        actual_end DATETIME2 NULL,
                        max_participants INT NULL DEFAULT 100,
                        waiting_room BIT NOT NULL DEFAULT 0,
                        allow_join_before_host BIT NOT NULL DEFAULT 1,
                        mute_on_join BIT NOT NULL DEFAULT 1,
                        camera_off_on_join BIT NOT NULL DEFAULT 0,
                        allow_recording BIT NOT NULL DEFAULT 1,
                        allow_screen_share BIT NOT NULL DEFAULT 1,
                        allow_chat BIT NOT NULL DEFAULT 1,
                        allow_reactions BIT NOT NULL DEFAULT 1,
                        allow_hand_raise BIT NOT NULL DEFAULT 1,
                        auto_end_minutes INT NULL,
                        lock_meeting BIT NOT NULL DEFAULT 0,
                        timezone NVARCHAR(50) NULL DEFAULT 'UTC',
                        recurrence_rule NVARCHAR(500) NULL,
                        calendar_event_id NVARCHAR(255) NULL,
                        banner_url NVARCHAR(1000) NULL,
                        logo_url NVARCHAR(1000) NULL,
                        duration_minutes INT NULL DEFAULT 60,
                        created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                        updated_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                    )`
                },
                {
                    name: 'nt_meeting_participants',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_participants')
                    CREATE TABLE nt_meeting_participants (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        user_id INT NULL,
                        display_name NVARCHAR(200) NULL,
                        email NVARCHAR(200) NULL,
                        role NVARCHAR(20) NOT NULL DEFAULT 'participant',
                        status NVARCHAR(20) NOT NULL DEFAULT 'invited',
                        joined_at DATETIME2 NULL,
                        left_at DATETIME2 NULL,
                        duration_seconds INT NULL DEFAULT 0,
                        is_muted BIT NOT NULL DEFAULT 0,
                        is_camera_on BIT NOT NULL DEFAULT 1,
                        is_hand_raised BIT NOT NULL DEFAULT 0,
                        is_screen_sharing BIT NOT NULL DEFAULT 0,
                        is_spotlight BIT NOT NULL DEFAULT 0,
                        is_pinned BIT NOT NULL DEFAULT 0,
                        socket_id NVARCHAR(100) NULL,
                        network_quality INT NULL DEFAULT 5,
                        created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                    )`
                },
                {
                    name: 'nt_meeting_invitations',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_invitations')
                    CREATE TABLE nt_meeting_invitations (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        email NVARCHAR(200) NOT NULL,
                        user_id INT NULL,
                        invited_by INT NOT NULL,
                        status NVARCHAR(20) NOT NULL DEFAULT 'pending',
                        token NVARCHAR(255) NULL,
                        responded_at DATETIME2 NULL,
                        created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                    )`
                },
                {
                    name: 'nt_meeting_messages',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_messages')
                    CREATE TABLE nt_meeting_messages (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        sender_id INT NULL,
                        sender_name NVARCHAR(200) NOT NULL,
                        message_type NVARCHAR(20) NOT NULL DEFAULT 'text',
                        content NVARCHAR(MAX) NOT NULL,
                        is_private BIT NOT NULL DEFAULT 0,
                        recipient_id INT NULL,
                        is_deleted BIT NOT NULL DEFAULT 0,
                        created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                    )`
                },
                {
                    name: 'nt_meeting_reactions',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_reactions')
                    CREATE TABLE nt_meeting_reactions (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        user_id INT NULL,
                        user_name NVARCHAR(200) NOT NULL,
                        emoji NVARCHAR(20) NOT NULL,
                        created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                    )`
                },
                {
                    name: 'nt_meeting_hands',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_hands')
                    CREATE TABLE nt_meeting_hands (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        user_id INT NULL,
                        user_name NVARCHAR(200) NOT NULL,
                        is_raised BIT NOT NULL DEFAULT 1,
                        raised_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                        lowered_at DATETIME2 NULL
                    )`
                },
                {
                    name: 'nt_meeting_recordings',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_recordings')
                    CREATE TABLE nt_meeting_recordings (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        recorded_by INT NULL,
                        file_url NVARCHAR(500) NULL,
                        file_size BIGINT NULL DEFAULT 0,
                        duration_seconds INT NULL DEFAULT 0,
                        status NVARCHAR(20) NOT NULL DEFAULT 'recording',
                        started_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                        stopped_at DATETIME2 NULL
                    )`
                },
                {
                    name: 'nt_meeting_attendance',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_attendance')
                    CREATE TABLE nt_meeting_attendance (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        user_id INT NULL,
                        display_name NVARCHAR(200) NOT NULL,
                        email NVARCHAR(200) NULL,
                        action NVARCHAR(20) NOT NULL,
                        timestamp DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                        ip_address NVARCHAR(45) NULL,
                        user_agent NVARCHAR(500) NULL
                    )`
                },
                {
                    name: 'nt_meeting_polls',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_polls')
                    CREATE TABLE nt_meeting_polls (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        created_by INT NULL,
                        question NVARCHAR(500) NOT NULL,
                        options NVARCHAR(MAX) NOT NULL,
                        is_anonymous BIT NOT NULL DEFAULT 0,
                        is_active BIT NOT NULL DEFAULT 1,
                        created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
                        closed_at DATETIME2 NULL
                    )`
                },
                {
                    name: 'nt_meeting_poll_votes',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_poll_votes')
                    CREATE TABLE nt_meeting_poll_votes (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        poll_id INT NOT NULL,
                        user_id INT NULL,
                        option_index INT NOT NULL,
                        created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                    )`
                },
                {
                    name: 'nt_meeting_logs',
                    sql: `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_meeting_logs')
                    CREATE TABLE nt_meeting_logs (
                        id INT IDENTITY(1,1) PRIMARY KEY,
                        meeting_id INT NOT NULL,
                        user_id INT NULL,
                        action NVARCHAR(100) NOT NULL,
                        details NVARCHAR(MAX) NULL,
                        created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
                    )`
                }
            ];

            for (const table of tables) {
                await conn.query(table.sql);
                console.log(`[MeetingDB] Table ${table.name} ready`);
            }

            // Add new columns if they don't exist (for existing databases)
            const alterStatements = [
                `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'nt_meetings' AND COLUMN_NAME = 'banner_url')
                 ALTER TABLE nt_meetings ADD banner_url NVARCHAR(1000) NULL`,
                `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'nt_meetings' AND COLUMN_NAME = 'logo_url')
                 ALTER TABLE nt_meetings ADD logo_url NVARCHAR(1000) NULL`,
                `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'nt_meetings' AND COLUMN_NAME = 'duration_minutes')
                 ALTER TABLE nt_meetings ADD duration_minutes INT NULL DEFAULT 60`,
            ];

            for (const stmt of alterStatements) {
                try { await conn.query(stmt); } catch (e) { /* column already exists */ }
            }
            console.log('[MeetingDB] Schema migrations complete');
        } catch (error) {
            console.error('[MeetingDB] Error ensuring tables:', error);
        }
    }

    static async createMeeting(data: {
        title: string;
        description?: string;
        meeting_type: string;
        visibility?: string;
        host_user_id: any;
        password?: string;
        start_time?: string;
        end_time?: string;
        waiting_room?: boolean;
        mute_on_join?: boolean;
        allow_recording?: boolean;
        allow_screen_share?: boolean;
        allow_chat?: boolean;
        allow_reactions?: boolean;
        allow_hand_raise?: boolean;
        timezone?: string;
        recurrence_rule?: string;
        banner_url?: string;
        logo_url?: string;
        duration_minutes?: number;
    }): Promise<any> {
        const meeting_code = generateCode();
        const meeting_password = data.password || generatePassword();
        const hostId = toInt(data.host_user_id);

        const result = await executeQuery<any>(
            `INSERT INTO nt_meetings (meeting_code, meeting_password, title, description, meeting_type,
             visibility, host_user_id, status, start_time, end_time, waiting_room, mute_on_join,
             allow_recording, allow_screen_share, allow_chat, allow_reactions, allow_hand_raise,
             timezone, recurrence_rule, banner_url, logo_url, duration_minutes)
             OUTPUT INSERTED.*
             VALUES (@code, @password, @title, @desc, @type, @vis, @host, @status, @start, @end,
             @wr, @mute, @rec, @scr, @chat, @react, @hand, @tz, @recurrence, @banner, @logo, @duration)`,
            {
                code: meeting_code,
                password: meeting_password,
                title: data.title || 'Quick Meeting',
                desc: data.description || undefined,
                type: data.meeting_type || 'instant',
                vis: data.visibility || 'public',
                host: hostId,
                status: data.meeting_type === 'instant' ? 'active' : 'scheduled',
                start: data.start_time || undefined,
                end: data.end_time || undefined,
                wr: data.waiting_room ? 1 : 0,
                mute: data.mute_on_join ? 1 : 0,
                rec: data.allow_recording !== false ? 1 : 0,
                scr: data.allow_screen_share !== false ? 1 : 0,
                chat: data.allow_chat !== false ? 1 : 0,
                react: data.allow_reactions !== false ? 1 : 0,
                hand: data.allow_hand_raise !== false ? 1 : 0,
                tz: data.timezone || 'UTC',
                recurrence: data.recurrence_rule || undefined,
                banner: data.banner_url || undefined,
                logo: data.logo_url || undefined,
                duration: data.duration_minutes || 60
            }
        );

        return result[0];
    }

    static async getMeetingByCode(code: string): Promise<any> {
        const results = await executeQuery<any>(
            `SELECT m.*, u.cuser_name as host_name, u.cemail as host_email,
                CASE WHEN m.status IN ('completed', 'cancelled')
                    OR (m.end_time IS NOT NULL AND m.end_time < GETUTCDATE())
                    OR (m.status = 'scheduled' AND m.start_time IS NOT NULL AND m.start_time < GETUTCDATE())
                    THEN 1 ELSE 0 END as is_past
             FROM nt_meetings m
             LEFT JOIN users u ON m.host_user_id = u.id
             WHERE m.meeting_code = @code`,
            { code }
        );
        return results[0] || null;
    }

    static async getMeetingById(id: number): Promise<any> {
        const results = await executeQuery<any>(
            `SELECT m.*, u.cuser_name as host_name, u.cemail as host_email
             FROM nt_meetings m
             LEFT JOIN users u ON m.host_user_id = u.id
             WHERE m.id = @id`,
            { id }
        );
        return results[0] || null;
    }

    static async updateMeetingStatus(meetingId: number, status: string): Promise<void> {
        const extra = status === 'active' ? ', actual_start = GETUTCDATE()' :
                      status === 'completed' ? ', actual_end = GETUTCDATE()' : '';
        await executeNonQuery(
            `UPDATE nt_meetings SET status = @status, updated_at = GETUTCDATE() ${extra} WHERE id = @id`,
            { status, id: meetingId }
        );
    }

    static async addParticipant(data: {
        meeting_id: number;
        user_id?: any;
        display_name: string;
        email?: string;
        role?: string;
        socket_id?: string;
    }): Promise<any> {
        const uid = toInt(data.user_id);

        const existing = await executeQuery<any>(
            `SELECT id FROM nt_meeting_participants WHERE meeting_id = @mid AND (user_id = @uid OR socket_id = @sid)`,
            { mid: data.meeting_id, uid, sid: data.socket_id || undefined }
        );

        if (existing.length > 0) {
            await executeNonQuery(
                `UPDATE nt_meeting_participants SET status = 'joined', joined_at = GETUTCDATE(),
                 socket_id = @sid, display_name = @name WHERE id = @id`,
                { sid: data.socket_id, name: data.display_name, id: existing[0].id }
            );
            return { id: existing[0].id, isUpdate: true };
        }

        const results = await executeQuery<any>(
            `INSERT INTO nt_meeting_participants (meeting_id, user_id, display_name, email, role, status, joined_at, socket_id)
             OUTPUT INSERTED.*
             VALUES (@mid, @uid, @name, @email, @role, 'joined', GETUTCDATE(), @sid)`,
            {
                mid: data.meeting_id,
                uid,
                name: data.display_name,
                email: data.email || undefined,
                role: data.role || 'participant',
                sid: data.socket_id || undefined
            }
        );
        return results[0];
    }

    static async removeParticipant(meetingId: number, socketId: string): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_meeting_participants SET status = 'left', left_at = GETUTCDATE(),
             duration_seconds = DATEDIFF(SECOND, joined_at, GETUTCDATE())
             WHERE meeting_id = @mid AND socket_id = @sid AND status = 'joined'`,
            { mid: meetingId, sid: socketId }
        );
    }

    static async getParticipants(meetingId: number): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT p.*, u.cuser_name, u.cemail, u.cprofile_image_name
             FROM nt_meeting_participants p
             LEFT JOIN users u ON p.user_id = u.id
             WHERE p.meeting_id = @mid
             ORDER BY p.joined_at ASC`,
            { mid: meetingId }
        );
    }

    static async getActiveParticipants(meetingId: number): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT p.*, u.cuser_name, u.cemail, u.cprofile_image_name
             FROM nt_meeting_participants p
             LEFT JOIN users u ON p.user_id = u.id
             WHERE p.meeting_id = @mid AND p.status = 'joined'
             ORDER BY p.joined_at ASC`,
            { mid: meetingId }
        );
    }

    static async updateParticipantField(meetingId: number, socketId: string, field: string, value: any): Promise<void> {
        const allowedFields = ['is_muted', 'is_camera_on', 'is_hand_raised', 'is_screen_sharing',
            'is_spotlight', 'is_pinned', 'network_quality', 'socket_id', 'role', 'status'];
        if (!allowedFields.includes(field)) return;
        const params: Record<string, any> = {};
        params[field] = value;
        params['mid'] = meetingId;
        params['sid'] = socketId;
        await executeNonQuery(
            `UPDATE nt_meeting_participants SET ${field} = @${field} WHERE meeting_id = @mid AND socket_id = @sid`,
            params
        );
    }

    static async getWaitingRoom(meetingId: number): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT p.*, u.cuser_name, u.cemail
             FROM nt_meeting_participants p
             LEFT JOIN users u ON p.user_id = u.id
             WHERE p.meeting_id = @mid AND p.status = 'waiting'
             ORDER BY p.created_at ASC`,
            { mid: meetingId }
        );
    }

    static async admitParticipant(participantId: number): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_meeting_participants SET status = 'joined', joined_at = GETUTCDATE() WHERE id = @id`,
            { id: participantId }
        );
    }

    static async rejectParticipant(participantId: number): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_meeting_participants SET status = 'rejected' WHERE id = @id`,
            { id: participantId }
        );
    }

    static async saveMessage(data: {
        meeting_id: number;
        sender_id?: any;
        sender_name: string;
        message_type?: string;
        content: string;
        is_private?: boolean;
        recipient_id?: any;
    }): Promise<any> {
        const results = await executeQuery<any>(
            `INSERT INTO nt_meeting_messages (meeting_id, sender_id, sender_name, message_type, content, is_private, recipient_id)
             OUTPUT INSERTED.*
             VALUES (@mid, @sid, @sname, @type, @content, @priv, @rid)`,
            {
                mid: data.meeting_id,
                sid: toInt(data.sender_id),
                sname: data.sender_name,
                type: data.message_type || 'text',
                content: data.content,
                priv: data.is_private ? 1 : 0,
                rid: toInt(data.recipient_id)
            }
        );
        return results[0];
    }

    static async getMessages(meetingId: number, limit: number = 100): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT TOP (@limit) * FROM nt_meeting_messages
             WHERE meeting_id = @mid AND is_deleted = 0
             ORDER BY created_at ASC`,
            { mid: meetingId, limit }
        );
    }

    static async deleteMessage(messageId: number, userId: number): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_meeting_messages SET is_deleted = 1 WHERE id = @id AND sender_id = @uid`,
            { id: messageId, uid: userId }
        );
    }

    static async getUserMeetings(userId: number): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT m.*, u.cuser_name as host_name,
                (SELECT COUNT(*) FROM nt_meeting_participants WHERE meeting_id = m.id AND status = 'joined') as participant_count,
                CASE WHEN m.status IN ('completed', 'cancelled')
                    OR (m.end_time IS NOT NULL AND m.end_time < GETUTCDATE())
                    OR (m.status = 'scheduled' AND m.start_time IS NOT NULL AND m.start_time < GETUTCDATE())
                    THEN 1 ELSE 0 END as is_past
             FROM nt_meetings m
             LEFT JOIN users u ON m.host_user_id = u.id
             WHERE m.host_user_id = @uid
                OR m.id IN (SELECT meeting_id FROM nt_meeting_participants WHERE user_id = @uid)
                OR m.id IN (SELECT meeting_id FROM nt_meeting_invitations WHERE user_id = @uid)
             ORDER BY
                CASE WHEN m.status = 'active' THEN 0 WHEN m.status = 'scheduled' THEN 1 ELSE 2 END,
                m.start_time DESC, m.created_at DESC`,
            { uid: userId }
        );
    }

    static async searchUsers(query: string): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT TOP 20 id, cuser_name, cemail, cprofile_image_name FROM users
             WHERE (cuser_name LIKE @q OR cemail LIKE @q)
             ORDER BY cuser_name ASC`,
            { q: `%${query}%` }
        );
    }

    static async inviteUser(meetingId: number, email: string, invitedBy: any): Promise<any> {
        const inviterId = toInt(invitedBy);
        const userResults = await executeQuery<any>(
            `SELECT id FROM users WHERE cemail = @email`,
            { email }
        );
        const userId = toInt(userResults[0]?.id);

        const results = await executeQuery<any>(
            `INSERT INTO nt_meeting_invitations (meeting_id, email, user_id, invited_by, token)
             OUTPUT INSERTED.*
             VALUES (@mid, @email, @uid, @invited, @token)`,
            {
                mid: meetingId,
                email,
                uid: userId,
                invited: inviterId,
                token: generateCode()
            }
        );
        return results[0];
    }

    static async addParticipants(meetingId: number, userIds: number[]): Promise<void> {
        for (const uid of userIds) {
            const id = toInt(uid);
            if (!id) continue;
            const existing = await executeQuery<any>(
                `SELECT id FROM nt_meeting_participants WHERE meeting_id = @mid AND user_id = @uid`,
                { mid: meetingId, uid: id }
            );
            if (existing.length === 0) {
                await executeQuery<any>(
                    `INSERT INTO nt_meeting_participants (meeting_id, user_id, status, role)
                     VALUES (@mid, @uid, 'invited', 'participant')`,
                    { mid: meetingId, uid: id }
                );
            }
        }
    }

    static async logMeeting(meetingId: number, userId: any, action: string, details?: string): Promise<void> {
        await executeNonQuery(
            `INSERT INTO nt_meeting_logs (meeting_id, user_id, action, details) VALUES (@mid, @uid, @action, @details)`,
            { mid: meetingId, uid: toInt(userId), action, details: details || undefined }
        );
    }

    static async logAttendance(meetingId: number, userId: any, displayName: string, email: string | null, action: string, ipAddress?: string, userAgent?: string): Promise<void> {
        await executeNonQuery(
            `INSERT INTO nt_meeting_attendance (meeting_id, user_id, display_name, email, action, ip_address, user_agent)
             VALUES (@mid, @uid, @name, @email, @action, @ip, @ua)`,
            { mid: meetingId, uid: toInt(userId), name: displayName, email: email || undefined, action, ip: ipAddress || undefined, ua: userAgent || undefined }
        );
    }

    static async getUpcomingMeetings(userId: number): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT m.*, u.cuser_name as host_name,
                (SELECT COUNT(*) FROM nt_meeting_participants WHERE meeting_id = m.id AND status = 'joined') as participant_count
             FROM nt_meetings m
             LEFT JOIN users u ON m.host_user_id = u.id
             WHERE (m.host_user_id = @uid
                OR m.id IN (SELECT meeting_id FROM nt_meeting_participants WHERE user_id = @uid)
                OR m.id IN (SELECT meeting_id FROM nt_meeting_invitations WHERE user_id = @uid))
                AND m.status IN ('scheduled', 'active')
                AND NOT (m.end_time IS NOT NULL AND m.end_time < GETUTCDATE())
                AND NOT (m.status = 'scheduled' AND m.start_time IS NOT NULL AND m.start_time < GETUTCDATE())
             ORDER BY m.start_time ASC`,
            { uid: userId }
        );
    }

    static async getMeetingStats(userId: number): Promise<any> {
        const results = await executeQuery<any>(
            `SELECT
                COUNT(CASE WHEN status = 'active' THEN 1 END) as live_count,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
                COUNT(*) as total_count,
                ISNULL(SUM(CASE WHEN actual_end IS NOT NULL AND actual_start IS NOT NULL
                    THEN DATEDIFF(SECOND, actual_start, actual_end) ELSE 0 END), 0) as total_duration_seconds
             FROM nt_meetings
             WHERE host_user_id = @uid OR
                id IN (SELECT meeting_id FROM nt_meeting_participants WHERE user_id = @uid)`,
            { uid: userId }
        );
        return results[0] || { live_count: 0, completed_count: 0, total_count: 0, total_duration_seconds: 0 };
    }

    static async addReaction(meetingId: number, userId: any, userName: string, emoji: string): Promise<any> {
        const results = await executeQuery<any>(
            `INSERT INTO nt_meeting_reactions (meeting_id, user_id, user_name, emoji)
             OUTPUT INSERTED.*
             VALUES (@mid, @uid, @name, @emoji)`,
            { mid: meetingId, uid: toInt(userId), name: userName, emoji }
        );
        return results[0];
    }

    static async toggleHand(meetingId: number, userId: any, userName: string, isRaised: boolean): Promise<any> {
        if (isRaised) {
            const results = await executeQuery<any>(
                `INSERT INTO nt_meeting_hands (meeting_id, user_id, user_name, is_raised)
                 OUTPUT INSERTED.*
                 VALUES (@mid, @uid, @name, 1)`,
                { mid: meetingId, uid: toInt(userId), name: userName }
            );
            return results[0];
        } else {
            await executeNonQuery(
                `UPDATE nt_meeting_hands SET is_raised = 0, lowered_at = GETUTCDATE()
                 WHERE meeting_id = @mid AND user_id = @uid AND is_raised = 1`,
                { mid: meetingId, uid: toInt(userId) }
            );
            return null;
        }
    }

    static async endAllParticipants(meetingId: number): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_meeting_participants SET status = 'left', left_at = GETUTCDATE(),
             duration_seconds = DATEDIFF(SECOND, joined_at, GETUTCDATE())
             WHERE meeting_id = @mid AND status = 'joined'`,
            { mid: meetingId }
        );
    }

    static async updateMeetingFields(meetingId: number, fields: Record<string, any>): Promise<void> {
        const setClauses: string[] = [];
        const params: Record<string, any> = {};
        for (const [key, value] of Object.entries(fields)) {
            setClauses.push(`${key} = @${key}`);
            params[key] = value;
        }
        params['id'] = meetingId;
        await executeNonQuery(
            `UPDATE nt_meetings SET ${setClauses.join(', ')}, updated_at = GETUTCDATE() WHERE id = @id`,
            params
        );
    }

    static async transferHost(meetingId: number, newHostSocketId: string): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_meetings SET host_user_id = (SELECT user_id FROM nt_meeting_participants WHERE socket_id = @sid AND meeting_id = @mid),
             updated_at = GETUTCDATE() WHERE id = @mid`,
            { sid: newHostSocketId, mid: meetingId }
        );
        await MeetingDbService.updateParticipantField(meetingId, newHostSocketId, 'role', 'host');
    }

    static async removeParticipantBySocketId(meetingId: number, socketId: string): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_meeting_participants SET status = 'removed' WHERE meeting_id = @mid AND socket_id = @sid`,
            { mid: meetingId, sid: socketId }
        );
    }

    static async muteAllParticipants(meetingId: number): Promise<void> {
        await executeNonQuery(
            `UPDATE nt_meeting_participants SET is_muted = 1 WHERE meeting_id = @mid AND status = 'joined'`,
            { mid: meetingId }
        );
    }

    static async getInvitedMeetings(userId: number): Promise<any[]> {
        return await executeQuery<any>(
            `SELECT m.*, u.cuser_name as host_name,
                (SELECT COUNT(*) FROM nt_meeting_participants WHERE meeting_id = m.id AND status = 'joined') as participant_count,
                inv.status as invitation_status, inv.created_at as invited_at
             FROM nt_meeting_invitations inv
             INNER JOIN nt_meetings m ON inv.meeting_id = m.id
             LEFT JOIN users u ON m.host_user_id = u.id
             WHERE inv.user_id = @uid AND m.status IN ('scheduled', 'active')
                AND NOT (m.end_time IS NOT NULL AND m.end_time < GETUTCDATE())
                AND NOT (m.status = 'scheduled' AND m.start_time IS NOT NULL AND m.start_time < GETUTCDATE())
                AND m.id NOT IN (SELECT meeting_id FROM nt_meeting_participants WHERE user_id = @uid)
             ORDER BY m.start_time ASC`,
            { uid: userId }
        );
    }

    static async deleteMeeting(meetingId: number): Promise<void> {
        await executeNonQuery(
            `DELETE FROM nt_meeting_poll_votes WHERE poll_id IN (SELECT id FROM nt_meeting_polls WHERE meeting_id = @mid)`,
            { mid: meetingId }
        );
        await executeNonQuery(`DELETE FROM nt_meeting_polls WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meeting_logs WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meeting_reactions WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meeting_hands WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meeting_messages WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meeting_recordings WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meeting_attendance WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meeting_invitations WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meeting_participants WHERE meeting_id = @mid`, { mid: meetingId });
        await executeNonQuery(`DELETE FROM nt_meetings WHERE id = @mid`, { mid: meetingId });
    }
}
