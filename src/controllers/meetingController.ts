import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { MeetingDbService } from '../services/meetingDb.service';
import { sendMeetingInviteEmail, formatMeetingDateTime } from '../services/mail.service';

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

function isPastMeeting(meeting: any): boolean {
    if (!meeting) return true;
    if (meeting.status === 'completed' || meeting.status === 'cancelled') return true;
    if (meeting.status === 'active' && meeting.actual_end) return true;
    if (meeting.status === 'scheduled' && meeting.start_time) {
        const duration = meeting.duration_minutes || 60;
        const endTime = new Date(new Date(meeting.start_time).getTime() + duration * 60000);
        if (endTime.getTime() < Date.now()) return true;
    }
    return false;
}

export class MeetingController {

    /**
     * Send a Gmail-Meet-style invite email to each recipient.
     * Emails are only delivered when SMTP is configured and EMAIL_ENABLED=true.
     */
    private static async sendInviteEmails(req: AuthRequest, meeting: any, emails: string[]): Promise<number> {
        const unique = [...new Set((emails || []).map((e: string) => String(e).trim()).filter(Boolean))];
        if (unique.length === 0) return 0;

        const users = await MeetingDbService.getUsersByEmails(unique);
        const nameByEmail = new Map<string, string>();
        for (const u of users) {
            const key = String(u?.cemail || '').trim().toLowerCase();
            if (key) nameByEmail.set(key, u.cuser_name);
        }

        const hostName = meeting.host_name || req.user?.fullName || req.user?.username || 'Host';
        const inviteLink = `${process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:4200'}/meeting/join/${meeting.meeting_code}`;

        let sent = 0;
        for (const email of unique) {
            const result = await sendMeetingInviteEmail({
                to: email,
                toName: nameByEmail.get(email.toLowerCase()),
                title: meeting.title,
                hostName,
                dateTimeLabel: formatMeetingDateTime(meeting.start_time),
                meetingCode: meeting.meeting_code,
                meetingPassword: meeting.meeting_password,
                inviteLink,
                description: meeting.description
            });
            if (result.success && !result.skipped) sent++;
        }
        return sent;
    }

