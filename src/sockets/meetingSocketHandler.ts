/**
 * Meeting signaling + SFU (mediasoup) socket handler.
 *
 * Every request from the client uses a socket.io acknowledgement:
 *   socket.emit('sfu:consume', { producerId }, (res) => res.ok ? ... : res.error)
 *
 * Participants are identified by a client-generated `peerId` that stays the same
 * across socket reconnects, so a network blip no longer leaves ghost tiles or a
 * broken call — the client simply re-joins with the same peerId.
 */
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { MeetingDbService } from '../services/meetingDb.service';
import { resolveUserId } from '../services/chatIdentity.service';
import { sfuManager, SfuRoom, ProducerInfo } from '../sfu/sfuManager';
import { sfuConfig } from '../sfu/sfuConfig';

type Role = 'host' | 'co-host' | 'participant';

interface RoomPeer {
    peerId: string;
    socketId: string;
    userId: number | null;
    name: string;
    role: Role;
    joinedAt: number;
    handRaised: boolean;
    isGuest: boolean;
}

interface WaitingPeer {
    peerId: string;
    socketId: string;
    userId: number | null;
    name: string;
    requestedAt: number;
}

interface MeetingState {
    code: string;
    meeting: any | null;
    meetingId: number | null;
    hostUserId: number | null;
    coHostUserIds: Set<number>;
    peers: Map<string, RoomPeer>;
    waiting: Map<string, WaitingPeer>;
    admitted: Set<string>;   // peerIds / user ids admitted from the waiting room
    banned: Set<string>;     // peerIds / user ids removed by the host
    spotlight: string | null;
    locked: boolean;
    sfu: SfuRoom | null;
    closeTimer: any;
    meetingLoadedAt: number;
}

const meetings = new Map<string, MeetingState>();
const roomName = (code: string) => `meeting_${code}`;

function toInt(val: any): number | null {
    if (val === undefined || val === null || val === '') return null;
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
}

function isTruthy(v: any) {
    return v === true || v === 1 || v === '1' || v === 'true';
}

async function getVerifiedUserId(socket: Socket): Promise<number | null> {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) return null;
        const decoded: any = jwt.verify(String(token).replace('Bearer ', ''), process.env.JWT_SECRET || 'default_secret');
        const raw = decoded.id || decoded.userId || decoded.cuserid || decoded.username
            || decoded.Id || decoded.UserId || decoded.CUserId || decoded.cuser_name;
        return toInt(await resolveUserId(raw));
    } catch {
        return null;
    }
}

function iceServersForClients(): any[] {
    // The SFU is reachable directly over UDP/TCP; TURN is only an extra fallback
    // for networks that block everything except 443.
    const host = process.env.TURN_HOST;
    if (!host) return [];
    const urls = [`turn:${host}:3478`, `turn:${host}:3478?transport=tcp`];
    if (process.env.TURN_TLS_PORT) urls.push(`turns:${host}:${process.env.TURN_TLS_PORT}?transport=tcp`);
    return [{ urls, username: process.env.TURN_USER, credential: process.env.TURN_PASSWORD }];
}

function publicPeer(p: RoomPeer) {
    return {
        peerId: p.peerId,
        userId: p.userId,
        name: p.name,
        role: p.role,
        handRaised: p.handRaised,
        joinedAt: p.joinedAt
    };
}

function sanitizeText(s: any, max = 2000): string {
    return String(s ?? '').slice(0, max);
}

type Ack = (res: any) => void;
const safeAck = (ack: any): Ack => (typeof ack === 'function' ? ack : () => { /* no ack */ });

