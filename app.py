"""
Telegram Channel Backup Tool - Flask Web Edition
==================================================
A local web app (Flask + Telethon) that replaces the old Tkinter GUI with a
responsive browser UI. Runs entirely on your machine - Flask just serves the
page to your own browser at http://127.0.0.1:5000.

Why this bypasses "Restrict Saving Content": that toggle only disables the
forward/save buttons inside official Telegram client UIs. Telethon talks to
Telegram's MTProto API directly, and since your account is a genuine member
of the channel, the server still delivers the media to it - this tool just
saves what your account is already authorized to receive.

Run:
    pip install -r requirements.txt
    python app.py
Then open http://127.0.0.1:5000 in your browser.
"""

import asyncio
import base64
import io
import json
import os
import queue
import threading
import time
import traceback
import uuid
from datetime import datetime

from flask import Flask, request, jsonify, Response, render_template, stream_with_context

from telethon import TelegramClient, errors
from telethon.tl.functions.channels import GetFullChannelRequest
from telethon.tl.types import Channel, Chat, User

SESSION_NAME = "backup_session"

app = Flask(__name__)


# --------------------------------------------------------------------------
# Background asyncio loop - Telethon is async, Flask request handlers are
# sync, so every Telethon call is scheduled onto this persistent loop and we
# block the (sync) Flask worker thread on the result. Flask's dev server
# handles each request on its own thread, so this does not freeze the UI.
# --------------------------------------------------------------------------
class AsyncLoopThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.loop = asyncio.new_event_loop()
        self._ready = threading.Event()

    def run(self):
        asyncio.set_event_loop(self.loop)
        self._ready.set()
        self.loop.run_forever()

    def run_coro(self, coro, timeout=None):
        self._ready.wait()
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return fut.result(timeout=timeout)


ASYNC = AsyncLoopThread()
ASYNC.start()

STATE_LOCK = threading.Lock()
STATE = {
    "client": None,
    "phone": None,
    "dialogs_cache": {},  # id (str) -> entity object, kept for reuse in download step
    "jobs": {},  # job_id -> {"queue": Queue, "cancel": bool}
}


def get_client():
    return STATE["client"]


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# --------------------------------------------------------------------------
# Auth flow
# --------------------------------------------------------------------------
@app.route("/api/send_code", methods=["POST"])
def api_send_code():
    data = request.json or {}
    api_id = data.get("api_id")
    api_hash = (data.get("api_hash") or "").strip()
    phone = (data.get("phone") or "").strip()

    if not api_id or not api_hash or not phone:
        return jsonify({"error": "API ID, API Hash, and phone number are all required."}), 400
    try:
        api_id = int(api_id)
    except ValueError:
        return jsonify({"error": "API ID must be a number."}), 400

    client = TelegramClient(SESSION_NAME, api_id, api_hash)

    async def _go():
        await client.connect()
        if await client.is_user_authorized():
            return "already_authorized"
        await client.send_code_request(phone)
        return "code_sent"

    try:
        result = ASYNC.run_coro(_go())
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    with STATE_LOCK:
        STATE["client"] = client
        STATE["phone"] = phone

    return jsonify({"status": result})


