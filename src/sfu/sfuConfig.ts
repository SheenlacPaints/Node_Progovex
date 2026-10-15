import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

// Meeting/media settings live in `meeting.env` next to package.json (values
// already set in the real environment or .env take precedence).
dotenv.config({ path: path.resolve(process.cwd(), 'meeting.env') });

/**
 * Configuration for the mediasoup SFU (Selective Forwarding Unit).
 *
 * Why an SFU: the old meeting used a full P2P mesh, where every browser uploads
 * its camera once PER participant. That collapses at ~6-8 people (and much
 * earlier on phones). With the SFU each client uploads ONE stream and the server
 * forwards it, so 100+ participants per meeting become possible.
 *
 * All values can be overridden with environment variables (see .env.meeting.example).
 */

function firstLanIPv4(): string | undefined {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return undefined;
}

const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
};

const cpuCount = Math.max(1, os.cpus()?.length || 1);

export const sfuConfig = {
    /** Number of mediasoup worker processes (each uses one CPU core). */
    numWorkers: Math.min(num(process.env.MEDIASOUP_NUM_WORKERS, cpuCount), 32),

    /** IP the media sockets bind to. */
    listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',

    /**
     * IP or hostname announced to browsers in ICE candidates. MUST be the server's
     * PUBLIC IP in production (otherwise remote users cannot receive media).
     * Falls back to the first LAN IPv4 so LAN testing works out of the box.
     */
    announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || process.env.MEDIASOUP_ANNOUNCED_ADDRESS || firstLanIPv4() || '127.0.0.1',

    /**
     * First media port. Worker N listens on (basePort + N) for BOTH UDP and TCP,
     * so the firewall only needs a small range: basePort .. basePort + numWorkers - 1.
     */
    basePort: num(process.env.MEDIASOUP_PORT, 40000),

    /** Peers per router before the room spills over onto another CPU core. */
    maxPeersPerRouter: num(process.env.MEDIASOUP_MAX_PEERS_PER_ROUTER, 40),

    /** Hard cap of participants per meeting. */
    maxParticipantsPerMeeting: num(process.env.MEETING_MAX_PARTICIPANTS, 300),

    initialAvailableOutgoingBitrate: num(process.env.MEDIASOUP_INITIAL_OUTGOING_BITRATE, 1_000_000),
    maxIncomingBitrate: num(process.env.MEDIASOUP_MAX_INCOMING_BITRATE, 3_000_000),

    logLevel: (process.env.MEDIASOUP_LOG_LEVEL || 'warn') as 'debug' | 'warn' | 'error' | 'none',

    mediaCodecs: [
        {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            parameters: { useinbandfec: 1, usedtx: 1 }
        },
        {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
            parameters: { 'x-google-start-bitrate': 600 }
        },
        {
            kind: 'video',
            mimeType: 'video/H264',
            clockRate: 90000,
            parameters: {
                'packetization-mode': 1,
                'profile-level-id': '42e01f',
                'level-asymmetry-allowed': 1,
                'x-google-start-bitrate': 600
            }
        }
    ] as any[]
};