export function registerMeetingSocketHandlers(io: Server): void {
    // Start mediasoup workers in the background as soon as the server boots.
    sfuManager.init();

    const emitToPeer = (state: MeetingState, peerId: string, event: string, payload: any) => {
        const p = state.peers.get(peerId);
        if (p) io.to(p.socketId).emit(event, payload);
    };

    const broadcastCount = (state: MeetingState) => {
        io.to(roomName(state.code)).emit('meeting:participant-count', { meetingCode: state.code, count: state.peers.size });
    };

    const hostSockets = (state: MeetingState) =>
        [...state.peers.values()].filter(p => p.role === 'host' || p.role === 'co-host').map(p => p.socketId);

    const broadcastWaiting = (state: MeetingState) => {
        const list = [...state.waiting.values()].map(w => ({ peerId: w.peerId, name: w.name, userId: w.userId, requestedAt: w.requestedAt }));
        for (const sid of hostSockets(state)) io.to(sid).emit('meeting:waiting-list', list);
    };

    async function loadMeeting(state: MeetingState, force = false) {
        if (!force && state.meeting && Date.now() - state.meetingLoadedAt < 60_000) return;
        try {
            const m = await MeetingDbService.getMeetingByCode(state.code);
            state.meeting = m;
            state.meetingLoadedAt = Date.now();
            if (m) {
                state.meetingId = m.id;
                state.hostUserId = toInt(m.host_user_id);
                if (!state.locked) state.locked = isTruthy(m.lock_meeting);
                if (m.co_hosts) {
                    String(m.co_hosts).split(',').map(s => toInt(s.trim())).forEach(id => { if (id) state.coHostUserIds.add(id); });
                }
            }
        } catch (e: any) {
            console.error('[Meeting] Could not load meeting from DB:', e?.message);
        }
    }

    function getState(code: string): MeetingState {
        let s = meetings.get(code);
        if (!s) {
            s = {
                code,
                meeting: null,
                meetingId: null,
                hostUserId: null,
                coHostUserIds: new Set(),
                peers: new Map(),
                waiting: new Map(),
                admitted: new Set(),
                banned: new Set(),
                spotlight: null,
                locked: false,
                sfu: null,
                closeTimer: null,
                meetingLoadedAt: 0
            };
            meetings.set(code, s);
        }
        return s;
    }

    function roleFor(state: MeetingState, userId: number | null): Role {
        if (userId && state.hostUserId && userId === state.hostUserId) return 'host';
        if (userId && state.coHostUserIds.has(userId)) return 'co-host';
        return 'participant';
    }

    async function ensureSfu(state: MeetingState): Promise<SfuRoom> {
        if (state.sfu) return state.sfu;
        const room = await sfuManager.getOrCreateRoom(state.code);
        if (state.sfu === room) return room;
        state.sfu = room;

        const toOthers = (ownerPeerId: string, event: string, payload: any) => {
            const owner = state.peers.get(ownerPeerId);
            const target = io.to(roomName(state.code));
            (owner ? target.except(owner.socketId) : target).emit(event, payload);
        };

        room.on('producer:new', (info: ProducerInfo) => toOthers(info.peerId, 'sfu:newProducer', info));
        room.on('producer:closed', ({ producerId, peerId }) => toOthers(peerId, 'sfu:producerClosed', { producerId, peerId }));
        room.on('producer:state', (info: ProducerInfo) => io.to(roomName(state.code)).emit('sfu:producerState', info));
        room.on('consumer:closed', ({ peerId, consumerId, producerId }) =>
            emitToPeer(state, peerId, 'sfu:consumerClosed', { consumerId, producerId }));
        room.on('consumer:state', ({ peerId, consumerId, producerPaused }) =>
            emitToPeer(state, peerId, 'sfu:consumerState', { consumerId, producerPaused }));
        room.on('speaking', (payload: any) => io.to(roomName(state.code)).emit('sfu:speaking', payload));
        room.on('room:died', () => {
            state.sfu = null;
            io.to(roomName(state.code)).emit('meeting:media-reset', { reason: 'media server restarted' });
        });
        return room;
    }

    function scheduleCloseIfEmpty(state: MeetingState) {
        clearTimeout(state.closeTimer);
        if (state.peers.size > 0 || state.waiting.size > 0) return;
        state.closeTimer = setTimeout(() => {
            if (state.peers.size === 0 && state.waiting.size === 0) {
                sfuManager.closeRoom(state.code);
                meetings.delete(state.code);
            }
        }, 30_000);
    }

    /** Remove a peer from a meeting (leave / disconnect / kicked). */
    async function removePeer(state: MeetingState, peerId: string, reason: 'left' | 'disconnected' | 'removed', notify = true) {
        const peer = state.peers.get(peerId);
        if (!peer) return;
        state.peers.delete(peerId);
        state.sfu?.removePeer(peerId);
        const s = io.sockets.sockets.get(peer.socketId);
        if (s) {
            s.leave(roomName(state.code));
            const joined: Map<string, string> = s.data.meetings;
            if (joined && joined.get(state.code) === peerId) joined.delete(state.code);
        }
        if (state.spotlight === peerId) {
            state.spotlight = null;
            io.to(roomName(state.code)).emit('meeting:spotlight', { peerId: null });
        }
        if (notify) io.to(roomName(state.code)).emit('meeting:peer-left', { peerId, name: peer.name, reason });
        broadcastCount(state);
        scheduleCloseIfEmpty(state);
        console.log(`[Meeting] ${peer.name} ${reason} ${state.code} (${state.peers.size} remaining)`);

        if (state.meetingId) {
            MeetingDbService.logAttendance(state.meetingId, peer.userId, peer.name, null, reason).catch(() => {});
        }
    }

    async function admitPeerIntoMeeting(state: MeetingState, socket: Socket, peer: RoomPeer) {
        // Replace a stale session of the same peer (socket reconnect / refresh).
        const old = state.peers.get(peer.peerId);
        if (old) await removePeer(state, peer.peerId, 'disconnected', old.socketId !== socket.id);

        const sfu = await ensureSfu(state);
        await sfu.addPeer(peer.peerId);
        state.peers.set(peer.peerId, peer);
        socket.join(roomName(state.code));
        if (!socket.data.meetings) socket.data.meetings = new Map<string, string>();
        socket.data.meetings.set(state.code, peer.peerId);
        clearTimeout(state.closeTimer);

        socket.to(roomName(state.code)).emit('meeting:peer-joined', publicPeer(peer));
        broadcastCount(state);

        if (state.meetingId) {
            MeetingDbService.logAttendance(state.meetingId, peer.userId, peer.name, null, 'joined').catch(() => {});
            if (state.meeting && state.meeting.status === 'scheduled' && peer.role === 'host') {
                MeetingDbService.updateMeetingStatus(state.meetingId, 'active')
                    .then(() => { if (state.meeting) state.meeting.status = 'active'; })
                    .catch(() => {});
            }
        }
        console.log(`[Meeting] ${peer.name} (${peer.role}) joined ${state.code} (${state.peers.size} participants)`);

        return {
            ok: true,
            peerId: peer.peerId,
            self: publicPeer(peer),
            peers: [...state.peers.values()].filter(p => p.peerId !== peer.peerId).map(publicPeer),
            producers: sfu.listProducers(peer.peerId),
            routerRtpCapabilities: sfu.rtpCapabilities,
            iceServers: iceServersForClients(),
            spotlight: state.spotlight,
            locked: state.locked,
            meeting: state.meeting ? {
                title: state.meeting.title,
                status: state.meeting.status,
                hostUserId: state.hostUserId,
                allowChat: state.meeting.allow_chat === undefined ? true : isTruthy(state.meeting.allow_chat),
                allowScreenShare: state.meeting.allow_screen_share === undefined ? true : isTruthy(state.meeting.allow_screen_share),
                allowReactions: state.meeting.allow_reactions === undefined ? true : isTruthy(state.meeting.allow_reactions),
                muteOnJoin: isTruthy(state.meeting.mute_on_join),
                cameraOffOnJoin: isTruthy(state.meeting.camera_off_on_join),
                actualStart: state.meeting.actual_start || null
            } : null
        };
    }

    io.on('connection', (socket: Socket) => {
        socket.data.meetings = new Map<string, string>();
        const verifiedUserIdPromise = getVerifiedUserId(socket);
        const msgTimes: number[] = [];

        /** Resolve the caller's meeting state + peer, or throw. */
        const ctx = (meetingCode: string) => {
            const state = meetings.get(meetingCode);
            const peerId: string | undefined = socket.data.meetings?.get(meetingCode);
            const peer = peerId ? state?.peers.get(peerId) : undefined;
            if (!state || !peer || peer.socketId !== socket.id) throw new Error('Not in this meeting');
            return { state, peer };
        };

        const handle = (event: string, fn: (data: any) => Promise<any>) => {
            socket.on(event, async (data: any, ack: any) => {
                const reply = safeAck(ack);
                try {
                    const result = await fn(data || {});
                    reply({ ok: true, ...(result || {}) });
                } catch (e: any) {
                    if (event !== 'sfu:consume') console.warn(`[Meeting] ${event} failed:`, e?.message);
                    reply({ ok: false, error: e?.message || 'Request failed' });
                }
            });
        };

        // ───────────────────────── JOIN ─────────────────────────
        socket.on('meeting:join', async (data: any, ack: any) => {
            const reply = safeAck(ack);
            try {
                const meetingCode = sanitizeText(data?.meetingCode, 64).trim();
                const peerId = sanitizeText(data?.peerId, 64).trim();
                if (!meetingCode || !peerId) throw new Error('meetingCode and peerId are required');

                const state = getState(meetingCode);
                await loadMeeting(state);
                const m = state.meeting;
                if (m && (m.status === 'completed' || m.status === 'cancelled')) {
                    return reply({ ok: false, error: 'This meeting has ended', ended: true });
                }

                const verifiedUserId = await verifiedUserIdPromise;
                const userId = verifiedUserId ?? toInt(data?.user?.id ?? data?.user?.cuserid);
                let name = sanitizeText(data?.user?.name || data?.user?.fullName || data?.user?.username || 'Guest', 80).trim() || 'Guest';
                if (userId && (name === 'Guest' || /^\d+$/.test(name))) {
                    try {
                        const dbName = await MeetingDbService.resolveUserName(userId);
                        if (dbName && dbName !== 'Guest') name = dbName;
                    } catch { /* keep provided name */ }
                }

                const role = roleFor(state, userId);
                const isPrivileged = role !== 'participant';
                const idKey = userId ? `u:${userId}` : `p:${peerId}`;

                if (state.banned.has(idKey) || state.banned.has(`p:${peerId}`)) {
                    return reply({ ok: false, error: 'You were removed from this meeting by the host', removed: true });
                }
                const alreadyIn = state.peers.has(peerId);
                if (!alreadyIn && state.locked && !isPrivileged) {
                    return reply({ ok: false, error: 'The meeting is locked by the host', locked: true });
                }
                if (!alreadyIn && state.peers.size >= sfuConfig.maxParticipantsPerMeeting) {
                    return reply({ ok: false, error: `This meeting is full (${sfuConfig.maxParticipantsPerMeeting} participants)`, full: true });
                }

                const waitingRoomOn = m ? isTruthy(m.waiting_room) : false;
                const hostPresent = [...state.peers.values()].some(p => p.role !== 'participant');
                if (waitingRoomOn && !isPrivileged && !alreadyIn && !state.admitted.has(idKey) && !state.admitted.has(`p:${peerId}`)) {
                    state.waiting.set(peerId, { peerId, socketId: socket.id, userId, name, requestedAt: Date.now() });
                    socket.data.waitingFor = meetingCode;
                    broadcastWaiting(state);
                    return reply({ ok: false, waiting: true, hostPresent, message: 'Waiting for the host to let you in' });
                }

                state.waiting.delete(peerId);
                const peer: RoomPeer = {
                    peerId,
                    socketId: socket.id,
                    userId,
                    name,
                    role,
                    joinedAt: Date.now(),
                    handRaised: false,
                    isGuest: !userId
                };
                const result = await admitPeerIntoMeeting(state, socket, peer);
                reply(result);
                if (isPrivileged && state.waiting.size) broadcastWaiting(state);
            } catch (e: any) {
                console.error('[Meeting] join failed:', e?.message);
                reply({ ok: false, error: e?.message || 'Could not join the meeting', mediaUnavailable: !sfuManager.available });
            }
        });

        handle('meeting:leave', async ({ meetingCode }) => {
            const state = meetings.get(meetingCode);
            if (!state) return;
            state.waiting.delete(socket.data.meetings?.get(meetingCode) || '');
            const peerId = socket.data.meetings?.get(meetingCode);
            if (peerId && state.peers.get(peerId)?.socketId === socket.id) {
                await removePeer(state, peerId, 'left');
            }
        });

        // ───────────────────────── SFU ─────────────────────────
        handle('sfu:setRtpCapabilities', async ({ meetingCode, rtpCapabilities }) => {
            const { state, peer } = ctx(meetingCode);
            state.sfu!.getPeer(peer.peerId).rtpCapabilities = rtpCapabilities;
        });

        handle('sfu:createTransport', async ({ meetingCode, direction }) => {
            const { state, peer } = ctx(meetingCode);
            const params = await state.sfu!.createWebRtcTransport(peer.peerId, direction === 'send' ? 'send' : 'recv');
            return { params, iceServers: iceServersForClients() };
        });

        handle('sfu:connectTransport', async ({ meetingCode, transportId, dtlsParameters }) => {
            const { state, peer } = ctx(meetingCode);
            await state.sfu!.connectTransport(peer.peerId, transportId, dtlsParameters);
        });

        handle('sfu:restartIce', async ({ meetingCode, transportId }) => {
            const { state, peer } = ctx(meetingCode);
            const iceParameters = await state.sfu!.restartIce(peer.peerId, transportId);
            return { iceParameters };
        });

        handle('sfu:produce', async ({ meetingCode, transportId, kind, rtpParameters, appData }) => {
            const { state, peer } = ctx(meetingCode);
            const source = appData?.source;
            if ((source === 'screen' || source === 'screen-audio') && state.meeting
                && state.meeting.allow_screen_share !== undefined && !isTruthy(state.meeting.allow_screen_share)
                && peer.role === 'participant') {
                throw new Error('Screen sharing is disabled by the host');
            }
            const id = await state.sfu!.produce(peer.peerId, transportId, kind, rtpParameters, appData);
            return { id };
        });

        handle('sfu:closeProducer', async ({ meetingCode, producerId }) => {
            const { state, peer } = ctx(meetingCode);
            await state.sfu!.closeProducer(peer.peerId, producerId);
        });

        handle('sfu:pauseProducer', async ({ meetingCode, producerId }) => {
            const { state, peer } = ctx(meetingCode);
            await state.sfu!.setProducerPaused(peer.peerId, producerId, true);
        });

        handle('sfu:resumeProducer', async ({ meetingCode, producerId }) => {
            const { state, peer } = ctx(meetingCode);
            await state.sfu!.setProducerPaused(peer.peerId, producerId, false);
        });

        handle('sfu:consume', async ({ meetingCode, producerId, transportId }) => {
            const { state, peer } = ctx(meetingCode);
            const params = await state.sfu!.consume(peer.peerId, producerId, transportId);
            return { params };
        });

        handle('sfu:resumeConsumer', async ({ meetingCode, consumerId }) => {
            const { state, peer } = ctx(meetingCode);
            await state.sfu!.setConsumerPaused(peer.peerId, consumerId, false);
        });

        handle('sfu:pauseConsumer', async ({ meetingCode, consumerId }) => {
            const { state, peer } = ctx(meetingCode);
            await state.sfu!.setConsumerPaused(peer.peerId, consumerId, true);
        });

        handle('sfu:closeConsumer', async ({ meetingCode, consumerId }) => {
            const { state, peer } = ctx(meetingCode);
            await state.sfu!.closeConsumer(peer.peerId, consumerId);
        });

        handle('sfu:setConsumerLayers', async ({ meetingCode, consumerId, spatialLayer, temporalLayer }) => {
            const { state, peer } = ctx(meetingCode);
            await state.sfu!.setConsumerLayers(peer.peerId, consumerId, Number(spatialLayer) || 0, temporalLayer);
        });

        // ───────────────────────── COLLABORATION ─────────────────────────
        handle('meeting:chat', async ({ meetingCode, message, toPeerId }) => {
            const { state, peer } = ctx(meetingCode);
            const text = sanitizeText(message, 2000).trim();
            if (!text) throw new Error('Empty message');
            if (state.meeting && state.meeting.allow_chat !== undefined && !isTruthy(state.meeting.allow_chat) && peer.role === 'participant') {
                throw new Error('Chat is disabled by the host');
            }
            const now = Date.now();
            while (msgTimes.length && now - msgTimes[0] > 5000) msgTimes.shift();
            if (msgTimes.length >= 10) throw new Error('You are sending messages too fast');
            msgTimes.push(now);

            const msg = {
                id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
                fromPeerId: peer.peerId,
                senderName: peer.name,
                senderUserId: peer.userId,
                message: text,
                timestamp: new Date().toISOString(),
                isPrivate: !!toPeerId,
                toPeerId: toPeerId || null
            };
            if (toPeerId) {
                emitToPeer(state, toPeerId, 'meeting:chat', msg);
            } else {
                socket.to(roomName(state.code)).emit('meeting:chat', msg);
            }
            if (state.meetingId && !toPeerId) {
                MeetingDbService.saveMessage({
                    meeting_id: state.meetingId,
                    sender_id: peer.userId || undefined,
                    sender_name: peer.name,
                    content: text
                } as any).catch(err => console.error('[Meeting] save message failed:', err?.message));
            }
            return { message: msg };
        });

        handle('meeting:reaction', async ({ meetingCode, emoji }) => {
            const { state, peer } = ctx(meetingCode);
            const e = sanitizeText(emoji, 16);
            io.to(roomName(state.code)).emit('meeting:reaction', { peerId: peer.peerId, name: peer.name, emoji: e });
        });

        handle('meeting:hand', async ({ meetingCode, raised }) => {
            const { state, peer } = ctx(meetingCode);
            peer.handRaised = !!raised;
            io.to(roomName(state.code)).emit('meeting:peer-updated', { peerId: peer.peerId, handRaised: peer.handRaised });
            if (state.meetingId) {
                MeetingDbService.toggleHand(state.meetingId, peer.userId, peer.name, peer.handRaised).catch(() => {});
            }
        });

        // ───────────────────────── HOST CONTROLS ─────────────────────────
        handle('meeting:host-action', async ({ meetingCode, action, targetPeerId }) => {
            const { state, peer } = ctx(meetingCode);
            const isHost = peer.role === 'host';
            const isMod = isHost || peer.role === 'co-host';
            if (!isMod) throw new Error('Only the host or a co-host can do that');
            const target = targetPeerId ? state.peers.get(targetPeerId) : undefined;
            const room = roomName(state.code);

            switch (action) {
                case 'mute': {
                    if (!target) throw new Error('Participant not found');
                    await state.sfu?.pauseSourceOf(target.peerId, 'mic');
                    io.to(target.socketId).emit('meeting:force-mute', { by: peer.name });
                    break;
                }
                case 'mute-all': {
                    for (const p of state.peers.values()) {
                        if (p.peerId === peer.peerId || p.role !== 'participant') continue;
                        await state.sfu?.pauseSourceOf(p.peerId, 'mic');
                        io.to(p.socketId).emit('meeting:force-mute', { by: peer.name, all: true });
                    }
                    if (state.meetingId) MeetingDbService.muteAllParticipants(state.meetingId).catch(() => {});
                    break;
                }
                case 'stop-video': {
                    if (!target) throw new Error('Participant not found');
                    await state.sfu?.pauseSourceOf(target.peerId, 'webcam');
                    io.to(target.socketId).emit('meeting:force-camera-off', { by: peer.name });
                    break;
                }
                case 'stop-screen': {
                    if (!target) throw new Error('Participant not found');
                    io.to(target.socketId).emit('meeting:force-stop-screen', { by: peer.name });
                    break;
                }
                case 'lower-hand': {
                    if (!target) throw new Error('Participant not found');
                    target.handRaised = false;
                    io.to(room).emit('meeting:peer-updated', { peerId: target.peerId, handRaised: false });
                    break;
                }
                case 'lower-all-hands': {
                    for (const p of state.peers.values()) {
                        if (p.handRaised) {
                            p.handRaised = false;
                            io.to(room).emit('meeting:peer-updated', { peerId: p.peerId, handRaised: false });
                        }
                    }
                    break;
                }
                case 'remove': {
                    if (!target) throw new Error('Participant not found');
                    if (target.role === 'host') throw new Error('The host cannot be removed');
                    state.banned.add(target.userId ? `u:${target.userId}` : `p:${target.peerId}`);
                    state.banned.add(`p:${target.peerId}`);
                    io.to(target.socketId).emit('meeting:removed', { peerId: target.peerId, by: peer.name });
                    await removePeer(state, target.peerId, 'removed');
                    break;
                }
                case 'spotlight': {
                    state.spotlight = target ? target.peerId : null;
                    io.to(room).emit('meeting:spotlight', { peerId: state.spotlight });
                    break;
                }
                case 'make-cohost':
                case 'remove-cohost': {
                    if (!isHost) throw new Error('Only the host can change co-hosts');
                    if (!target) throw new Error('Participant not found');
                    if (target.role === 'host') break;
                    const newRole: Role = action === 'make-cohost' ? 'co-host' : 'participant';
                    target.role = newRole;
                    if (target.userId) {
                        if (newRole === 'co-host') state.coHostUserIds.add(target.userId);
                        else state.coHostUserIds.delete(target.userId);
                    }
                    io.to(room).emit('meeting:peer-updated', { peerId: target.peerId, role: newRole });
                    if (newRole === 'co-host') broadcastWaiting(state);
                    if (state.meetingId) {
                        MeetingDbService.updateMeetingFields(state.meetingId, { co_hosts: [...state.coHostUserIds].join(',') }).catch(() => {});
                    }
                    break;
                }
                case 'transfer-host': {
                    if (!isHost) throw new Error('Only the host can transfer host');
                    if (!target) throw new Error('Participant not found');
                    if (!target.userId) throw new Error('Guests cannot become host');
                    peer.role = 'co-host';
                    if (peer.userId) state.coHostUserIds.add(peer.userId);
                    target.role = 'host';
                    state.coHostUserIds.delete(target.userId);
                    state.hostUserId = target.userId;
                    if (state.meeting) state.meeting.host_user_id = target.userId;
                    io.to(room).emit('meeting:peer-updated', { peerId: peer.peerId, role: 'co-host' });
                    io.to(room).emit('meeting:peer-updated', { peerId: target.peerId, role: 'host' });
                    if (state.meetingId) {
                        MeetingDbService.updateMeetingFields(state.meetingId, {
                            host_user_id: target.userId,
                            co_hosts: [...state.coHostUserIds].join(',')
                        }).catch(e => console.error('[Meeting] transfer host DB update failed:', e?.message));
                    }
                    break;
                }
                case 'lock':
                case 'unlock': {
                    state.locked = action === 'lock';
                    io.to(room).emit('meeting:locked', { locked: state.locked });
                    if (state.meetingId) MeetingDbService.updateMeetingFields(state.meetingId, { lock_meeting: state.locked ? 1 : 0 }).catch(() => {});
                    break;
                }
                case 'end': {
                    if (!isHost) throw new Error('Only the host can end the meeting for everyone');
                    if (state.meetingId) {
                        await MeetingDbService.updateMeetingStatus(state.meetingId, 'completed').catch(() => {});
                        await MeetingDbService.endAllParticipants(state.meetingId).catch(() => {});
                        MeetingDbService.logMeeting(state.meetingId, peer.userId, 'ended').catch(() => {});
                    }
                    if (state.meeting) state.meeting.status = 'completed';
                    io.to(room).emit('meeting:ended', { meetingCode: state.code, by: peer.name });
                    for (const w of state.waiting.values()) io.to(w.socketId).emit('meeting:ended', { meetingCode: state.code });
                    for (const p of [...state.peers.values()]) await removePeer(state, p.peerId, 'left', false);
                    state.waiting.clear();
                    sfuManager.closeRoom(state.code);
                    state.sfu = null;
                    meetings.delete(state.code);
                    break;
                }
                default:
                    throw new Error(`Unknown action ${action}`);
            }
        });

        // Waiting room decisions
        handle('meeting:admit', async ({ meetingCode, peerId, all, reject }) => {
            const { state, peer } = ctx(meetingCode);
            if (peer.role === 'participant') throw new Error('Only the host or a co-host can admit people');
            const targets = all ? [...state.waiting.values()] : [state.waiting.get(peerId)].filter(Boolean) as WaitingPeer[];
            for (const w of targets) {
                state.waiting.delete(w.peerId);
                if (reject) {
                    io.to(w.socketId).emit('meeting:rejected', { by: peer.name });
                } else {
                    state.admitted.add(w.userId ? `u:${w.userId}` : `p:${w.peerId}`);
                    state.admitted.add(`p:${w.peerId}`);
                    io.to(w.socketId).emit('meeting:admitted', { by: peer.name });
                }
            }
            broadcastWaiting(state);
        });

        // Lightweight diagnostics for the client's "connection info" panel.
        handle('sfu:stats', async ({ meetingCode }) => {
            const { state, peer } = ctx(meetingCode);
            return { transports: await state.sfu!.getTransportStats(peer.peerId) };
        });

        // ───────────────────────── DISCONNECT ─────────────────────────
        socket.on('disconnect', async () => {
            const joined: Map<string, string> = socket.data.meetings || new Map();
            for (const [code, peerId] of [...joined.entries()]) {
                const state = meetings.get(code);
                if (!state) continue;
                const peer = state.peers.get(peerId);
                // Only remove if this socket still owns the peer (it may have rejoined on a new socket).
                if (peer && peer.socketId === socket.id) await removePeer(state, peerId, 'disconnected');
            }
            const waitingCode = socket.data.waitingFor;
            if (waitingCode) {
                const state = meetings.get(waitingCode);
                if (state) {
                    for (const [pid, w] of state.waiting) if (w.socketId === socket.id) state.waiting.delete(pid);
                    broadcastWaiting(state);
                    scheduleCloseIfEmpty(state);
                }
            }
        });
    });
}

/** Snapshot for the /meeting-health endpoint. */
export function getMeetingServerStats() {
    return {
        sfu: sfuManager.stats(),
        meetings: [...meetings.values()].map(m => ({ code: m.code, participants: m.peers.size, waiting: m.waiting.size }))
    };
}
