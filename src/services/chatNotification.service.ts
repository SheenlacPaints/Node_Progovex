import { Server } from 'socket.io';
import { ChatDbService } from './chatDb.service';
import { pushOfflineChatNotifications } from './chatPushNotification.service';

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

function messagePreview(msg: any): string {
    if (msg?.content && String(msg.content).trim()) {
        return String(msg.content).trim().slice(0, 160);
    }
    if (msg?.attachment_name && String(msg.attachment_name).trim()) {
        return `📎 ${String(msg.attachment_name).trim().slice(0, 120)}`;
    }
    if (msg?.attachment_url) return '📎 Attachment';
    return '';
}

/**
 * After a message is saved + broadcast, create a notification row in
 * nt_chat_notifications for every conversation member who is NOT currently
 * viewing that conversation (their sockets are not joined to the chat room),
 * and push a `chat:notification` event to each of those users so the toolbar
 * bell can update in real time (badge + list + sound).
 */
export async function pushChatNotifications(
    io: Server | undefined,
    conversationId: number,
    message: any,
    senderId: number
): Promise<number> {
    let created = 0;
    try {
        const members = await ChatDbService.getMembers(conversationId).catch(() => []);
        const conv = await ChatDbService.getConversation(conversationId).catch(() => null);

        // Sockets currently sitting in the conversation room = actively reading it.
        const roomSockets = io?.sockets?.adapter?.rooms?.get(`chat_${conversationId}`);

        // Mobile push for OFFLINE recipients (Sheenlac Progovex gateway).
        // Fire-and-forget so a slow/unreachable gateway never delays message
        // delivery; runs for both the socket and REST send paths. The already
        // loaded members/conversation are passed in, so the push feature does
        // NO database calls of its own — pure socket check + gateway API call.
        pushOfflineChatNotifications(conversationId, message, toInt(senderId)!, io, members, conv).catch(() => { });

        for (const m of members) {
            const userId = toInt(m.user_id);
            if (!userId || userId === toInt(senderId)) continue;
            // Former members (left_at stamped) don't get notifications anymore.
            if ((m as any).left_at) continue;

            // Skip members who are viewing the conversation in some open tab.
            if (io && roomSockets && roomSockets.size > 0) {
                const userSockets = await io.in(`user_${userId}`).fetchSockets().catch(() => []);
                const viewing = userSockets.some(s => roomSockets.has(s.id));
                if (viewing) continue;
            }

            const notifId = await ChatDbService.createChatNotification({
                userId,
                conversationId,
                messageId: toInt(message?.id),
                senderId: toInt(senderId),
                content: messagePreview(message)
            }).catch(() => 0);

            if (io && notifId) {
                io.to(`user_${userId}`).emit('chat:notification', {
                    id: notifId,
                    conversation_id: conversationId,
                    conversation_type: conv?.conversation_type || 'dm',
                    conversation_name: conv?.name || null,
                    group_avatar: conv?.avatar_url || null,
                    sender_id: toInt(senderId),
                    sender_name: message?.sender_name || 'User',
                    sender_avatar: message?.sender_avatar || null,
                    content: messagePreview(message),
                    is_read: false,
                    created_at: message?.created_at || new Date().toISOString()
                });
            }
            created++;
        }        } catch (err) {
        console.error('[ChatNotification] push error:', err);
    }
    return created;
}

/**
 * Create a toolbar notification for every newly-added group member (group
 * created or member added to an existing group). Rows are inserted in
 * nt_chat_notifications and a `chat:notification` event is pushed so the bell
 * shows "<actor> added you to the group" and clicking opens the conversation.
 */
export async function pushGroupNotification(
    io: Server | undefined,
    conversationId: number,
    conversation: any,
    actorId: number,
    actorName: string,
    memberIds: number[],
    content = 'added you to the group'
): Promise<number> {
    let created = 0;
    const actor = toInt(actorId);
    const ids = [...new Set((memberIds || []).map(m => toInt(m)).filter((n: any) => n && n !== actor) as number[])];
    for (const userId of ids) {
        const notifId = await ChatDbService.createChatNotification({
            userId,
            conversationId,
            senderId: actor!,
            content
        }).catch(() => 0);
        if (io && notifId) {
            io.to(`user_${userId}`).emit('chat:notification', {
                id: notifId,
                conversation_id: conversationId,
                conversation_type: 'group',
                conversation_name: conversation?.name || 'Group chat',
                group_avatar: conversation?.avatar_url || null,
                sender_id: actor,
                sender_name: actorName || 'User',
                sender_avatar: null,
                content,
                is_read: false,
                created_at: new Date().toISOString()
            });
        }
        created++;
    }
    return created;
}
