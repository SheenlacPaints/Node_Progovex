/**
 * mediasoup SFU manager.
 *
 *  - One mediasoup Worker per CPU core, each with a WebRtcServer listening on a
 *    single UDP+TCP port (basePort + workerIndex).
 *  - One SfuRoom per meeting. A room starts on one Router; when it grows past
 *    `maxPeersPerRouter` peers it gets another Router on another Worker (CPU core)
 *    and every Producer is piped between the room's routers. That is what lets a
 *    single meeting scale past what one CPU core can forward (100+ users).
 *  - An AudioLevelObserver on the room's first router reports who is speaking.
 */
import { EventEmitter } from 'events';
import { sfuConfig } from './sfuConfig';

// mediasoup is loaded lazily so the rest of the API still boots if the native
// worker binary is missing (meetings then report "media server unavailable").
let mediasoup: any = null;
let mediasoupLoadError: string | null = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mediasoup = require('mediasoup');
} catch (e: any) {
    mediasoupLoadError = e?.message || String(e);
}

type MsWorker = any;
type MsRouter = any;
type MsTransport = any;
type MsProducer = any;
type MsConsumer = any;
type MsWebRtcServer = any;

interface WorkerEntry {
    index: number;
    worker: MsWorker;
    webRtcServer: MsWebRtcServer;
    routerCount: number;
}

interface RouterEntry {
    router: MsRouter;
    worker: WorkerEntry;
    peerCount: number;
}

export type MediaSource = 'mic' | 'webcam' | 'screen' | 'screen-audio';

export interface ProducerInfo {
    producerId: string;
    peerId: string;
    kind: 'audio' | 'video';
    source: MediaSource;
    paused: boolean;
}

export class SfuPeer {
    transports = new Map<string, MsTransport>();
    producers = new Map<string, MsProducer>();
    consumers = new Map<string, MsConsumer>();
    rtpCapabilities: any = null;
    constructor(public id: string, public routerEntry: RouterEntry) {}

    close() {
        // Closing transports closes their producers/consumers too.
        for (const t of this.transports.values()) {
            try { t.close(); } catch { /* noop */ }
        }
        this.transports.clear();
        this.producers.clear();
        this.consumers.clear();
    }
}

/**
 * Events emitted by a room (consumed by the socket layer):
 *  'producer:new'     (info: ProducerInfo)
 *  'producer:closed'  ({ producerId, peerId })
 *  'producer:state'   (info: ProducerInfo)           — pause / resume
 *  'consumer:closed'  ({ peerId, consumerId, producerId })
 *  'consumer:state'   ({ peerId, consumerId, producerPaused })
 *  'consumer:layers'  ({ peerId, consumerId, spatialLayer, temporalLayer })
 *  'speaking'         ({ peerIds: string[], dominant: string | null })
 */
export class SfuRoom extends EventEmitter {
    readonly routers: RouterEntry[] = [];
    readonly peers = new Map<string, SfuPeer>();
    private audioObserver: any = null;
    private closed = false;
    private lastDominant: string | null = null;
    private silenceTimer: any = null;

    constructor(public readonly id: string, private manager: SfuManager) {
        super();
        this.setMaxListeners(50);
    }

    get rtpCapabilities() {
        return this.routers[0]?.router.rtpCapabilities;
    }

    async init(): Promise<void> {
        const entry = await this.addRouter();
        this.audioObserver = await entry.router.createAudioLevelObserver({
            maxEntries: 6,
            threshold: -65,
            interval: 700
        });
        this.audioObserver.on('volumes', (volumes: any[]) => {
            const peerIds: string[] = [];
            for (const v of volumes) {
                const pid = v.producer?.appData?.peerId;
                if (pid && !peerIds.includes(pid)) peerIds.push(pid);
            }
            const dominant = peerIds[0] || null;
            if (dominant) this.lastDominant = dominant;
            clearTimeout(this.silenceTimer);
            this.emit('speaking', { peerIds, dominant: this.lastDominant });
        });
        this.audioObserver.on('silence', () => {
            // Keep the last dominant speaker on stage; only clear the "speaking" rings.
            this.emit('speaking', { peerIds: [], dominant: this.lastDominant });
        });
    }

