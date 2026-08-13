import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { ChatDbService } from '../services/chatDb.service';
import { resolveUserId } from '../services/chatIdentity.service';

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

async function getUserIdFromSocket(socket: Socket): Promise<number | undefined> {
    try {
        const token = socket.handshake.auth.token;
        if (!token) return undefined;
        const decoded: any = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET || 'default_secret');
        const raw = decoded.id || decoded.userId || decoded.cuserid || decoded.username
            || decoded.Id || decoded.UserId || decoded.CUserId || decoded.cuser_name;
        return resolveUserId(raw);
    } catch (err) {
        return undefined;
    }
}

// Track open socket connections per user so a single socket drop (extra tab,
// test client, etc.) doesn't mark a still-connected user as offline.
const userConnections = new Map<number, number>();

export function registerChatSocketHandlers(io: Server): void {

    io.on('connection', async (socket: Socket) => {

        const userId = await getUserIdFromSocket(socket);
        if (userId) {
            socket.join(`user_${userId}`);
            const prev = userConnections.get(userId) || 0;
            userConnections.set(userId, prev + 1);
            if (prev === 0) {
                await ChatDbService.updateUserStatus(userId, true).catch(() => { });
                io.emit('chat:presence', { userId, isOnline: true, last_seen_at: null });
                console.log(`[ChatSocket] user ${userId} online`);
            }
        }

        socket.on('disconnect', async () => {
            if (userId) {
                const cur = (userConnections.get(userId) || 1) - 1;
                if (cur <= 0) {
                    userConnections.delete(userId);
                    await ChatDbService.updateUserStatus(userId, false).catch(() => { });
                    const st = await ChatDbService.getUserStatus(userId).catch(() => null);
                    io.emit('chat:presence', {
                        userId,
                        isOnline: false,
                        last_seen_at: st?.last_seen_at || new Date().toISOString()
                    });
                    console.log(`[ChatSocket] user ${userId} offline`);
                } else {
                    userConnections.set(userId, cur);
                }
            }
        });

        // JOIN A CONVERSATION ROOM
        socket.on('chat:join', async (data: { conversationId: number }) => {
            const uId = await getUserIdFromSocket(socket);
            const convId = toInt(data?.conversationId);
            if (!uId || !convId) return;
            try {
                const isMember = await ChatDbService.isMember(convId, uId);
                if (!isMember) return;
                socket.join(`chat_${convId}`);
                console.log(`[ChatSocket] user ${uId} joined chat ${convId}`);
            } catch (err) {
                console.error('[ChatSocket] join error:', err);
            }
        });

        // LEAVE A CONVERSATION ROOM
        socket.on('chat:leave', (data: { conversationId: number }) => {
            const convId = toInt(data?.conversationId);
            if (!convId) return;
            socket.leave(`chat_${convId}`);
        });

        // SEND A MESSAGE (persists + broadcasts)
        socket.on('chat:send', async (data: {
            conversationId: number;
            content: string;
            message_type?: string;
            attachment_url?: string;
            reply_to_message_id?: number;
        }) => {
            const uId = await getUserIdFromSocket(socket);
            const convId = toInt(data?.conversationId);
            if (!uId || !convId) return;
            const content = data?.content ? String(data.content) : '';
            if (!content.trim() && !data?.attachment_url) return;
            const replyToId = toInt(data?.reply_to_message_id);

            try {
                if (!(await ChatDbService.isMember(convId, uId))) return;
                if (replyToId && !(await ChatDbService.isMessageInConversation(replyToId, convId))) return;

                const saved = await ChatDbService.saveMessage({
                    conversation_id: convId,
                    sender_id: uId,
                    message_type: data.message_type || 'text',
                    content: content || null,
                    attachment_url: data.attachment_url || null,
                    reply_to_message_id: replyToId || null
                });

                const senders = await ChatDbService.getUsersByIds([uId]);
                const sender = senders && senders.length > 0 ? senders[0] : null;

                let reply_to = null;
                if (replyToId) {
                    const r = await ChatDbService.getMessageById(replyToId);
                    if (r) {
                        reply_to = {
                            id: r.id,
                            sender_id: r.sender_id,
                            sender_name: (r.sender_name || '').trim() || null,
                            message_type: r.message_type,
                            content: r.content,
                            attachment_url: r.attachment_url
                        };
                    }
                }

                const payload = {
                    id: saved.id,
                    conversation_id: convId,
                    sender_id: uId,
                    sender_name: sender?.full_name || 'User',
                    sender_avatar: sender?.avatar_url || null,
                    message_type: data.message_type || 'text',
                    content: content || null,
                    attachment_url: data.attachment_url || null,
                    reply_to,
                    reactions: [],
                    is_read: false,
                    created_at: saved.created_at
                };

                io.to(`chat_${convId}`).emit('chat:message', payload);
                socket.emit('chat:message-sent', payload);
                const members = await ChatDbService.getMembers(convId).catch(() => []);
                for (const m of members) {
                    const mid = toInt(m.user_id);
                    if (mid && mid !== uId) io.to(`user_${mid}`).emit('chat:message', payload);
                }
                console.log(`[ChatSocket] message ${saved.id} in chat ${convId}`);
            } catch (err) {
                console.error('[ChatSocket] send error:', err);
            }
        });

        // REACT TO A MESSAGE (toggle + broadcast)
        socket.on('chat:react', async (data: { conversationId: number; messageId: number; emoji: string }) => {
            const uId = await getUserIdFromSocket(socket);
            const convId = toInt(data?.conversationId);
            const messageId = toInt(data?.messageId);
            const emoji = data?.emoji ? String(data.emoji).trim() : '';
            if (!uId || !convId || !messageId || !emoji) return;
            try {
                if (!(await ChatDbService.isMember(convId, uId))) return;
                if (!(await ChatDbService.isMessageInConversation(messageId, convId))) return;
                const action = await ChatDbService.toggleReaction(messageId, uId, emoji);
                const reactions = await ChatDbService.getReactionsForMessage(messageId, uId);
                io.to(`chat_${convId}`).emit('chat:reaction', {
                    conversationId: convId,
                    messageId,
                    userId: uId,
                    emoji,
                    action,
                    reactions
                });
            } catch (err) {
                console.error('[ChatSocket] react error:', err);
            }
        });

        // HEARTBEAT — lets clients detect dead/zombie connections (e.g. after a
        // server restart) and rebuild their socket without a manual page reload.
        socket.on('chat:ping', (cb?: (res: { ok: boolean; t: number }) => void) => {
            if (typeof cb === 'function') cb({ ok: true, t: Date.now() });
        });

        // TYPING INDICATOR
        socket.on('chat:typing', async (data: { conversationId: number; isTyping: boolean }) => {
            const uId = await getUserIdFromSocket(socket);
            const convId = toInt(data?.conversationId);
            if (!uId || !convId) return;
            const users = await ChatDbService.getUsersByIds([uId]).catch(() => []);
            const user = users && users.length > 0 ? users[0] : null;
            const payload = {
                conversationId: convId,
                userId: uId,
                userName: user?.full_name || user?.username || '',
                isTyping: !!data.isTyping
            };
            socket.to(`chat_${convId}`).emit('chat:typing', payload);
            const members = await ChatDbService.getMembers(convId).catch(() => []);
            for (const m of members) {
                const mid = toInt(m.user_id);
                if (mid && mid !== uId) io.to(`user_${mid}`).emit('chat:typing', payload);
            }
        });

        // MARK CONVERSATION AS READ
        socket.on('chat:read', async (data: { conversationId: number }) => {
            const uId = await getUserIdFromSocket(socket);
            const convId = toInt(data?.conversationId);
            if (!uId || !convId) return;
            try {
                await ChatDbService.markRead(convId, uId);
                io.to(`chat_${convId}`).emit('chat:read-receipt', {
                    conversationId: convId,
                    userId: uId,
                    last_read_at: new Date().toISOString()
                });
            } catch (err) {
                console.error('[ChatSocket] mark read error:', err);
            }
        });

        // CONVERSATION UPDATED (group info / members changed) - notify members to refresh
        socket.on('chat:notify', (data: { conversationId: number }) => {
            const convId = toInt(data?.conversationId);
            if (!convId) return;
            io.to(`chat_${convId}`).emit('chat:updated', { conversationId: convId });
        });
    });
}