    static async createMeeting(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = req.user?.id || req.user?.cuserid;
            if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

            const meeting = await MeetingDbService.createMeeting({
                title: req.body.title || 'Quick Meeting',
                description: req.body.description,
                meeting_type: req.body.meeting_type || 'instant',
                visibility: req.body.visibility || 'public',
                host_user_id: userId,
                password: req.body.meeting_password,
                start_time: req.body.start_time,
                end_time: req.body.end_time,
                waiting_room: req.body.waiting_room,
                mute_on_join: req.body.mute_on_join,
                allow_recording: req.body.allow_recording,
                allow_screen_share: req.body.allow_screen_share,
                allow_chat: req.body.allow_chat,
                allow_reactions: req.body.allow_reactions,
                allow_hand_raise: req.body.allow_hand_raise,
                timezone: req.body.timezone,
                recurrence_rule: req.body.recurrence_rule,
                banner_url: req.body.banner_url,
                logo_url: req.body.logo_url,
                duration_minutes: req.body.duration_minutes
            });

            await MeetingDbService.logMeeting(meeting.id, userId, 'created');

            const participantIds = req.body.participant_ids;
            if (Array.isArray(participantIds) && participantIds.length > 0) {
                await MeetingDbService.addParticipants(meeting.id, participantIds);
                await MeetingDbService.logMeeting(meeting.id, userId, 'participants_added', participantIds.join(','));
            }

            const participantEmails: string[] = [];
            if (Array.isArray(req.body.participant_emails)) {
                for (const email of req.body.participant_emails) {
                    const e = String(email || '').trim();
                    if (!e) continue;
                    try {
                        await MeetingDbService.inviteUser(meeting.id, e, userId);
                        participantEmails.push(e);
                    } catch (err) { /* skip duplicates */ }
                }
            }

            if (participantEmails.length > 0) {
                await this.sendInviteEmails(req, meeting, participantEmails);
            }

            const inviteLink = `${process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:4200'}/meeting/join/${meeting.meeting_code}`;

            res.json({
                success: true,
                meeting_code: meeting.meeting_code,
                meeting_password: meeting.meeting_password,
                invite_link: inviteLink,
                meeting
            });
        } catch (error: any) {
            console.error('[MeetingController] createMeeting error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getMeetingByCode(req: Request, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            meeting.is_past = isPastMeeting(meeting);

            const participants = await MeetingDbService.getActiveParticipants(meeting.id);
            const waitingRoom = await MeetingDbService.getWaitingRoom(meeting.id);

            res.json({
                success: true,
                meeting,
                participants,
                waitingRoom
            });
        } catch (error: any) {
            console.error('[MeetingController] getMeetingByCode error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async joinMeeting(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            if (isPastMeeting(meeting)) {
                res.status(400).json({ success: false, message: 'This meeting has ended and can no longer be joined' }); return;
            }

            if (meeting.status !== 'active' && meeting.status !== 'scheduled') {
                res.status(400).json({ success: false, message: 'This meeting is not available to join' }); return;
            }

            if (meeting.meeting_password && meeting.meeting_password !== req.body.password) {
                res.status(400).json({ success: false, message: 'Invalid password' }); return;
            }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            const displayName = req.user?.fullName || req.user?.username || req.body.display_name || 'Guest';
            const email = req.user?.email || req.body.email || null;

            const participantStatus = meeting.waiting_room ? 'waiting' : 'joined';
            const isHost = toInt(meeting.host_user_id) === userId;

            const participant = await MeetingDbService.addParticipant({
                meeting_id: meeting.id,
                user_id: userId,
                display_name: displayName,
                email: email,
                role: isHost ? 'host' : 'participant'
            });

            if (participantStatus === 'waiting') {
                res.json({ success: true, status: 'waiting', message: 'You are in the waiting room' });
            } else {
                res.json({
                    success: true,
                    status: 'joined',
                    meeting,
                    participant
                });
            }

            await MeetingDbService.logAttendance(meeting.id, userId, displayName, email, 'joined');
            await MeetingDbService.logMeeting(meeting.id, userId, 'joined');
        } catch (error: any) {
            console.error('[MeetingController] joinMeeting error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async leaveMeeting(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const socketId = req.body.socket_id;
            if (socketId) {
                await MeetingDbService.removeParticipant(meeting.id, socketId);
            }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            await MeetingDbService.logMeeting(meeting.id, userId, 'left');

            res.json({ success: true });
        } catch (error: any) {
            console.error('[MeetingController] leaveMeeting error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async endMeeting(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (toInt(meeting.host_user_id) !== userId) {
                res.status(403).json({ success: false, message: 'Only host can end meeting' }); return;
            }

            await MeetingDbService.updateMeetingStatus(meeting.id, 'completed');
            await MeetingDbService.endAllParticipants(meeting.id);

            await MeetingDbService.logMeeting(meeting.id, userId, 'ended');

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:ended', {
                    meetingCode: meeting.meeting_code,
                    endedBy: userId
                });
            }

