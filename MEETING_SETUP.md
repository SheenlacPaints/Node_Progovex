# Meeting video (SFU) — setup

The meeting now uses a **mediasoup SFU** instead of a peer-to-peer mesh. Each
participant uploads one stream to the server, and the server forwards it to
everyone else. This is what makes meetings with 100+ people possible.

## 1. Install
```
npm install          # installs mediasoup (prebuilt worker binary for Windows/Linux x64)
```
If the prebuilt download is blocked, mediasoup builds from source. That needs Python 3 and
(on Windows) the Visual Studio Build Tools with the "Desktop development with C++" workload.

Frontend: `npm install` (adds `mediasoup-client`).

## 2. Configure `.env`
All media settings are in `meeting.env` (loaded automatically). For local/LAN use nothing needs changing. **In production set `MEDIASOUP_ANNOUNCED_IP` to the server's public IP.**

## 3. Open the firewall
Allow **UDP and TCP** on `MEDIASOUP_PORT` … `MEDIASOUP_PORT + workers - 1`
(e.g. 40000–40003 on a 4-core server). Media does NOT go through nginx;
only signaling uses the existing `/node` socket.io path.

## 4. Check
`GET /meeting-health` shows workers, rooms and participants.
Startup log prints: `[SFU] mediasoup x.y: starting N worker(s); media ports ...`

## Capacity (rough)
- 1 CPU core ≈ 40–60 active participants with video. Rooms spread across cores automatically.
- Clients only receive video for tiles on screen (paginated grid, simulcast layers), so
  a 100-person meeting stays light on phones.