    private async addRouter(): Promise<RouterEntry> {
        const used = new Set(this.routers.map(r => r.worker.index));
        const worker = this.manager.pickWorker(used);
        if (!worker) throw new Error('No mediasoup worker available');
        const router = await worker.worker.createRouter({ mediaCodecs: sfuConfig.mediaCodecs });
        worker.routerCount++;
        router.observer.on('close', () => { worker.routerCount = Math.max(0, worker.routerCount - 1); });
        const entry: RouterEntry = { router, worker, peerCount: 0 };
        this.routers.push(entry);

        // Pipe every producer that already exists in the room into the new router.
        if (this.routers.length > 1) {
            for (const peer of this.peers.values()) {
                for (const producer of peer.producers.values()) {
                    await this.pipeProducer(peer.routerEntry, producer.id, entry).catch(e =>
                        console.error('[SFU] pipe existing producer failed:', e?.message));
                }
            }
            console.log(`[SFU] Room ${this.id} scaled to ${this.routers.length} routers`);
        }
        return entry;
    }

    private async pipeProducer(from: RouterEntry, producerId: string, to: RouterEntry) {
        if (from === to) return;
        const { pipeProducer } = await from.router.pipeToRouter({ producerId, router: to.router });
        // The audio observer lives on routers[0]; register piped audio there too.
        if (to === this.routers[0] && pipeProducer?.kind === 'audio' && this.audioObserver) {
            const orig = this.findProducer(producerId);
            if (orig?.appData?.source === 'mic') {
                pipeProducer.appData = { ...orig.appData };
                await this.audioObserver.addProducer({ producerId: pipeProducer.id }).catch(() => {});
            }
        }
    }

    /** Choose a router for a new peer, adding one on another CPU core if all are full. */
    private async routerForNewPeer(): Promise<RouterEntry> {
        let best = this.routers.reduce((a, b) => (a.peerCount <= b.peerCount ? a : b));
        if (best.peerCount >= sfuConfig.maxPeersPerRouter && this.routers.length < this.manager.workerCount) {
            best = await this.addRouter();
        }
        return best;
    }

    async addPeer(peerId: string): Promise<SfuPeer> {
        this.removePeer(peerId);
        const entry = await this.routerForNewPeer();
        entry.peerCount++;
        const peer = new SfuPeer(peerId, entry);
        this.peers.set(peerId, peer);
        return peer;
    }

    removePeer(peerId: string) {
        const peer = this.peers.get(peerId);
        if (!peer) return;
        this.peers.delete(peerId);
        peer.routerEntry.peerCount = Math.max(0, peer.routerEntry.peerCount - 1);
        const producerIds = [...peer.producers.keys()];
        peer.close();
        for (const producerId of producerIds) this.emit('producer:closed', { producerId, peerId });
    }

    getPeer(peerId: string): SfuPeer {
        const p = this.peers.get(peerId);
        if (!p) throw new Error('Peer not found in media room');
        return p;
    }

    listProducers(exceptPeerId?: string): ProducerInfo[] {
        const out: ProducerInfo[] = [];
        for (const peer of this.peers.values()) {
            if (peer.id === exceptPeerId) continue;
            for (const p of peer.producers.values()) out.push(this.info(peer.id, p));
        }
        return out;
    }

    private info(peerId: string, p: MsProducer): ProducerInfo {
        return { producerId: p.id, peerId, kind: p.kind, source: p.appData?.source || (p.kind === 'audio' ? 'mic' : 'webcam'), paused: p.paused };
    }

    private findProducer(producerId: string): MsProducer | undefined {
        for (const peer of this.peers.values()) {
            const p = peer.producers.get(producerId);
            if (p) return p;
        }
        return undefined;
    }

