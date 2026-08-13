import { Request, Response } from 'express';
import { Server } from 'socket.io';
import { AuthRequest } from '../middleware/auth';
import { ChatDbService } from '../services/chatDb.service';

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

function getIo(req: any): Server | undefined {
    return req?.app?.get('io') as Server | undefined;
}

async function broadcastToUserRooms(io: Server, convId: number, event: string, payload: any, excludeUserId?: number): Promise<void> {
    try {
        const members = await ChatDbService.getMembers(convId);
        for (const m of members) {
            const mid = toInt(m.user_id);
            if (mid && mid !== excludeUserId) io.to(`user_${mid}`).emit(event, payload);
        }
    } catch (e) {
        console.error('[Chat] broadcast error:', e);
    }
}

export class ChatController {

    // GET /node/api/chats
    static async listChats(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const chats = await ChatDbService.getConversationsForUser(userId);
            const otherIds = chats
                .filter(c => c.conversation_type === 'dm' && c.other_user_id)
                .map(c => c.other_user_id);
            const users = await ChatDbService.getUsersByIds(otherIds);
            const userMap = new Map(users.map(u => [u.ID, u]));

            const result = chats.map(c => {
                if (c.conversation_type === 'dm') {
                    const other = userMap.get(c.other_user_id);
                    c.display_name = other?.full_name || 'User';
                    c.avatar_url = other?.avatar_url || null;
                    c.other_user_online = !!other?.is_online;
                    c.other_last_seen = other?.last_seen_at || null;
                } else {
                    c.display_name = c.group_name;
                    c.avatar_url = c.group_avatar;
                }
                return c;
            });

            res.json({
                success: true,
                chats: result,
                me: { id: userId, cuserid: req.user?.cuserid ?? userId, username: req.user?.username || '' }
            });
        } catch (error) {
            console.error('[Chat] listChats error:', error);
            res.status(500).json({ error: 'Failed to load chats' });
        }
    }

    // GET /node/api/chats/users?q=...
    static async searchUsers(req: AuthRequest, res: Response): Promise<void> {
        try {
            const q = (req.query.q as string) || '';
            const users = await ChatDbService.searchUsers(q, toInt(req.user!.id)!);
            res.json({ success: true, users });
        } catch (error) {
            console.error('[Chat] searchUsers error:', error);
            res.status(500).json({ error: 'Failed to search users' });
        }
    }

    // POST /node/api/chats/dm { userId }
    static async createDM(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const targetId = toInt(req.body.userId);
            if (!targetId) return void res.status(400).json({ error: 'userId required' });
            if (targetId === userId) return void res.status(400).json({ error: 'Cannot chat with yourself' });

            const conversationId = await ChatDbService.getOrCreateDM(userId, targetId);
            const conversation = await ChatDbService.getConversation(conversationId);
            const members = await ChatDbService.getMembers(conversationId);
            const io = getIo(req);
            if (io) {
                io.to(`user_${targetId}`).emit('chat:new', { conversation: { ...conversation, members } });
            }
            res.json({ success: true, conversation: { ...conversation, members } });
        } catch (error) {
            console.error('[Chat] createDM error:', error);
            res.status(500).json({ error: 'Failed to start chat' });
        }
    }

    // POST /node/api/chats/group { name, description, memberIds[] }
    static async createGroup(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const name = (req.body.name || '').trim();
            if (!name) return void res.status(400).json({ error: 'Group name required' });

            const memberIds: number[] = Array.isArray(req.body.memberIds)
                ? req.body.memberIds.map((m: any) => toInt(m)).filter((n: any) => n && n !== userId)
                : [];

            const conversationId = await ChatDbService.createGroup({
                name,
                description: req.body.description || null,
                avatar_url: req.body.avatar_url || null,
                createdBy: userId,
                memberIds
            });
            const conversation = await ChatDbService.getConversation(conversationId);
            const members = await ChatDbService.getMembers(conversationId);
            const io = getIo(req);
            if (io) {
                members.forEach((m: any) => {
                    if (toInt(m.user_id) !== userId) {
                        io.to(`user_${m.user_id}`).emit('chat:new', { conversation: { ...conversation, members } });
                    }
                });
            }
            res.json({ success: true, conversation: { ...conversation, members } });
        } catch (error) {
            console.error('[Chat] createGroup error:', error);
            res.status(500).json({ error: 'Failed to create group' });
        }
    }

    // GET /node/api/chats/:id
    static async getConversation(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            if (!convId) return void res.status(400).json({ error: 'Invalid conversation id' });

            const conversation = await ChatDbService.getConversation(convId);
            if (!conversation) return void res.status(404).json({ error: 'Conversation not found' });
            if (!(await ChatDbService.isMember(convId, userId))) {
                return void res.status(403).json({ error: 'You are not a member of this conversation' });
            }

            const members = await ChatDbService.getMembers(convId);
            const myRole = await ChatDbService.getMemberRole(convId, userId);
            res.json({ success: true, conversation: { ...conversation, members, my_role: myRole } });
        } catch (error) {
            console.error('[Chat] getConversation error:', error);
            res.status(500).json({ error: 'Failed to load conversation' });
        }
    }

    // GET /node/api/chats/:id/messages
    static async getMessages(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            if (!convId) return void res.status(400).json({ error: 'Invalid conversation id' });
            if (!(await ChatDbService.isMember(convId, userId))) {
                return void res.status(403).json({ error: 'You are not a member of this conversation' });
            }
            const messages = await ChatDbService.getMessages(convId, 200, userId);
            res.json({ success: true, messages });
        } catch (error) {
            console.error('[Chat] getMessages error:', error);
            res.status(500).json({ error: 'Failed to load messages' });
        }
    }

    // POST /node/api/chats/:id/messages { content, message_type, attachment_url, reply_to_message_id }
    static async sendMessage(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            if (!convId) return void res.status(400).json({ error: 'Invalid conversation id' });
            if (!(await ChatDbService.isMember(convId, userId))) {
                return void res.status(403).json({ error: 'You are not a member of this conversation' });
            }
            const content = req.body.content ? String(req.body.content) : '';
            if (!content.trim() && !req.body.attachment_url) {
                return void res.status(400).json({ error: 'Message content required' });
            }
            const replyToId = toInt(req.body.reply_to_message_id);
            if (replyToId && !(await ChatDbService.isMessageInConversation(replyToId, convId))) {
                return void res.status(400).json({ error: 'Replied message not in this conversation' });
            }
            const saved = await ChatDbService.saveMessage({
                conversation_id: convId,
                sender_id: userId,
                message_type: req.body.message_type || 'text',
                content: content || null,
                attachment_url: req.body.attachment_url || null,
                reply_to_message_id: replyToId || null
            });

            const senders = await ChatDbService.getUsersByIds([userId]);
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
                sender_id: userId,
                sender_name: sender?.full_name || 'User',
                sender_avatar: sender?.avatar_url || null,
                message_type: req.body.message_type || 'text',
                content: content || null,
                attachment_url: req.body.attachment_url || null,
                reply_to,
                reactions: [],
                is_read: false,
                created_at: saved.created_at
            };
            const io = getIo(req);
            if (io) {
                io.to(`chat_${convId}`).emit('chat:message', payload);
                await broadcastToUserRooms(io, convId, 'chat:message', payload, userId);
            }
            res.json({ success: true, message: payload });
        } catch (error) {
            console.error('[Chat] sendMessage error:', error);
            res.status(500).json({ error: 'Failed to send message' });
        }
    }

    // POST /node/api/chats/:id/messages/:messageId/react { emoji }  (toggles)
    static async toggleReaction(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            const messageId = toInt(req.params.messageId);
            const emoji = req.body?.emoji ? String(req.body.emoji).trim() : '';
            if (!convId || !messageId || !emoji) {
                return void res.status(400).json({ error: 'Invalid request' });
            }
            if (!(await ChatDbService.isMember(convId, userId))) {
                return void res.status(403).json({ error: 'You are not a member of this conversation' });
            }
            if (!(await ChatDbService.isMessageInConversation(messageId, convId))) {
                return void res.status(404).json({ error: 'Message not found' });
            }
            const action = await ChatDbService.toggleReaction(messageId, userId, emoji);
            const reactions = await ChatDbService.getReactionsForMessage(messageId, userId);
            const io = getIo(req);
            if (io) {
                io.to(`chat_${convId}`).emit('chat:reaction', { conversationId: convId, messageId, userId, emoji, action, reactions });
            }
            res.json({ success: true, action, reactions });
        } catch (error) {
            console.error('[Chat] toggleReaction error:', error);
            res.status(500).json({ error: 'Failed to update reaction' });
        }
    }

    // POST /node/api/chats/:id/messages/:messageId/forward { targetConversationId }
    static async forwardMessage(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            const messageId = toInt(req.params.messageId);
            const targetId = toInt(req.body.targetConversationId);
            if (!convId || !messageId || !targetId) {
                return void res.status(400).json({ error: 'Invalid request' });
            }
            if (!(await ChatDbService.isMember(convId, userId))) {
                return void res.status(403).json({ error: 'You are not a member of the source conversation' });
            }
            if (!(await ChatDbService.isMember(targetId, userId))) {
                return void res.status(403).json({ error: 'You are not a member of the target conversation' });
            }
            const original = await ChatDbService.getMessageById(messageId);
            if (!original || original.conversation_id !== convId) {
                return void res.status(404).json({ error: 'Message not found' });
            }
            const saved = await ChatDbService.saveMessage({
                conversation_id: targetId,
                sender_id: userId,
                message_type: original.message_type || 'text',
                content: original.content || null,
                attachment_url: original.attachment_url || null
            });
            const senders = await ChatDbService.getUsersByIds([userId]);
            const sender = senders && senders.length > 0 ? senders[0] : null;
            const payload = {
                id: saved.id,
                conversation_id: targetId,
                sender_id: userId,
                sender_name: sender?.full_name || 'User',
                sender_avatar: sender?.avatar_url || null,
                message_type: original.message_type || 'text',
                content: original.content || null,
                attachment_url: original.attachment_url || null,
                forwarded_from: {
                    sender_name: (original.sender_name || '').trim() || null
                },
                reactions: [],
                is_read: false,
                created_at: saved.created_at
            };
            const io = getIo(req);
            if (io) {
                io.to(`chat_${targetId}`).emit('chat:message', payload);
                await broadcastToUserRooms(io, targetId, 'chat:message', payload, userId);
            }
            res.json({ success: true, message: payload });
        } catch (error) {
            console.error('[Chat] forwardMessage error:', error);
            res.status(500).json({ error: 'Failed to forward message' });
        }
    }

    // POST /node/api/chats/:id/members { userId, role }
    static async addMember(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            const targetId = toInt(req.body.userId);
            if (!convId || !targetId) return void res.status(400).json({ error: 'Conversation and userId required' });

            const myRole = await ChatDbService.getMemberRole(convId, userId);
            if (myRole !== 'owner' && myRole !== 'admin') {
                return void res.status(403).json({ error: 'Only group admins can add members' });
            }
            const role = req.body.role === 'admin' ? 'admin' : 'member';
            await ChatDbService.addMember(convId, targetId, role);
            const members = await ChatDbService.getMembers(convId);
            res.json({ success: true, members });
        } catch (error) {
            console.error('[Chat] addMember error:', error);
            res.status(500).json({ error: 'Failed to add member' });
        }
    }

    // PATCH /node/api/chats/:id/members/:userId { role }
    static async updateMemberRole(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            const targetId = toInt(req.params.userId);
            const newRole = req.body.role;
            if (!convId || !targetId || !['owner', 'admin', 'member'].includes(newRole)) {
                return void res.status(400).json({ error: 'Invalid request' });
            }

            const myRole = await ChatDbService.getMemberRole(convId, userId);
            if (myRole !== 'owner' && myRole !== 'admin') {
                return void res.status(403).json({ error: 'Only group admins can manage members' });
            }
            // only owner can make someone owner or demote an owner
            if (newRole === 'owner' && myRole !== 'owner') {
                return void res.status(403).json({ error: 'Only the owner can transfer ownership' });
            }
            const targetCurrentRole = await ChatDbService.getMemberRole(convId, targetId);
            if (targetCurrentRole === 'owner' && myRole !== 'owner') {
                return void res.status(403).json({ error: 'Only the owner can change the owner role' });
            }

            await ChatDbService.updateMemberRole(convId, targetId, newRole);
            const members = await ChatDbService.getMembers(convId);
            res.json({ success: true, members });
        } catch (error) {
            console.error('[Chat] updateMemberRole error:', error);
            res.status(500).json({ error: 'Failed to update member role' });
        }
    }

    // DELETE /node/api/chats/:id/members/:userId
    static async removeMember(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            const targetId = toInt(req.params.userId);
            if (!convId || !targetId) return void res.status(400).json({ error: 'Invalid request' });

            const myRole = await ChatDbService.getMemberRole(convId, userId);
            if (targetId === userId) {
                // leaving the conversation
                await ChatDbService.removeMember(convId, userId);
                return void res.json({ success: true, left: true });
            }

            if (myRole !== 'owner' && myRole !== 'admin') {
                return void res.status(403).json({ error: 'Only group admins can remove members' });
            }
            const targetRole = await ChatDbService.getMemberRole(convId, targetId);
            if (targetRole === 'owner') {
                return void res.status(403).json({ error: 'Cannot remove the group owner' });
            }
            if (targetRole === 'admin' && myRole !== 'owner') {
                return void res.status(403).json({ error: 'Only the owner can remove admins' });
            }
            await ChatDbService.removeMember(convId, targetId);
            const members = await ChatDbService.getMembers(convId);
            res.json({ success: true, members });
        } catch (error) {
            console.error('[Chat] removeMember error:', error);
            res.status(500).json({ error: 'Failed to remove member' });
        }
    }

    // PATCH /node/api/chats/:id { name, description, avatar_url }
    static async updateConversation(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            if (!convId) return void res.status(400).json({ error: 'Invalid conversation id' });

            const conversation = await ChatDbService.getConversation(convId);
            if (!conversation) return void res.status(404).json({ error: 'Conversation not found' });
            if (conversation.conversation_type !== 'group') {
                return void res.status(400).json({ error: 'Only group info can be updated' });
            }

            const myRole = await ChatDbService.getMemberRole(convId, userId);
            if (myRole !== 'owner' && myRole !== 'admin') {
                return void res.status(403).json({ error: 'Only group admins can update info' });
            }

            await ChatDbService.updateConversation(convId, {
                name: req.body.name !== undefined ? String(req.body.name).trim() : undefined,
                description: req.body.description !== undefined ? String(req.body.description) : undefined,
                avatar_url: req.body.avatar_url !== undefined ? req.body.avatar_url : undefined
            });
            const updated = await ChatDbService.getConversation(convId);
            res.json({ success: true, conversation: updated });
        } catch (error) {
            console.error('[Chat] updateConversation error:', error);
            res.status(500).json({ error: 'Failed to update conversation' });
        }
    }

    // DELETE /node/api/chats/:id  (leave, or delete whole conversation if owner)
    static async leaveConversation(req: AuthRequest, res: Response): Promise<void> {
        try {
            const userId = toInt(req.user!.id)!;
            const convId = toInt(req.params.id);
            if (!convId) return void res.status(400).json({ error: 'Invalid conversation id' });

            const conversation = await ChatDbService.getConversation(convId);
            if (!conversation) return void res.status(404).json({ error: 'Conversation not found' });

            const myRole = await ChatDbService.getMemberRole(convId, userId);
            if (myRole === 'owner' || conversation.conversation_type === 'dm') {
                await ChatDbService.deleteConversation(convId);
                return void res.json({ success: true, deleted: true });
            }
            await ChatDbService.removeMember(convId, userId);
            res.json({ success: true, left: true });
        } catch (error) {
            console.error('[Chat] leaveConversation error:', error);
            res.status(500).json({ error: 'Failed to leave conversation' });
        }
    }
}
