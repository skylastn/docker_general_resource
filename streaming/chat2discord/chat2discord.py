#!/usr/bin/env python3
"""Collect YouTube / Twitch / Facebook live chat into one Discord webhook.

Stdlib only. Config reloaded from disk every 60s (edit per-session video URL
without restarting). ponytail: per-session video ids for YouTube/Facebook are
manual; add auto-discovery (search.list, 100 calls/day bucket) only if editing
the config each session gets annoying.
"""
import json
import os
import queue
import random
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG_PATH = os.environ.get("CONFIG", "/app/config.json")
LOCK = threading.Lock()
CFG = {}
CFG_MTIME = 0

# (display name, embed color) per source.
PLATFORM = {"twitch": ("Twitch", 0x9146FF), "youtube": ("YouTube", 0xFF0000),
            "facebook": ("Facebook", 0x1877F2), "sys": ("System", 0x5865F2)}


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def load_config(force=False):
    global CFG, CFG_MTIME
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
    except OSError:
        return CFG
    if not force and mtime == CFG_MTIME:
        return CFG
    try:
        with open(CONFIG_PATH) as f:
            data = json.load(f)
    except Exception as e:
        log("config error: %s" % e)
        return CFG
    with LOCK:
        CFG, CFG_MTIME = data, mtime
    log("config loaded (yt=%s fb=%s twitch=%s)" % (
        bool(data.get("youtube", {}).get("api_key")),
        bool(data.get("facebook", {}).get("access_token")),
        bool(data.get("twitch_channel"))))
    return CFG


def cfg_get(*path):
    cur = load_config()
    for key in path:
        cur = cur.get(key, "") if isinstance(cur, dict) else ""
    return cur if isinstance(cur, str) else ""


# --- Discord -----------------------------------------------------------------
OUT = queue.Queue()
LAST_POST = [0.0]