    async createWebRtcTransport(peerId: string, direction: 'send' | 'recv') {
        const peer = this.getPeer(peerId);
        const { router, worker } = peer.routerEntry;
        const transport = await router.createWebRtcTransport({
            webRtcServer: worker.webRtcServer,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: sfuConfig.initialAvailableOutgoingBitrate,
            appData: { peerId, direction }
        });
        if (direction === 'send') {
            await transport.setMaxIncomingBitrate(sfuConfig.maxIncomingBitrate).catch(() => {});
        }
        transport.on('dtlsstatechange', (state: string) => {
            if (state === 'failed' || state === 'closed') {
                console.warn(`[SFU] transport ${transport.id} (${peerId}/${direction}) dtls ${state}`);
            }
        });
        peer.transports.set(transport.id, transport);
        return {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters
        };
    }

    async connectTransport(peerId: string, transportId: string, dtlsParameters: any) {
        const t = this.getPeer(peerId).transports.get(transportId);
        if (!t) throw new Error('Transport not found');
        await t.connect({ dtlsParameters });
    }

    async restartIce(peerId: string, transportId: string) {
        const t = this.getPeer(peerId).transports.get(transportId);
        if (!t) throw new Error('Transport not found');
        return await t.restartIce();
    }

    async produce(peerId: string, transportId: string, kind: 'audio' | 'video', rtpParameters: any, appData: any) {
        const peer = this.getPeer(peerId);
        const t = peer.transports.get(transportId);
        if (!t) throw new Error('Transport not found');
        const source: MediaSource = ['mic', 'webcam', 'screen', 'screen-audio'].includes(appData?.source)
            ? appData.source : (kind === 'audio' ? 'mic' : 'webcam');

        // Only one producer per source per peer (e.g. re-publishing a camera).
        for (const existing of peer.producers.values()) {
            if (existing.appData?.source === source) {
                existing.close();
                peer.producers.delete(existing.id);
                this.emit('producer:closed', { producerId: existing.id, peerId });
            }
        }

        const producer = await t.produce({
            kind,
            rtpParameters,
            paused: !!appData?.paused,
            appData: { peerId, source }
        });
        peer.producers.set(producer.id, producer);

        producer.on('transportclose', () => {
            peer.producers.delete(producer.id);
        });

        if (kind === 'audio' && source === 'mic' && peer.routerEntry === this.routers[0]) {
            await this.audioObserver?.addProducer({ producerId: producer.id }).catch(() => {});
        }

        // Make the producer available on every other router of the room.
        for (const entry of this.routers) {
            if (entry !== peer.routerEntry) {
                await this.pipeProducer(peer.routerEntry, producer.id, entry).catch(e =>
                    console.error('[SFU] pipeToRouter failed:', e?.message));
            }
        }

        this.emit('producer:new', this.info(peerId, producer));
        return producer.id;
    }

    async closeProducer(peerId: string, producerId: string) {
        const peer = this.getPeer(peerId);
        const p = peer.producers.get(producerId);
        if (!p) return;
        p.close();
        peer.producers.delete(producerId);
        this.emit('producer:closed', { producerId, peerId });
    }

    async setProducerPaused(peerId: string, producerId: string, paused: boolean) {
        const p = this.getPeer(peerId).producers.get(producerId);
        if (!p) throw new Error('Producer not found');
        if (paused) await p.pause(); else await p.resume();
        this.emit('producer:state', this.info(peerId, p));
    }

    /** Server-side enforcement used by host controls (mute participant / stop video). */
    async pauseSourceOf(peerId: string, source: MediaSource) {
        const peer = this.peers.get(peerId);
        if (!peer) return;
        for (const p of peer.producers.values()) {
            if (p.appData?.source === source && !p.paused) {
                await p.pause();
                this.emit('producer:state', this.info(peerId, p));
            }
        }
    }

