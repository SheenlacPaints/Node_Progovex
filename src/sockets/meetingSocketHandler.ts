import { Server, Socket } from 'socket.io';
import { MeetingDbService } from '../services/meetingDb.service';
import { MeetingController } from '../controllers/meetingController';

interface MeetingUser {
    socketId: string;
    userId?: number;
    name: string;
    meetingCode: string;
}

const meetingRooms = new Map<string, Map<string, MeetingUser>>();

function getRoomUsers(meetingCode: string): MeetingUser[] {
    const room = meetingRooms.get(meetingCode);
    if (!room) return [];
    return Array.from(room.values());
}

function broadcastParticipantCount(io: Server, meetingCode: string): void {
    const room = meetingRooms.get(meetingCode);
    const count = room ? room.size : 0;
    io.to(`meeting_${meetingCode}`).emit('meeting:participant-count', { meetingCode, count });
}

export function registerMeetingSocketHandlers(io: Server): void {

    io.on('connection', (socket: Socket) => {
        const token = socket.handshake.auth.token;
        let currentUser: MeetingUser | null = null;

        // JOIN MEETING
        socket.on('join-meeting', async (data: { meetingCode: string; user?: any }) => {
            const { meetingCode, user } = data;

            if (!meetingRooms.has(meetingCode)) {
                meetingRooms.set(meetingCode, new Map());
            }

            const room = meetingRooms.get(meetingCode)!;
            const existingUser = room.get(socket.id);

            currentUser = {
                socketId: socket.id,
                userId: user?.id || user?.cuserid || null,
                name: user?.name || user?.fullName || user?.username || 'Guest',
                meetingCode
            };

            room.set(socket.id, currentUser);
            socket.join(`meeting_${meetingCode}`);

            const existingUsers = getRoomUsers(meetingCode).filter(u => u.socketId !== socket.id);

            socket.emit('meeting:existing-users', existingUsers.map(u => ({
                socketId: u.socketId,
                user: { name: u.name, id: u.userId }
            })));

            socket.to(`meeting_${meetingCode}`).emit('meeting:user-joined', {
                socketId: socket.id,
                user: { name: currentUser.name, id: currentUser.userId }
            });

            broadcastParticipantCount(io, meetingCode);

            console.log(`[MeetingSocket] ${currentUser.name} joined meeting ${meetingCode}`);
        });

        // WEBRTC SIGNALING - OFFER
        socket.on('meeting:offer', (data: { meetingCode: string; to: string; offer: any }) => {
            const room = meetingRooms.get(data.meetingCode);
            const sender = room?.get(socket.id);
            io.to(data.to).emit('meeting:offer', {
                from: socket.id,
                offer: data.offer,
                user: sender ? { name: sender.name, id: sender.userId } : undefined
            });
        });

        // WEBRTC SIGNALING - ANSWER
        socket.on('meeting:answer', (data: { meetingCode: string; to: string; answer: any }) => {
            io.to(data.to).emit('meeting:answer', {
                from: socket.id,
                answer: data.answer
            });
        });

        // WEBRTC SIGNALING - ICE CANDIDATE
        socket.on('meeting:ice-candidate', (data: { meetingCode: string; to: string; candidate: any }) => {
            io.to(data.to).emit('meeting:ice-candidate', {
                from: socket.id,
                candidate: data.candidate
            });
        });

        // CHAT MESSAGE
        socket.on('meeting-message', async (data: { meetingCode: string; message: string; recipientSocketId?: string }) => {
            const room = meetingRooms.get(data.meetingCode);
            const sender = room?.get(socket.id);

            if (!sender) return;

            if (data.recipientSocketId) {
                io.to(data.recipientSocketId).emit('meeting:new-message', {
                    senderSocketId: socket.id,
                    senderName: sender.name,
                    message: data.message,
                    timestamp: new Date(),
                    isPrivate: true
                });
                socket.emit('meeting:new-message', {
                    senderSocketId: socket.id,
                    senderName: sender.name,
                    message: data.message,
                    timestamp: new Date(),
                    isPrivate: true,
                    recipientSocketId: data.recipientSocketId
                });
            } else {
                io.to(`meeting_${data.meetingCode}`).emit('meeting:new-message', {
                    senderSocketId: socket.id,
                    senderName: sender.name,
                    message: data.message,
                    timestamp: new Date(),
                    isPrivate: false
                });
            }

            // Persist to DB
            try {
                const meeting = await MeetingDbService.getMeetingByCode(data.meetingCode);
                if (meeting) {
                    await MeetingDbService.saveMessage({
                        meeting_id: meeting.id,
                        sender_id: sender.userId || undefined,
                        sender_name: sender.name,
                        content: data.message
                    });
                }
            } catch (err) {
                console.error('[MeetingSocket] Error saving message:', err);
            }
        });

        // REACTION
        socket.on('meeting:reaction', async (data: { meetingCode: string; emoji: string }) => {
            const room = meetingRooms.get(data.meetingCode);
            const sender = room?.get(socket.id);
            if (!sender) return;

            io.to(`meeting_${data.meetingCode}`).emit('meeting:reaction', {
                socketId: socket.id,
                userId: sender.userId,
                userName: sender.name,
                emoji: data.emoji,
                timestamp: new Date()
            });

            try {
                const meeting = await MeetingDbService.getMeetingByCode(data.meetingCode);
                if (meeting) {
                    await MeetingDbService.addReaction(meeting.id, sender.userId || null, sender.name, data.emoji);
                }
            } catch (err) {
                console.error('[MeetingSocket] Error saving reaction:', err);
            }
        });

        // HAND RAISE
        socket.on('meeting:hand-raise', async (data: { meetingCode: string; isRaised: boolean }) => {
            const room = meetingRooms.get(data.meetingCode);
            const sender = room?.get(socket.id);
            if (!sender) return;

            io.to(`meeting_${data.meetingCode}`).emit('meeting:hand-raised', {
                socketId: socket.id,
                userId: sender.userId,
                userName: sender.name,
                is_raised: data.isRaised
            });

            try {
                const meeting = await MeetingDbService.getMeetingByCode(data.meetingCode);
                if (meeting) {
                    await MeetingDbService.toggleHand(meeting.id, sender.userId || null, sender.name, data.isRaised);
                }
            } catch (err) {
                console.error('[MeetingSocket] Error saving hand:', err);
            }
        });

        // MIC STATE CHANGE
        socket.on('meeting:mic-toggle', (data: { meetingCode: string; isMuted: boolean }) => {
            socket.to(`meeting_${data.meetingCode}`).emit('meeting:mic-changed', {
                socketId: socket.id,
                isMuted: data.isMuted
            });
        });

        // CAMERA STATE CHANGE
        socket.on('meeting:camera-toggle', (data: { meetingCode: string; isOn: boolean }) => {
            socket.to(`meeting_${data.meetingCode}`).emit('meeting:camera-changed', {
                socketId: socket.id,
                isOn: data.isOn
            });
        });

        // SCREEN SHARE
        socket.on('meeting:screen-share', (data: { meetingCode: string; isSharing: boolean }) => {
            socket.to(`meeting_${data.meetingCode}`).emit('meeting:screen-share', {
                socketId: socket.id,
                isSharing: data.isSharing
            });
        });

        // PIN / SPOTLIGHT
        socket.on('meeting:pin-user', (data: { meetingCode: string; targetSocketId: string }) => {
            io.to(`meeting_${data.meetingCode}`).emit('meeting:user-pinned', {
                pinnedBy: socket.id,
                targetSocketId: data.targetSocketId
            });
        });

        socket.on('meeting:spotlight-user', (data: { meetingCode: string; targetSocketId: string }) => {
            io.to(`meeting_${data.meetingCode}`).emit('meeting:user-spotlight', {
                targetSocketId: data.targetSocketId
            });
        });

        // HOST CONTROLS
        socket.on('meeting:mute-all', (data: { meetingCode: string }) => {
            io.to(`meeting_${data.meetingCode}`).emit('meeting:mute-all', {
                requestedBy: socket.id
            });
        });

        socket.on('meeting:remove-user', (data: { meetingCode: string; targetSocketId: string }) => {
            io.to(data.targetSocketId).emit('meeting:removed', {
                removedBy: socket.id
            });
            const targetSocket = io.sockets.sockets.get(data.targetSocketId);
            if (targetSocket) {
                targetSocket.leave(`meeting_${data.meetingCode}`);
            }
        });

        socket.on('meeting:end', (data: { meetingCode: string }) => {
            io.to(`meeting_${data.meetingCode}`).emit('meeting:ended', {
                endedBy: socket.id
            });
        });

        // LEAVE MEETING
        socket.on('leave-meeting', async (data: { meetingCode: string }) => {
            const room = meetingRooms.get(data.meetingCode);
            const user = room?.get(socket.id);

            socket.leave(`meeting_${data.meetingCode}`);
            room?.delete(socket.id);

            if (room && room.size === 0) {
                meetingRooms.delete(data.meetingCode);
            }

            socket.to(`meeting_${data.meetingCode}`).emit('meeting:user-left', {
                socketId: socket.id,
                name: user?.name
            });

            broadcastParticipantCount(io, data.meetingCode);

            try {
                const meeting = await MeetingDbService.getMeetingByCode(data.meetingCode);
                if (meeting) {
                    await MeetingDbService.removeParticipant(meeting.id, socket.id);
                    await MeetingDbService.logAttendance(meeting.id, user?.userId || null,
                        user?.name || 'Unknown', null, 'left');
                }
            } catch (err) {
                console.error('[MeetingSocket] Error on leave:', err);
            }

            console.log(`[MeetingSocket] ${user?.name || socket.id} left meeting ${data.meetingCode}`);
        });

        // DISCONNECT
        socket.on('disconnect', async () => {
            for (const [meetingCode, room] of meetingRooms.entries()) {
                const user = room.get(socket.id);
                if (user) {
                    room.delete(socket.id);

                    if (room.size === 0) {
                        meetingRooms.delete(meetingCode);
                    } else {
                        socket.to(`meeting_${meetingCode}`).emit('meeting:user-left', {
                            socketId: socket.id,
                            name: user.name
                        });
                    }

                    broadcastParticipantCount(io, meetingCode);

                    try {
                        const meeting = await MeetingDbService.getMeetingByCode(meetingCode);
                        if (meeting) {
                            await MeetingDbService.removeParticipant(meeting.id, socket.id);
                            await MeetingDbService.logAttendance(meeting.id, user.userId || null,
                                user.name, null, 'disconnected');
                        }
                    } catch (err) {
                        console.error('[MeetingSocket] Error on disconnect:', err);
                    }

                    console.log(`[MeetingSocket] ${user.name} disconnected from ${meetingCode}`);
                    break;
                }
            }
        });
    });
}