@app.route("/api/verify_code", methods=["POST"])
def api_verify_code():
    data = request.json or {}
    code = (data.get("code") or "").strip()
    client = get_client()
    phone = STATE["phone"]
    if not client:
        return jsonify({"error": "Session expired, please start again."}), 400
    if not code:
        return jsonify({"error": "Please enter the code."}), 400

    async def _go():
        await client.sign_in(phone, code)

    try:
        ASYNC.run_coro(_go())
    except errors.SessionPasswordNeededError:
        return jsonify({"status": "need_password"})
    except errors.PhoneCodeInvalidError:
        return jsonify({"error": "That code was incorrect. Please try again."}), 400
    except errors.PhoneCodeExpiredError:
        return jsonify({"error": "That code expired. Please request a new one."}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({"status": "ok"})


@app.route("/api/verify_password", methods=["POST"])
def api_verify_password():
    data = request.json or {}
    password = data.get("password") or ""
    client = get_client()
    if not client:
        return jsonify({"error": "Session expired, please start again."}), 400
    if not password:
        return jsonify({"error": "Please enter your password."}), 400

    async def _go():
        await client.sign_in(password=password)

    try:
        ASYNC.run_coro(_go())
    except errors.PasswordHashInvalidError:
        return jsonify({"error": "Incorrect password."}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({"status": "ok"})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    client = get_client()
    if client:
        try:
            ASYNC.run_coro(client.disconnect())
        except Exception:
            pass
    with STATE_LOCK:
        STATE["client"] = None
        STATE["phone"] = None
        STATE["dialogs_cache"] = {}
    return jsonify({"status": "ok"})


# --------------------------------------------------------------------------
# Channel listing
# --------------------------------------------------------------------------
def _kind_of(entity):
    if isinstance(entity, Channel):
        return "Group" if entity.megagroup else "Channel"
    if isinstance(entity, Chat):
        return "Group"
    return "Unknown"


@app.route("/api/channels", methods=["GET"])
def api_channels():
    """Fast pass: everything already present on the dialog/entity objects,
    no extra network round-trips, so this returns almost instantly even for
    accounts with hundreds of chats."""
    client = get_client()
    if not client:
        return jsonify({"error": "Not logged in."}), 401

    async def _go():
        results = []
        async for dialog in client.iter_dialogs():
            entity = dialog.entity
            if isinstance(entity, User):
                continue  # only channels/groups, not 1-on-1 DMs
            if not isinstance(entity, (Channel, Chat)):
                continue

            cid = str(dialog.id)
            STATE["dialogs_cache"][cid] = entity

            results.append({
                "id": cid,
                "title": dialog.name or getattr(entity, "title", "Untitled"),
                "kind": _kind_of(entity),
                "username": getattr(entity, "username", None),
                "unread_count": dialog.unread_count,
                "last_message_date": dialog.date.isoformat() if dialog.date else None,
                "verified": bool(getattr(entity, "verified", False)),
                "scam": bool(getattr(entity, "scam", False)),
                "fake": bool(getattr(entity, "fake", False)),
                "restricted": bool(getattr(entity, "restricted", False)),
                "creator": bool(getattr(entity, "creator", False)),
                "is_admin": bool(getattr(entity, "admin_rights", None)),
                "left": bool(getattr(entity, "left", False)),
                "has_photo": getattr(entity, "photo", None) is not None,
                "content_protected": bool(getattr(entity, "noforwards", False)),
                "pinned": bool(getattr(dialog, "pinned", False)),
                "archived": dialog.archived,
            })
        return results

    try:
        data = ASYNC.run_coro(_go())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"channels": data})


@app.route("/api/channel_photo/<channel_id>", methods=["GET"])
def api_channel_photo(channel_id):
    """Lazy per-channel avatar fetch so the list renders instantly and
    photos pop in progressively (called from the frontend after render)."""
    client = get_client()
    if not client:
        return jsonify({"error": "Not logged in."}), 401

    entity = STATE["dialogs_cache"].get(channel_id)
    if entity is None:
        return jsonify({"error": "Unknown channel."}), 404

    async def _go():
        buf = io.BytesIO()
        result = await client.download_profile_photo(entity, file=buf, download_big=False)
        if result is None:
            return None
        buf.seek(0)
        return base64.b64encode(buf.read()).decode("ascii")

    try:
        b64 = ASYNC.run_coro(_go(), timeout=15)
    except Exception:
        b64 = None

    if not b64:
        return jsonify({"photo": None})
    return jsonify({"photo": f"data:image/jpeg;base64,{b64}"})