    async consume(peerId: string, producerId: string, transportId?: string) {
        const peer = this.getPeer(peerId);
        if (!peer.rtpCapabilities) throw new Error('rtpCapabilities not set');
        const router = peer.routerEntry.router;
        // A producer created on another router may still be in flight through
        // pipeToRouter — give it a moment before giving up.
        for (let i = 0; !router.canConsume({ producerId, rtpCapabilities: peer.rtpCapabilities }); i++) {
            if (i >= 10 || !this.findProducer(producerId)) throw new Error('Cannot consume this producer');
            await new Promise(r => setTimeout(r, 200));
        }
        // Reuse an existing consumer for this producer.
        for (const c of peer.consumers.values()) {
            if (c.producerId === producerId) return this.consumerParams(c);
        }
        const transport = transportId
            ? peer.transports.get(transportId)
            : [...peer.transports.values()].find(t => t.appData?.direction === 'recv');
        if (!transport) throw new Error('Receive transport not found');

        const source = this.findProducer(producerId)?.appData;
        const consumer = await transport.consume({
            producerId,
            rtpCapabilities: peer.rtpCapabilities,
            paused: true, // client resumes when it is ready / the tile is visible
            appData: { peerId: source?.peerId, source: source?.source }
        });
        peer.consumers.set(consumer.id, consumer);

        if (consumer.kind === 'video') {
            // Start small; the client asks for higher layers for big tiles.
            const spatial = source?.source === 'screen' ? 2 : 0;
            await consumer.setPreferredLayers({ spatialLayer: spatial, temporalLayer: 2 }).catch(() => {});
            await consumer.setPriority(source?.source === 'screen' ? 255 : 100).catch(() => {});
        } else {
            await consumer.setPriority(200).catch(() => {});
        }

        const cleanup = () => {
            peer.consumers.delete(consumer.id);
            this.emit('consumer:closed', { peerId, consumerId: consumer.id, producerId });
        };
        consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
        consumer.on('producerclose', cleanup);
        consumer.on('producerpause', () => this.emit('consumer:state', { peerId, consumerId: consumer.id, producerPaused: true }));
        consumer.on('producerresume', () => this.emit('consumer:state', { peerId, consumerId: consumer.id, producerPaused: false }));

        return this.consumerParams(consumer);
    }

    private consumerParams(c: MsConsumer) {
        return {
            id: c.id,
            producerId: c.producerId,
            kind: c.kind,
            rtpParameters: c.rtpParameters,
            type: c.type,
            producerPaused: c.producerPaused,
            peerId: c.appData?.peerId,
            source: c.appData?.source
        };
    }

    async setConsumerPaused(peerId: string, consumerId: string, paused: boolean) {
        const c = this.getPeer(peerId).consumers.get(consumerId);
        if (!c) throw new Error('Consumer not found');
        if (paused) await c.pause(); else await c.resume();
    }

    async closeConsumer(peerId: string, consumerId: string) {
        const peer = this.getPeer(peerId);
        const c = peer.consumers.get(consumerId);
        if (!c) return;
        c.close();
        peer.consumers.delete(consumerId);
    }

    async setConsumerLayers(peerId: string, consumerId: string, spatialLayer: number, temporalLayer?: number) {
        const c = this.getPeer(peerId).consumers.get(consumerId);
        if (!c || c.type !== 'simulcast') return;
        await c.setPreferredLayers({ spatialLayer, temporalLayer: temporalLayer ?? 2 });
    }

    async getTransportStats(peerId: string) {
        const peer = this.peers.get(peerId);
        if (!peer) return [];
        const out: any[] = [];
        for (const t of peer.transports.values()) {
            const s = await t.getStats().catch(() => []);
            out.push({ id: t.id, direction: t.appData?.direction, stats: s });
        }
        return out;
    }

    get isEmpty() { return this.peers.size === 0; }

    close() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.silenceTimer);
        for (const peer of this.peers.values()) peer.close();
        this.peers.clear();
        for (const r of this.routers) { try { r.router.close(); } catch { /* noop */ } }
        this.routers.length = 0;
        this.removeAllListeners();
    }
}

export class SfuManager {
    private workers: WorkerEntry[] = [];
    private rooms = new Map<string, SfuRoom>();
    private roomCreation = new Map<string, Promise<SfuRoom>>();
    private ready: Promise<void> | null = null;
    private initError: string | null = null;