            res.json({ success: true });
        } catch (error: any) {
            console.error('[MeetingController] endMeeting error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getParticipants(req: Request, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const participants = await MeetingDbService.getActiveParticipants(meeting.id);
            res.json({ success: true, participants });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updateParticipant(req: Request, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const { field, value, socket_id } = req.body;
            if (!field || !socket_id) {
                res.status(400).json({ success: false, message: 'field and socket_id required' }); return;
            }

            await MeetingDbService.updateParticipantField(meeting.id, socket_id, field, value);
            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async admitFromWaitingRoom(req: Request, res: Response): Promise<void> {
        try {
            const { participantId } = req.body;
            await MeetingDbService.admitParticipant(participantId);
            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async rejectFromWaitingRoom(req: Request, res: Response): Promise<void> {
        try {
            const { participantId } = req.body;
            await MeetingDbService.rejectParticipant(participantId);
            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async admitAll(req: Request, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const waiting = await MeetingDbService.getWaitingRoom(meeting.id);
            for (const p of waiting) {
                await MeetingDbService.admitParticipant(p.id);
            }
            res.json({ success: true, admitted: waiting.length });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getUserMeetings(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

            const meetings = await MeetingDbService.getUserMeetings(userId);
            res.json({ success: true, meetings });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getUpcomingMeetings(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

            const upcoming = await MeetingDbService.getUpcomingMeetings(userId);
            const invited = await MeetingDbService.getInvitedMeetings(userId);

            res.json({ success: true, meetings: upcoming, invited });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getMeetingStats(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

            const stats = await MeetingDbService.getMeetingStats(userId);
            res.json({ success: true, stats });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async searchUsers(req: Request, res: Response): Promise<void> {
        try {
            const query = req.query.q as string;
            if (!query || query.length < 2) {
                res.json({ success: true, users: [] }); return;
            }
            const users = await MeetingDbService.searchUsers(query);
            res.json({ success: true, users });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async inviteUser(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            const email = req.body.email;
            if (!email) { res.status(400).json({ success: false, message: 'Email required' }); return; }

            await MeetingDbService.inviteUser(meeting.id, email, userId);
            await MeetingDbService.logMeeting(meeting.id, userId, 'invited', email);

            await this.sendInviteEmails(req, meeting, [email]);

            res.json({ success: true, message: 'Invitation sent' });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async inviteBulk(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            const emails = req.body.emails;
            if (!emails || !Array.isArray(emails) || emails.length === 0) {
                res.status(400).json({ success: false, message: 'Emails array required' }); return;
            }

            let invited = 0;
            const invitedEmails: string[] = [];
            for (const email of emails) {
                const e = String(email || '').trim();
                if (!e) continue;
                try {
                    await MeetingDbService.inviteUser(meeting.id, e, userId);
                    invited++;
                    invitedEmails.push(e);
                } catch (err) { /* skip duplicates */ }
            }

            await MeetingDbService.logMeeting(meeting.id, userId, 'invited_bulk', emails.join(','));

            const mailSent = await this.sendInviteEmails(req, meeting, invitedEmails);
            const inviteLink = `${process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:4200'}/meeting/join/${meeting.meeting_code}`;

            res.json({ success: true, invited, mails_sent: mailSent, invite_link: inviteLink });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async scheduleMeeting(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

            const meeting = await MeetingDbService.createMeeting({
                title: req.body.title || 'Scheduled Meeting',
                description: req.body.description,
                meeting_type: 'scheduled',
                visibility: req.body.visibility || 'public',
                host_user_id: userId,
                password: req.body.meeting_password,
                start_time: req.body.start_time,
                end_time: req.body.end_time,
                waiting_room: req.body.waiting_room,
                mute_on_join: req.body.mute_on_join,
                allow_recording: req.body.allow_recording,
                allow_screen_share: req.body.allow_screen_share,
                allow_chat: req.body.allow_chat,
                allow_reactions: req.body.allow_reactions,
                allow_hand_raise: req.body.allow_hand_raise,
                timezone: req.body.timezone,
                recurrence_rule: req.body.recurrence_rule,
                banner_url: req.body.banner_url,
                logo_url: req.body.logo_url,
                duration_minutes: req.body.duration_minutes
            });

            const inviteEmails: string[] = [];

            if (req.body.participant_ids && Array.isArray(req.body.participant_ids)) {
                const ids = req.body.participant_ids
                    .map((x: any) => toInt(x))
                    .filter((n: any): n is number => !!n);
                if (ids.length > 0) {
                    await MeetingDbService.addParticipants(meeting.id, ids);
                    const invitedUsers = await MeetingDbService.getUsersByIds(ids);
                    for (const u of invitedUsers) {
                        if (u.cemail) inviteEmails.push(u.cemail);
                    }
                    await MeetingDbService.logMeeting(meeting.id, userId, 'participants_added', ids.join(','));
                }
            }

            const emailSources: string[] = [
                ...(Array.isArray(req.body.participant_emails) ? req.body.participant_emails : []),
                ...(Array.isArray(req.body.participants) ? req.body.participants : [])
            ];
            for (const raw of emailSources) {
                const e = String(raw || '').trim();
                if (!e) continue;
                try {
                    await MeetingDbService.inviteUser(meeting.id, e, userId);
                    inviteEmails.push(e);
                } catch (err) { /* skip duplicates */ }
            }

            if (inviteEmails.length > 0) {
                await this.sendInviteEmails(req, meeting, inviteEmails);
            }

            await MeetingDbService.logMeeting(meeting.id, userId, 'scheduled');
            const inviteLink = `${process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:4200'}/meeting/join/${meeting.meeting_code}`;

            res.json({
                success: true,
                meeting_code: meeting.meeting_code,
                meeting_password: meeting.meeting_password,
                invite_link: inviteLink,
                meeting
            });
        } catch (error: any) {
            console.error('[MeetingController] scheduleMeeting error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async updateMeetingSettings(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (toInt(meeting.host_user_id) !== userId) {
                res.status(403).json({ success: false, message: 'Only host can update settings' }); return;
            }

            const allowedUpdates = [
                'waiting_room', 'mute_on_join', 'camera_off_on_join', 'allow_recording',
                'allow_screen_share', 'allow_chat', 'allow_reactions', 'allow_hand_raise',
                'lock_meeting', 'max_participants', 'title', 'description', 'auto_end_minutes'
            ];

            const updates: Record<string, any> = {};
            for (const key of allowedUpdates) {
                if (req.body[key] !== undefined) {
                    updates[key] = req.body[key];
                }
            }

            if (Object.keys(updates).length === 0) {
                res.json({ success: true }); return;
            }

            await MeetingDbService.updateMeetingFields(meeting.id, updates);

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:settings-updated', req.body);
            }

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async cancelMeeting(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (toInt(meeting.host_user_id) !== userId) {
                res.status(403).json({ success: false, message: 'Only host can cancel' }); return;
            }

            await MeetingDbService.updateMeetingStatus(meeting.id, 'cancelled');
            await MeetingDbService.logMeeting(meeting.id, userId, 'cancelled');

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:cancelled', { meetingCode: meeting.meeting_code });
            }

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async deleteMeeting(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (toInt(meeting.host_user_id) !== userId) {
                res.status(403).json({ success: false, message: 'Only host can delete meeting' }); return;
            }

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:deleted', { meetingCode: meeting.meeting_code });
            }

            await MeetingDbService.deleteMeeting(meeting.id);

            res.json({ success: true, message: 'Meeting deleted' });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async transferHost(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (toInt(meeting.host_user_id) !== userId) {
                res.status(403).json({ success: false, message: 'Only host can transfer' }); return;
            }

            const { newHostSocketId } = req.body;
            await MeetingDbService.transferHost(meeting.id, newHostSocketId);

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:host-changed', { newHostSocketId });
            }

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async assignCoHost(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const { socketId, role } = req.body;
            await MeetingDbService.updateParticipantField(meeting.id, socketId, 'role', role);

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:role-changed', { socketId, role });
            }

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async removeParticipant(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const { socketId } = req.body;
            await MeetingDbService.removeParticipantBySocketId(meeting.id, socketId);

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:user-removed', { socketId });
            }

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async muteAll(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            await MeetingDbService.muteAllParticipants(meeting.id);

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:mute-all', {});
            }

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async addReaction(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            const userName = req.user?.fullName || req.user?.username || 'Anonymous';
            const { emoji } = req.body;

            await MeetingDbService.addReaction(meeting.id, userId, userName, emoji);

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:reaction', {
                    userId, userName, emoji, timestamp: new Date()
                });
            }

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async toggleHand(req: AuthRequest, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const userId = toInt(req.user?.id || req.user?.cuserid);
            const userName = req.user?.fullName || req.user?.username || 'Anonymous';
            const { is_raised, socket_id } = req.body;

            await MeetingDbService.toggleHand(meeting.id, userId, userName, is_raised);
            if (socket_id) {
                await MeetingDbService.updateParticipantField(meeting.id, socket_id, 'is_hand_raised', is_raised ? 1 : 0);
            }

            const io = (req.app as any).get('io');
            if (io) {
                io.to(`meeting_${meeting.meeting_code}`).emit('meeting:hand-raised', {
                    userId, userName, is_raised, socketId: socket_id
                });
            }

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getMessages(req: Request, res: Response): Promise<void> {
        try {
            const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
            if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

            const messages = await MeetingDbService.getMessages(meeting.id);
            res.json({ success: true, messages });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async getCalendarMeetings(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user?.id || req.user?.cuserid);
            if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

            const month = toInt(req.query.month) || new Date().getMonth() + 1;
            const year = toInt(req.query.year) || new Date().getFullYear();

            const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
            const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59));

            const meetings = await MeetingDbService.getUserMeetings(userId);

            const filtered = meetings.filter((m: any) => {
                if (m.start_time) {
                    const d = new Date(m.start_time);
                    return d >= startDate && d <= endDate;
                }
                if (m.created_at) {
                    const d = new Date(m.created_at);
                    return d >= startDate && d <= endDate;
                }
                return false;
            });

            res.json({ success: true, meetings: filtered });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }

    static async saveMessage(data: {
        meeting_id: number;
        sender_id?: number;
        sender_name: string;
        content: string;
        message_type?: string;
        is_private?: boolean;
        recipient_id?: number;
    }): Promise<any> {
        return await MeetingDbService.saveMessage(data);
    }
}