@app.route("/api/channel_details/<channel_id>", methods=["GET"])
def api_channel_details(channel_id):
    """Lazy per-channel 'overlooked' extra details: member count, about text,
    slow mode, linked chat, etc. Costs one extra API call per channel so it's
    fetched on demand rather than for the whole list up front."""
    client = get_client()
    if not client:
        return jsonify({"error": "Not logged in."}), 401

    entity = STATE["dialogs_cache"].get(channel_id)
    if entity is None or not isinstance(entity, Channel):
        return jsonify({"participants_count": None, "about": None})

    async def _go():
        full = await client(GetFullChannelRequest(entity))
        fc = full.full_chat
        return {
            "participants_count": getattr(fc, "participants_count", None),
            "about": getattr(fc, "about", None) or None,
            "slowmode_seconds": getattr(fc, "slowmode_seconds", None),
            "linked_chat_id": getattr(fc, "linked_chat_id", None),
        }

    try:
        details = ASYNC.run_coro(_go(), timeout=20)
    except errors.FloodWaitError as fw:
        return jsonify({"error": f"flood_wait:{fw.seconds}"}), 429
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify(details)


# --------------------------------------------------------------------------
# Download job + progress (Server-Sent Events)
# --------------------------------------------------------------------------
@app.route("/api/download", methods=["POST"])
def api_download():
    client = get_client()
    if not client:
        return jsonify({"error": "Not logged in."}), 401

    data = request.json or {}
    channel_ids = data.get("channel_ids") or []
    folder = (data.get("folder") or "").strip() or os.path.join(os.getcwd(), "telegram_backup")

    if not channel_ids:
        return jsonify({"error": "No channels selected."}), 400

    entities = []
    for cid in channel_ids:
        entity = STATE["dialogs_cache"].get(cid)
        if entity is None:
            continue
        title = getattr(entity, "title", str(cid))
        entities.append((entity, title))

    if not entities:
        return jsonify({"error": "Selected channels are no longer available - refresh the list."}), 400

    job_id = uuid.uuid4().hex
    job_queue = queue.Queue()
    STATE["jobs"][job_id] = {"queue": job_queue, "cancel": False}

    os.makedirs(folder, exist_ok=True)

    def emit(event_type, **payload):
        job_queue.put({"type": event_type, "ts": time.time(), **payload})

    async def download_channel(entity, name, index, total_channels):
        safe_name = "".join(c for c in name if c.isalnum() or c in " _-").strip() or f"channel_{index}"
        chan_dir = os.path.join(folder, safe_name)
        media_dir = os.path.join(chan_dir, "media")
        os.makedirs(media_dir, exist_ok=True)
        text_log_path = os.path.join(chan_dir, "messages_and_links.txt")

        emit("channel_start", index=index, total_channels=total_channels, name=name)

        # cheap call to learn total message count for an accurate progress bar
        try:
            total_result = await client.get_messages(entity, limit=0)
            total_messages = total_result.total or 0
        except Exception:
            total_messages = 0

        emit("channel_total", index=index, name=name, total_messages=total_messages)

        count_media = 0
        count_text = 0
        scanned = 0

        with open(text_log_path, "w", encoding="utf-8") as text_file:
            async for message in client.iter_messages(entity, reverse=True):
                if STATE["jobs"][job_id]["cancel"]:
                    emit("cancelled", index=index, name=name)
                    return

                scanned += 1

                if message.text:
                    ts = message.date.strftime("%Y-%m-%d %H:%M:%S") if message.date else "unknown"
                    text_file.write(f"[{ts}] (id={message.id})\n{message.text}\n\n")
                    count_text += 1

                if message.media:
                    last_media_emit = 0
                    last_media_percent = -1

                    def media_progress(downloaded, total):
                        nonlocal last_media_emit, last_media_percent

                        now = time.time()
                        percent = int((downloaded / total) * 100) if total else 0
                        if percent == last_media_percent and now - last_media_emit < 0.75:
                            return
                        if percent < 100 and now - last_media_emit < 0.4:
                            return

                        last_media_emit = now
                        last_media_percent = percent
                        emit(
                            "media_progress",
                            index=index,
                            total_channels=total_channels,
                            name=name,
                            message_id=message.id,
                            scanned=scanned,
                            total_messages=total_messages,
                            media_downloaded=count_media,
                            text_saved=count_text,
                            downloaded_bytes=downloaded,
                            total_bytes=total,
                            percent=percent,
                        )

                    for attempt in range(3):
                        if STATE["jobs"][job_id]["cancel"]:
                            emit("cancelled", index=index, name=name)
                            return
                        try:
                            path = await client.download_media(
                                message,
                                file=media_dir + os.sep,
                                progress_callback=media_progress,
                            )
                            if path:
                                count_media += 1
                                emit(
                                    "channel_progress",
                                    index=index,
                                    total_channels=total_channels,
                                    name=name,
                                    scanned=scanned,
                                    total_messages=total_messages,
                                    media_downloaded=count_media,
                                    text_saved=count_text,
                                )
                            break
                        except errors.FloodWaitError as fw:
                            emit("flood_wait", index=index, name=name, seconds=fw.seconds)
                            # sleep in 1s increments so Stop takes effect immediately
                            # instead of waiting out the full flood-wait window
                            for _ in range(fw.seconds + 1):
                                if STATE["jobs"][job_id]["cancel"]:
                                    emit("cancelled", index=index, name=name)
                                    return
                                await asyncio.sleep(1)
                        except Exception as e:
                            emit("media_error", index=index, name=name, message_id=message.id, error=str(e))
                            break

                if scanned % 5 == 0 or scanned == total_messages:
                    emit(
                        "channel_progress",
                        index=index,
                        total_channels=total_channels,
                        name=name,
                        scanned=scanned,
                        total_messages=total_messages,
                        media_downloaded=count_media,
                        text_saved=count_text,
                    )

        emit(
            "channel_done",
            index=index,
            total_channels=total_channels,
            name=name,
            media_downloaded=count_media,
            text_saved=count_text,
            path=chan_dir,
        )

    async def run_job():
        try:
            emit("job_start", total_channels=len(entities))
            for i, (entity, name) in enumerate(entities, start=1):
                if STATE["jobs"][job_id]["cancel"]:
                    emit("job_cancelled")
                    return
                await download_channel(entity, name, i, len(entities))
                if STATE["jobs"][job_id]["cancel"]:
                    emit("job_cancelled")
                    return
            emit("job_done")
        except Exception as e:
            emit("job_error", error=str(e), trace=traceback.format_exc())
        finally:
            job_queue.put(None)  # sentinel: stream ends

    ASYNC.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(run_job(), loop=ASYNC.loop))

    return jsonify({"job_id": job_id})


