/**
 * Mobile push notifications for the chat feature — PURE API CALL ONLY.
 *
 * No database access at all: this service receives the member list and
 * conversation object that the message-send path already fetched in memory,
 * checks LIVE socket connections to find offline recipients, and calls the
 * Progovex push gateway directly:
 *
 *   POST {PUSH_NOTIFICATION_API_URL}
 *   { "empid": "<recipient's employee id e.g. 500028>", "message": "<text>" }
 *
 * Configured via env vars (set in .env):
 *   PUSH_NOTIFICATION_API_URL       full endpoint URL
 *   PUSH_NOTIFICATION_ENABLED       "true" to enable (default: true)
 *   PUSH_NOTIFICATION_TIMEOUT_MS    request timeout (default 5000)
 */

import type { Server } from 'socket.io';

const API_URL = (process.env.PUSH_NOTIFICATION_API_URL || '').trim();
const ENABLED = (process.env.PUSH_NOTIFICATION_ENABLED || 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = parseInt(process.env.PUSH_NOTIFICATION_TIMEOUT_MS || '5000', 10) || 5000;

function isPushConfigured(): boolean {
    return ENABLED && !!API_URL;
}

/** Notification title/body sent to the device (WhatsApp-style). */
function buildPushText(conversation: any, senderName: string, content: string): string {
    const isGroup = conversation?.conversation_type === 'group';
    const convName = (conversation?.name || '').trim();
    const title = isGroup ? `${senderName} · ${convName || 'Group chat'}` : `New Chat from ${senderName}`;
    const body = isGroup
        ? `${senderName} in ${convName || 'the group'}: ~ ${content} ~`
        : `You have received a new message from ${senderName}: ~ ${content} ~`;
    // Single string field — title and body separated for readability on device.
    return `${body}, Please check PROGOVEX CHAT for further action.`.slice(0, 500);
}

/**
 * Fire the push request for one offline recipient. Never throws — push
 * failures must not break message sending. Timeout is enforced so a hung
 * gateway can't stall broadcasts.
 */
async function sendPush(empId: string, text: string): Promise<boolean> {
    if (!isPushConfigured()) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ empid: empId, message: text }),
            signal: controller.signal
        });
        if (!res.ok) {
            console.error(`[ChatPush] API responded ${res.status} for empid ${empId}`);
            return false;
        }
        return true;
    } catch (err: any) {
        const reason = err?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : (err?.message || err);
        console.error(`[ChatPush] send failed for empid ${empId}:`, reason);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Push-notify every OFFLINE member of the conversation about a new message.
 *
 * Called from both send paths (socket `chat:send` and REST sendMessage) via
 * pushChatNotifications, which passes in the member list and conversation it
 * already loaded — so this does its own ZERO database queries. Rules:
 *  - sender is never notified
 *  - members who left the group (left_at) are skipped
 *  - a push fires for EVERY message delivered while the recipient is offline
 *  - "offline" means NO open socket connection — live sockets are the source
 *    of truth; the in-memory member row's is_online flag is only a fallback
 *    when socket checks aren't possible
 */
export async function pushOfflineChatNotifications(
    conversationId: number,
    message: any,
    senderId: number,
    io: Server | undefined,
    members: any[],
    conversation: any
): Promise<number> {
    if (!isPushConfigured()) return 0;
    let sent = 0;
    try {
        const senderRow = (members || []).find(m => parseInt(m.user_id, 10) === senderId);
        const senderName = (message?.sender_name || senderRow?.full_name || 'Someone').trim();
        const text = buildPushText(conversation, senderName, messagePreview(message));

        for (const m of members || []) {
            const userId = parseInt(m.user_id, 10);
            if (!userId || userId === senderId) continue;          // never notify the sender
            if (m.left_at) continue;                               // former members get nothing

            // ONLINE members see the message in-app — no mobile push needed.
            // Live socket presence wins over the in-memory is_online flag.
            let online = !!m.is_online;
            if (io) {
                const socks = await io.in(`user_${userId}`).fetchSockets().catch(() => null);
                if (socks) online = socks.length > 0;
            }
            if (online) continue;

            // cuserid is numeric in the users table — coerce to string for
            // the payload (e.g. 500028 -> "500028").
            const empId = String(m.username ?? userId).trim();
            const ok = await sendPush(empId, text);
            if (ok) {
                sent++;
                console.log(`[ChatPush] offline push sent to empid ${empId} (user ${userId})`);
            }
        }
    } catch (err) {
        console.error('[ChatPush] pushOfflineChatNotifications error:', err);
    }
    return sent;
}

function messagePreview(msg: any): string {
    if (msg?.content && String(msg.content).trim()) return String(msg.content).trim().slice(0, 160);
    if (msg?.attachment_name && String(msg.attachment_name).trim()) {
        return `📎 ${String(msg.attachment_name).trim().slice(0, 120)}`;
    }
    if (msg?.attachment_url) return '📎 Attachment';
    return '';
}
