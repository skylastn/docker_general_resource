# Oryx (restream server)

`ossrs/oryx:5` — publish one stream, forward it to many platforms (YouTube, Twitch,
Facebook, any RTMP URL).

Deploy from repo root:

    docker compose -f streaming/docker-compose.oryx.yml up -d
    # or: make deploy_oryx

## Ports

| Port | Proto | Purpose |
|---|---|---|
| `ORYX_HTTP_PORT` (2022) | tcp | Management UI, bound to `BIND_IP` (loopback default) |
| `ORYX_RTMP_PORT` (1935) | tcp | RTMP ingest (OBS) — public |
| `ORYX_SRT_PORT` (10080) | udp | SRT ingest — public |

Open the UI: set `BIND_IP=0.0.0.0` in `.env`, or SSH tunnel
`ssh -L 2022:127.0.0.1:2022 <server>` then http://127.0.0.1:2022/mgmt.

## Restream setup

1. First visit: set the admin password (anyone reaching the page first can claim the instance).
2. Scenarios > Streaming: copy the publish URL, e.g.
   `rtmp://SERVER_IP/live/<stream>?secret=<token>` — put it in OBS.
3. Scenarios > Forward > New: paste platform stream key/URL (YouTube `rtmp://a.rtmp.youtube.live2/`,
   Twitch `rtmp://live.twitch.tv/app/`, Facebook RTMP) and Start Forward.
4. Firewall/security group: open 1935/tcp and 10080/udp (8000/udp only if you uncomment WebRTC).

## Notes

- Data (console password, forward targets) lives in the `oryx_data` volume — back it up.
- Only one Oryx instance per server (fixed host ports).
- Raise `LIMIT_RAM` / `LIMIT_CPU` in `.env` if you transcode or forward to many targets.