    get available() { return !!mediasoup && !this.initError && this.workers.length > 0; }
    get unavailableReason() {
        return mediasoupLoadError
            ? `mediasoup is not installed (${mediasoupLoadError}). Run "npm install mediasoup" in the backend.`
            : this.initError;
    }
    get workerCount() { return this.workers.length; }

    init(): Promise<void> {
        if (this.ready) return this.ready;
        this.ready = this.startWorkers().catch(e => {
            this.initError = e?.message || String(e);
            console.error('[SFU] Failed to start mediasoup workers:', this.initError);
        });
        return this.ready;
    }

    private async startWorkers() {
        if (!mediasoup) {
            console.error(`[SFU] ${this.unavailableReason}`);
            return;
        }
        console.log(`[SFU] mediasoup ${mediasoup.version}: starting ${sfuConfig.numWorkers} worker(s); ` +
            `media ports ${sfuConfig.basePort}-${sfuConfig.basePort + sfuConfig.numWorkers - 1} (UDP+TCP), ` +
            `announced address ${sfuConfig.announcedAddress}`);
        for (let i = 0; i < sfuConfig.numWorkers; i++) {
            await this.startWorker(i);
        }
    }

    private async startWorker(index: number) {
        const worker = await mediasoup.createWorker({ logLevel: sfuConfig.logLevel });
        const port = sfuConfig.basePort + index;
        const webRtcServer = await worker.createWebRtcServer({
            listenInfos: [
                { protocol: 'udp', ip: sfuConfig.listenIp, announcedAddress: sfuConfig.announcedAddress, port },
                { protocol: 'tcp', ip: sfuConfig.listenIp, announcedAddress: sfuConfig.announcedAddress, port }
            ]
        });
        const entry: WorkerEntry = { index, worker, webRtcServer, routerCount: 0 };
        this.workers[index] = entry;

        worker.on('died', (err: any) => {
            console.error(`[SFU] mediasoup worker ${index} died (${err?.message}) — restarting in 2s`);
            // Rooms on this worker lost their media; close them so clients rejoin cleanly.
            for (const [id, room] of this.rooms) {
                if (room.routers.some(r => r.worker === entry)) {
                    room.emit('room:died');
                    room.close();
                    this.rooms.delete(id);
                }
            }
            setTimeout(() => this.startWorker(index).catch(e =>
                console.error(`[SFU] restart of worker ${index} failed:`, e?.message)), 2000);
        });
    }

    /** Least-loaded worker not in `exclude` (routers of a room must be on different workers). */
    pickWorker(exclude: Set<number>): WorkerEntry | undefined {
        const candidates = this.workers.filter(w => w && !exclude.has(w.index));
        if (!candidates.length) return undefined;
        return candidates.reduce((a, b) => (a.routerCount <= b.routerCount ? a : b));
    }

    async getOrCreateRoom(roomId: string): Promise<SfuRoom> {
        await this.init();
        if (!this.available) throw new Error(this.unavailableReason || 'Media server unavailable');
        const existing = this.rooms.get(roomId);
        if (existing) return existing;
        const pending = this.roomCreation.get(roomId);
        if (pending) return pending;
        const p = (async () => {
            const room = new SfuRoom(roomId, this);
            await room.init();
            this.rooms.set(roomId, room);
            return room;
        })();
        this.roomCreation.set(roomId, p);
        try { return await p; } finally { this.roomCreation.delete(roomId); }
    }

    getRoom(roomId: string): SfuRoom | undefined {
        return this.rooms.get(roomId);
    }

    closeRoom(roomId: string) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.close();
        this.rooms.delete(roomId);
        console.log(`[SFU] Room ${roomId} closed`);
    }

    stats() {
        return {
            available: this.available,
            reason: this.available ? undefined : this.unavailableReason,
            workers: this.workers.filter(Boolean).map(w => ({ index: w.index, pid: w.worker.pid, routers: w.routerCount })),
            rooms: [...this.rooms.values()].map(r => ({
                id: r.id,
                peers: r.peers.size,
                routers: r.routers.map(x => ({ worker: x.worker.index, peers: x.peerCount }))
            }))
        };
    }
}

export const sfuManager = new SfuManager();