@app.route("/api/progress/<job_id>")
def api_progress(job_id):
    job = STATE["jobs"].get(job_id)
    if not job:
        return jsonify({"error": "Unknown job."}), 404

    def gen():
        q = job["queue"]
        while True:
            try:
                item = q.get(timeout=30)
            except queue.Empty:
                yield "event: ping\ndata: {}\n\n"
                continue
            if item is None:
                yield f"event: end\ndata: {{}}\n\n"
                break
            yield f"data: {json.dumps(item)}\n\n"

    return Response(stream_with_context(gen()), mimetype="text/event-stream")


@app.route("/api/cancel/<job_id>", methods=["POST"])
def api_cancel(job_id):
    job = STATE["jobs"].get(job_id)
    if not job:
        return jsonify({"error": "Unknown job."}), 404
    job["cancel"] = True
    return jsonify({"status": "cancelling"})


@app.route("/api/choose_folder", methods=["POST"])
def api_choose_folder():
    """Best-effort native folder picker. Falls back gracefully if a display
    isn't available (e.g. headless server) - the frontend just keeps the
    manually typed path in that case."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory()
        root.destroy()
        if not folder:
            return jsonify({"folder": None})
        return jsonify({"folder": folder})
    except Exception as e:
        return jsonify({"error": str(e), "folder": None}), 200


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