def post_discord(payload):
    """Send one webhook payload (dict); honors 429 retry_after."""
    payload.setdefault("allowed_mentions", {"parse": []})
    body = json.dumps(payload).encode()
    for attempt in range(4):
        wait = 1.2 - (time.time() - LAST_POST[0])
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(cfg_get("discord_webhook"), data=body,
                                     headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 chat2discord/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                LAST_POST[0] = time.time()
                return True
        except urllib.error.HTTPError as e:
            LAST_POST[0] = time.time()
            if e.code == 429:
                try:
                    time.sleep(float(json.loads(e.read()).get("retry_after", 2)))
                except Exception:
                    time.sleep(3)
                continue
            log("discord HTTP %s: %s" % (e.code, e.read()[:200]))
            return False
        except Exception as e:
            log("discord error: %s" % e)
            time.sleep(3)
    return False


def flusher():
    """Batch queued chats into Discord embeds (max 10 per request)."""
    while True:
        time.sleep(1.5)
        if not cfg_get("discord_webhook"):
            continue
        batch = []
        while True:
            try:
                batch.append(OUT.get_nowait())
            except queue.Empty:
                break
        if not batch:
            continue
        embeds = []
        for source, author, text, icon in batch[:40]:
            label, color = PLATFORM.get(source, (source, 0x5865F2))
            author_obj = {"name": author}
            if icon:
                author_obj["icon_url"] = icon
            embeds.append({
                "color": color,
                "author": author_obj,
                "description": text[:3800],
                "footer": {"text": "from " + label},
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
        if len(batch) > 40:
            embeds.append({"color": 0x5865F2, "description": "_…+%d pesan lagi_" % (len(batch) - 40),
                           "footer": {"text": "from System"}})
        for i in range(0, len(embeds), 10):
            post_discord({"embeds": embeds[i:i + 10]})


def enqueue(source, author, text, icon=None):
    text = " ".join(str(text).split())
    if text:
        OUT.put((source, str(author)[:64], text, icon))


# --- Twitch (IRC, anonymous read-only, no key) --------------------------------
def twitch_loop():
    while True:
        channel = cfg_get("twitch_channel").strip().lower().lstrip("#")
        if not channel:
            time.sleep(15)
            continue
        try:
            sock = socket.create_connection(("irc.chat.twitch.tv", 6667), 30)
            sock.sendall(("NICK justinfan%d\r\nJOIN #%s\r\n" % (random.randint(10000, 99999), channel)).encode())
            sock.settimeout(90)
            log("twitch joined #%s" % channel)
            buf = b""
            while True:
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    # quiet channel: keep the connection alive instead of reconnecting
                    sock.sendall(b"PING :tmi.twitch.tv\r\n")
                    continue
                if not chunk:
                    raise ConnectionError("closed")
                buf += chunk
                while b"\r\n" in buf:
                    raw, buf = buf.split(b"\r\n", 1)
                    line = raw.decode("utf-8", "replace")
                    if line.startswith("PING"):
                        sock.sendall(b"PONG :tmi.twitch.tv\r\n")
                        continue
                    if line.startswith("@"):
                        line = line.split(" ", 1)[-1]
                    m = re.match(r":([^!\s]+)![^\s]* PRIVMSG #[^\s]+ :(.*)", line)
                    if m:
                        enqueue("twitch", m.group(1), m.group(2))
        except Exception as e:
            log("twitch error: %s" % e)
            time.sleep(6)


# --- YouTube live chat --------------------------------------------------------
def http_get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 chat2discord/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def extract_video_id(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    m = re.search(r"(?:v=|youtu\.be/|shorts/|live/)([\w-]{11})", raw)
    if m:
        return m.group(1)
    return raw if re.fullmatch(r"[\w-]{11}", raw) else ""


def youtube_loop():
    chat_id, page_token, notify_quota = None, None, False
    while True:
        key, video = cfg_get("youtube", "api_key"), cfg_get("youtube", "video_url") or cfg_get("youtube", "video_id")
        vid = extract_video_id(video)
        if not key or not vid:
            chat_id = None
            time.sleep(15)
            continue
        try:
            if not chat_id:
                data = http_get_json("https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=%s&key=%s"
                                     % (urllib.parse.quote(vid), urllib.parse.quote(key)))
                details = (data.get("items") or [{}])[0].get("liveStreamingDetails", {})
                chat_id = details.get("activeLiveChatId")
                page_token = None
                if not chat_id:
                    time.sleep(30)
                    continue
                log("youtube chat id=%s" % chat_id)
            url = ("https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=%s&part=snippet,authorDetails&maxResults=200&key=%s"
                   % (urllib.parse.quote(chat_id), urllib.parse.quote(key)))
            if page_token:
                url += "&pageToken=" + urllib.parse.quote(page_token)
            data = http_get_json(url)
            for item in data.get("items", []):
                sn, au = item.get("snippet", {}), item.get("authorDetails", {})
                kind = sn.get("type")
                if kind == "textMessageEvent":
                    enqueue("youtube", au.get("authorDisplayName", "?"),
                            sn.get("textMessageDetails", {}).get("messageText", ""),
                            au.get("profileImageUrl"))
                elif kind == "superChatEvent":
                    enqueue("youtube", "%s (%s %s)" % (au.get("authorDisplayName", "?"),
                                                       sn.get("superChatDetails", {}).get("amountDisplayString", ""),
                                                       sn.get("currency", "")),
                            sn.get("superChatDetails", {}).get("message", ""),
                            au.get("profileImageUrl"))
            page_token = data.get("nextPageToken")
            wait = float(data.get("pollingIntervalMillis", 5000)) / 1000.0
            time.sleep(max(1.5, min(wait, 30)))
            notify_quota = False
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            reason = ""
            try:
                reason = json.loads(body)["error"]["errors"][0].get("reason", "")
            except Exception:
                pass
            if reason in ("liveChatEnded", "liveChatNotFound", "liveChatDisabled") or e.code == 404:
                log("youtube chat ended (%s)" % reason)
                chat_id, page_token = None, None
                time.sleep(30)
            elif reason in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"):
                if not notify_quota:
                    enqueue("sys", "YouTube", "API quota/rate limit kena — polling dijeda 5 menit")
                    notify_quota = True
                log("youtube quota: %s" % reason)
                time.sleep(300)
            else:
                log("youtube HTTP %s: %s" % (e.code, body[:200]))
                time.sleep(30)
        except Exception as e:
            log("youtube error: %s" % e)
            time.sleep(20)


# --- Facebook live comments ---------------------------------------------------
def extract_fb_id(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    m = re.search(r"/(?:videos|watch/live|posts|reel)/(?:\D{0,20})?(\d{6,})", raw)
    if m:
        return m.group(1)
    return raw if re.fullmatch(r"\d{6,}", raw) else ""


def facebook_loop():
    seen, since, notify_err = set(), int(time.time()), 0.0
    while True:
        token = cfg_get("facebook", "access_token")
        vid = extract_fb_id(cfg_get("facebook", "video_url") or cfg_get("facebook", "video_id"))
        if not token or not vid:
            time.sleep(15)
            continue
        try:
            q = urllib.parse.urlencode({"access_token": token, "order": "reverse_chronological",
                                        "limit": "50", "since": str(since), "fields": "id,message,from,created_time"})
            data = http_get_json("https://graph.facebook.com/v21.0/%s/comments?%s" % (vid, q))
            for item in data.get("data", []):
                cid = item.get("id")
                if cid in seen or not item.get("message"):
                    continue
                seen.add(cid)
                if len(seen) > 3000:
                    seen = set(list(seen)[-1500:])
                enqueue("facebook", (item.get("from") or {}).get("name", "?"), item.get("message"))
            notify_err = 0.0
            time.sleep(8)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if time.time() - notify_err > 300:
                enqueue("sys", "Facebook", "Graph API error HTTP %s: %s" % (e.code, body[:200]))
                notify_err = time.time()
            log("facebook HTTP %s: %s" % (e.code, body[:200]))
            time.sleep(60)
        except Exception as e:
            log("facebook error: %s" % e)
            time.sleep(20)


def selftest():
    cfg = load_config(force=True)
    assert cfg.get("discord_webhook", "").startswith("https://discord.com/api/webhooks/"), "discord_webhook missing"
    print("config OK | twitch=%r yt_video=%r fb_video=%r" % (
        cfg.get("twitch_channel"), extract_video_id(cfg.get("youtube", {}).get("video_url")),
        extract_fb_id(cfg.get("facebook", {}).get("video_url"))))
    ok = post_discord({"content": "selftest OK", "embeds": [{
        "color": 0x5865F2, "author": {"name": "chat2discord"},
        "description": "Collector aktif — menunggu OBS mulai streaming.",
        "footer": {"text": "from System"},
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}]})
    print("webhook test:", "OK" if ok else "FAILED")
    return 0 if ok else 1


def main():
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    load_config(force=True)
    for fn in (twitch_loop, youtube_loop, facebook_loop, flusher):
        threading.Thread(target=fn, daemon=True).start()
    log("chat2discord started")
    while True:
        time.sleep(60)
        load_config()


if __name__ == "__main__":
    main()
