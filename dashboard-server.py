#!/usr/bin/env python3
"""
Dispatcher Worker Dashboard — 简化版
只看 Worker 状态：BARE / IDLE / BUSY
http://localhost:9900
"""

import json
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = 9900
LOG_DIR = Path.home() / ".lark-dispatcher" / "logs"
BJ_TZ = timezone(timedelta(hours=8))

# ── Cache for daemon start detection ──
_cached_daemon_start: str = ""
_cached_daemon_start_mtime: float = 0.0


def get_daemon_start_utc(log_file: Path) -> str:
    global _cached_daemon_start, _cached_daemon_start_mtime
    try:
        mtime = log_file.stat().st_mtime
    except FileNotFoundError:
        return ""
    if mtime == _cached_daemon_start_mtime and _cached_daemon_start:
        return _cached_daemon_start
    _cached_daemon_start_mtime = mtime
    last_start = ""
    try:
        with open(log_file) as f:
            for line in f:
                if "Starting daemon" in line:
                    m = re.match(r"\[(\d{2}:\d{2}:\d{2})\]", line)
                    if m:
                        last_start = m.group(1)
    except FileNotFoundError:
        pass
    _cached_daemon_start = last_start
    return last_start


CHAT_NAMES = {
    "oc_80241e9aec75ebc89e28a5da7432a830": "容易建联",
    "oc_2f36db7dcdf8a081c6323a55eba96e75": "私聊",
    "oc_168c9532835539d959a899be48f17cf3": "雪球群",
    "oc_ace31cc76f5491fa248fb6c2c3394c49": "测试群",
    "oc_67a0c1708b4f45f066d0003874437c0e": "其他群",
    "oc_3fbaefa219e4b874e688aaeccda3dde2": "自动群",
    "oc_b23ef491753a570b5655b5c67f3956a0": "SnowPear",
    "oc_3554138efbb4c4a6f1869d5befaedd0b": "测试群2",
}

SENDER_NAMES = {
    "ou_087b710b383611badfb30f42834dac07": "李玮",
    "ou_0ddd22454559dcddde087f9573a3b4ce": "肖夏青",
    "ou_1d274808417139cabd80eed89a38b5cb": "温昕昕",
    "ou_21396cb5ab3af465036c795b163ecf1f": "赵思琳",
    "ou_21deeda230041792274bdfa14ba41439": "刁玉倩",
    "ou_2366acf744c25f0e7ea5f417a981b667": "Oanh",
    "ou_23742a5a2d9f8e5efa19d433880a1dd5": "刘美晶",
    "ou_279debf3d9b4ed62676a8c6ad2e9360e": "张亚君",
    "ou_2b599b19be8e37080432dcc52aadafc9": "段英婕",
    "ou_3224bfc4376bc2a002d6cf00930814f5": "储楚",
    "ou_369b7b1ae32807f9d6885ed9f7e067e9": "胡玉玮",
    "ou_3da141bd9641b54616724862d14693af": "毛婷婷",
    "ou_48a04b5da102fab1aa9724d330a18cd5": "刘婉婷",
    "ou_50154574b16c48b9a8722e8977e29100": "李彩云",
    "ou_58c8f30f036d39d3a6eb9cf4880b9da1": "汪莹",
    "ou_5977d18b47e2d95a73eeeddb35b5f462": "董佳璐",
    "ou_5f4336226f4fea018026c83550a5b807": "孙心如",
    "ou_652c1ccd66837e01e33e70c54cf44413": "潘小雪",
    "ou_65c17030e5905d39d3a0edea349653ee": "李冰洁",
    "ou_65cdddc9f644e271657b2ab0f5969927": "韩春玲",
    "ou_822e0949b2dbedcf5231c839aa6e86fa": "Lành",
    "ou_86ad5d942ea89c2f6194a33c123347b8": "郑雅南",
    "ou_929c1a6b39fdbf0ee739f1c00e906c14": "Hương",
    "ou_94736dffdecbb4aac94c2cb0895d01fc": "李丹丹",
    "ou_a1aaf9d1910de26e4acc08679f38016b": "李凡",
    "ou_a4bbe46bf4f06ed3c9013fbc146cd829": "曹颖",
    "ou_b330501dcf3f9c404d19adae47164121": "李悦",
    "ou_b557c1f006a96902542a5c839249a39f": "Janice",
    "ou_c367ba481927134b84f1f201ab096201": "丁一平",
    "ou_cad53b6ba762a057d90621809787b0c6": "Sheila",
    "ou_d53ed0f1088b6cd30587eed1db619926": "陈雪莹",
    "ou_df6aac9164870bff60583d60a8ce0298": "余静雯",
    "ou_f00cfe5571e0be52b5d2969389fbe987": "张梦瑶",
    "ou_f748030313849357354ab42fa0816454": "沈廷捷",
    "ou_3aa61b5135cd19fb47f91c2ca0cbfad8": "刘芒",
    "ou_68a0dae992e7b8aa774098b179762508": "明亮",
    "ou_acc459a38217dc5432150afd4a67ae27": "叶老师",
}


def get_log_file() -> Path:
    today = datetime.now(BJ_TZ).strftime("%Y-%m-%d")
    return LOG_DIR / f"{today}.log"


def resolve_conv_display(conv_key: str, chat_type_by_id: dict | None = None) -> dict:
    """Parse convKey → {chat, thread}. For unknown chats, infer "私聊" from chat type."""
    chat_id = ""
    thread_id = ""
    m = re.search(r"lark:(oc_[a-f0-9]+)", conv_key)
    if m:
        chat_id = m.group(1)
    m2 = re.search(r"thread_(omt_[a-f0-9]+)", conv_key)
    if m2:
        thread_id = m2.group(1)
    if not chat_id:
        return {"chat": "—", "thread": thread_id or ""}
    if chat_id in CHAT_NAMES:
        chat_name = CHAT_NAMES[chat_id]
    else:
        ctype = (chat_type_by_id or {}).get(chat_id)
        if ctype == "private":
            chat_name = "私聊"
        else:
            # Unknown group — try Lark API (cached), fall back to truncated ID
            api_name = fetch_chat_name(chat_id)
            chat_name = api_name if api_name else chat_id[:16] + "…"
    return {"chat": chat_name, "thread": thread_id or ""}


# ── Thread title cache (message_id → title string) ──
_thread_title_cache: dict[str, str] = {}

# ── Chat name cache (chat_id → display name) ──
_chat_name_cache: dict[str, str] = {}

# ── User name cache (open_id → display name) ──
_user_name_cache: dict[str, str] = {}

# ── Dispatcher tenant token cache (for resolving app-scoped open_ids) ──
# lark-cli uses a different app than dispatcher, so open_ids returned by dispatcher
# events are scoped to dispatcher's app and can't be looked up through lark-cli.
# We call Lark API directly using dispatcher's credentials.
_dispatcher_token: dict = {"token": "", "expires_at": 0}


def _get_dispatcher_tenant_token() -> str:
    """Lazy-load and cache dispatcher's tenant_access_token. Empty string on failure."""
    now = time.time()
    if _dispatcher_token["token"] and _dispatcher_token["expires_at"] > now + 60:
        return _dispatcher_token["token"]
    try:
        cfg_path = Path.home() / ".lark-dispatcher" / "config.json"
        cfg = json.loads(cfg_path.read_text())
        lark = cfg.get("lark", {})
        app_id = lark.get("appId")
        app_secret = lark.get("appSecret")
        if not app_id or not app_secret:
            return ""
        req = urllib.request.Request(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            data=json.dumps({"app_id": app_id, "app_secret": app_secret}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            d = json.loads(r.read())
        tok = d.get("tenant_access_token") or ""
        expire = d.get("expire", 0)  # seconds from now
        _dispatcher_token["token"] = tok
        _dispatcher_token["expires_at"] = now + expire
        return tok
    except Exception:
        return ""


def fetch_user_name(open_id: str) -> str:
    """Resolve open_id → display name using dispatcher's app credentials. Cached."""
    if not open_id:
        return ""
    if open_id in _user_name_cache:
        return _user_name_cache[open_id]
    tok = _get_dispatcher_tenant_token()
    if not tok:
        _user_name_cache[open_id] = ""
        return ""
    try:
        req = urllib.request.Request(
            f"https://open.feishu.cn/open-apis/contact/v3/users/{open_id}?user_id_type=open_id",
            headers={"Authorization": f"Bearer {tok}"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            d = json.loads(r.read())
        user = d.get("data", {}).get("user", {})
        name = user.get("name") or user.get("en_name") or ""
        _user_name_cache[open_id] = name.strip()
        return _user_name_cache[open_id]
    except Exception:
        _user_name_cache[open_id] = ""
        return ""


def fetch_chat_name(chat_id: str) -> str:
    """Fetch group chat display name via lark-cli API. Cached. Empty string on failure."""
    if not chat_id:
        return ""
    if chat_id in _chat_name_cache:
        return _chat_name_cache[chat_id]
    try:
        out = subprocess.check_output(
            ["lark-cli", "api", "GET", f"/open-apis/im/v1/chats/{chat_id}"],
            text=True, stderr=subprocess.DEVNULL, timeout=5,
        )
        data = json.loads(out)
        d = data.get("data", {})
        name = d.get("name") or ""
        # i18n fallback
        if not name:
            i18n = d.get("i18n_names", {}) or {}
            name = i18n.get("zh_cn") or i18n.get("en_us") or i18n.get("ja_jp") or ""
        name = name.strip()
        _chat_name_cache[chat_id] = name
        return name
    except Exception:
        _chat_name_cache[chat_id] = ""
        return ""


def fetch_message_info(message_id: str) -> dict:
    """Fetch message content + sender via lark-cli API. Returns {title, sender_id}. Cached."""
    empty = {"title": "", "sender_id": ""}
    if not message_id:
        return empty
    if message_id in _thread_title_cache:
        return _thread_title_cache[message_id]
    try:
        out = subprocess.check_output(
            ["lark-cli", "api", "GET", f"/open-apis/im/v1/messages/{message_id}"],
            text=True, stderr=subprocess.DEVNULL, timeout=5,
        )
        data = json.loads(out)
        items = data.get("data", {}).get("items", [])
        if not items:
            _thread_title_cache[message_id] = empty
            return empty
        item = items[0]
        # Extract text
        body = item.get("body", {}).get("content", "")
        text = _extract_plain_text(body)
        title = text.replace("\n", " ").strip()
        if len(title) > 60:
            title = title[:58] + "…"
        # Extract sender
        sender_id = item.get("sender", {}).get("id", "")
        result = {"title": title, "sender_id": sender_id}
        _thread_title_cache[message_id] = result
        return result
    except Exception:
        _thread_title_cache[message_id] = empty
        return empty


def _extract_plain_text(content_json: str) -> str:
    """Extract plain text from Lark message content JSON."""
    try:
        content = json.loads(content_json)
    except (json.JSONDecodeError, TypeError):
        # Might be plain text already
        return content_json if isinstance(content_json, str) else ""

    # Simple text message: {"text": "hello"}
    if isinstance(content, dict) and "text" in content:
        text = content["text"]
        # Strip @mentions like @_user_1
        return re.sub(r"@_user_\d+", "", text).strip()

    # Rich text (post): {"title": "...", "content": [[{tag, text}, ...], ...]}
    if isinstance(content, dict) and "content" in content:
        parts = []
        title = content.get("title", "")
        if title:
            parts.append(title)
        for para in content.get("content", []):
            if isinstance(para, list):
                for elem in para:
                    if isinstance(elem, dict) and elem.get("tag") == "text":
                        parts.append(elem.get("text", ""))
        return " ".join(parts).strip()

    return ""


def ts_to_beijing(ts: str) -> str:
    if not ts:
        return ""
    h = (int(ts[:2]) + 8) % 24
    return f"{h:02d}:{ts[3:5]}:{ts[6:8]}"


def secs_since(ts_utc: str) -> int:
    """Seconds elapsed since a UTC HH:MM:SS timestamp."""
    if not ts_utc:
        return 0
    h, m, s = int(ts_utc[:2]), int(ts_utc[3:5]), int(ts_utc[6:8])
    ts_secs = h * 3600 + m * 60 + s
    now = datetime.now(timezone.utc)
    now_secs = now.hour * 3600 + now.minute * 60 + now.second
    diff = now_secs - ts_secs
    if diff < 0:
        diff += 86400
    return diff


def fmt_duration(secs: int) -> str:
    if secs < 0:
        return "—"
    m, s = divmod(secs, 60)
    if m >= 60:
        h, m = divmod(m, 60)
        return f"{h}h{m}m"
    return f"{m}m{s}s"


def capture_tmux_activity(idx: int) -> str:
    """Capture tmux pane content for any worker state, strip UI chrome, return last 20 lines."""
    try:
        raw = subprocess.check_output(
            ["tmux", "capture-pane", "-t", f"lark-worker-{idx}", "-p"],
            text=True, stderr=subprocess.DEVNULL, timeout=3,
        )
    except Exception:
        return ""
    lines = [l for l in raw.split("\n") if l.strip()]
    # Strip bottom UI elements
    while lines and re.search(
        r"^❯\s*$|^[─━]+$|bypass permissions|esc to interrupt|shift\+tab to cycle|Press up to edit",
        lines[-1],
    ):
        lines.pop()
    # Return last 20 lines
    return "\n".join(lines[-20:])


def get_tmux_sessions() -> set:
    try:
        out = subprocess.check_output(
            ["tmux", "list-sessions"], text=True, stderr=subprocess.DEVNULL
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return set()
    alive = set()
    for line in out.strip().split("\n"):
        m = re.search(r"lark-worker-(\d+)", line)
        if m:
            alive.add(int(m.group(1)))
    return alive


def parse_worker_states(log_file: Path) -> dict:
    """Parse log to determine current worker states.

    Returns: {
        worker_idx: {
            "state": "BARE" | "IDLE" | "BUSY",
            "conv_key": str,         # current/last bound convKey
            "busy_since": "HH:MM:SS",  # UTC timestamp when markBusy
            "idle_since": "HH:MM:SS",  # UTC timestamp when markIdle
            "sender_id": str,
        }
    }
    """
    workers = {}  # idx → state dict
    # Track the latest recv info (to associate with convKey on assignment)
    _last_recv_msg_id = ""
    _last_recv_sender_id = ""
    # convKey → first message_id (for thread title lookup)
    conv_first_msg = {}  # convKey → message_id
    # convKey → sender_id of the first message
    conv_first_sender = {}  # convKey → sender_id
    # chat_id → chat type ('private' | 'group') — read from lark-recv lines
    chat_type_by_id = {}

    daemon_start = get_daemon_start_utc(log_file)

    pat_ts = re.compile(r"\[(\d{2}:\d{2}:\d{2})\]")

    with open(log_file, "r") as f:
        for line in f:
            if daemon_start:
                m_ts = pat_ts.match(line)
                if m_ts and m_ts.group(1) < daemon_start:
                    continue

            ts_m = pat_ts.match(line)
            ts = ts_m.group(1) if ts_m else ""

            # Track recv message IDs and sender
            if "lark-recv" in line:
                msg_m = re.search(r"msg=(om_\S+)", line)
                sender_m = re.search(r"sender=(ou_[a-f0-9]+)", line)
                chat_m = re.search(r"chat=(oc_[a-f0-9]+)", line)
                type_m = re.search(r"type=(private|group)", line)
                if msg_m:
                    _last_recv_msg_id = msg_m.group(1)
                if sender_m:
                    _last_recv_sender_id = sender_m.group(1)
                if chat_m and type_m:
                    chat_type_by_id[chat_m.group(1)] = type_m.group(1)

            # Track first assignment sender
            if ("Assigned" in line or "Reusing" in line) and "worker[" in line:
                w_m = re.search(r"worker\[(\d+)\]", line)
                conv_m = re.search(r"(lark:\S+)", line)
                if w_m and conv_m:
                    idx = int(w_m.group(1))
                    ck = conv_m.group(1)
                    if idx not in workers:
                        workers[idx] = {"state": "BARE", "conv_key": "", "busy_since": "", "idle_since": "", "sender_id": ""}
                    workers[idx]["conv_key"] = ck
                    # Record first message_id and sender for this convKey
                    if ck not in conv_first_msg and _last_recv_msg_id:
                        conv_first_msg[ck] = _last_recv_msg_id
                    if ck not in conv_first_sender and _last_recv_sender_id:
                        conv_first_sender[ck] = _last_recv_sender_id

            # Worker ready (initial start)
            if "Worker[" in line and "ready on" in line:
                w_m = re.search(r"Worker\[(\d+)\]", line)
                if w_m:
                    idx = int(w_m.group(1))
                    workers[idx] = {"state": "BARE", "conv_key": "", "busy_since": "", "idle_since": "", "sender_id": ""}

            # markBusy
            if "markBusy" in line:
                w_m = re.search(r"worker\[(\d+)\]", line)
                conv_m = re.search(r"(lark:\S+)", line)
                if w_m:
                    idx = int(w_m.group(1))
                    if idx not in workers:
                        workers[idx] = {"state": "BARE", "conv_key": "", "busy_since": "", "idle_since": "", "sender_id": ""}
                    workers[idx]["state"] = "BUSY"
                    workers[idx]["busy_since"] = ts
                    workers[idx]["idle_since"] = ""
                    if conv_m:
                        workers[idx]["conv_key"] = conv_m.group(1)

            # markIdle
            if "markIdle" in line:
                w_m = re.search(r"worker\[(\d+)\]", line)
                if w_m:
                    idx = int(w_m.group(1))
                    if idx in workers:
                        workers[idx]["state"] = "IDLE"
                        workers[idx]["idle_since"] = ts
                        workers[idx]["busy_since"] = ""

            # /clear → BARE
            if "/clear" in line and "BARE" in line:
                w_m = re.search(r"worker\[(\d+)\]", line)
                if w_m:
                    idx = int(w_m.group(1))
                    if idx in workers:
                        workers[idx]["state"] = "BARE"
                        workers[idx]["conv_key"] = ""
                        workers[idx]["idle_since"] = ""
                        workers[idx]["busy_since"] = ""
                        workers[idx]["sender_id"] = ""

            # (Removed) BUSY timeout parsing — was too permissive.
            # Post-snapshot-diff, "BUSY timeout" appears in 4 log variants:
            #   1. "...checking tmux before forcing idle"     → still busy
            #   2. "...tmux still active, extending timeout"  → still busy (reset timer)
            #   3. "...tmux confirmed idle, marking idle"     → emits markIdle: next line
            #   4. "...tmux check failed, forcing idle..."    → emits markIdle: next line
            # The markIdle: branch above already handles real transitions.

            # Killing excess
            if "Killing excess" in line:
                w_m = re.search(r"worker\[(\d+)\]", line)
                if w_m:
                    idx = int(w_m.group(1))
                    if idx in workers:
                        workers[idx]["state"] = "KILLED"

    # Set sender_id from conv_first_sender
    for idx, w in workers.items():
        ck = w["conv_key"]
        if ck and not w["sender_id"] and ck in conv_first_sender:
            w["sender_id"] = conv_first_sender[ck]

    return workers, conv_first_msg, chat_type_by_id


def build_api_data() -> dict:
    log_file = get_log_file()
    if not log_file.exists():
        return {"error": "日志文件不存在", "workers": [], "stats": {}}

    worker_states, conv_first_msg, chat_type_by_id = parse_worker_states(log_file)
    alive_set = get_tmux_sessions()

    # Ensure alive tmux workers exist
    for idx in alive_set:
        if idx not in worker_states:
            worker_states[idx] = {"state": "BARE", "conv_key": "", "busy_since": "", "idle_since": "", "sender_id": ""}

    # Read config to get clearDelayMs
    config_path = Path.home() / ".lark-dispatcher" / "config.json"
    clear_delay_s = 60  # default 1 min
    try:
        with open(config_path) as f:
            cfg = json.load(f)
            clear_delay_s = cfg.get("pool", {}).get("clearDelayMs", 60000) // 1000
    except Exception:
        pass

    all_idx = sorted(worker_states.keys())
    result_workers = []
    stats = {"total": 0, "busy": 0, "idle": 0, "bare": 0}

    for idx in all_idx:
        w = worker_states[idx]
        is_alive = idx in alive_set

        if w.get("state") == "KILLED" and not is_alive:
            continue
        if not is_alive:
            continue

        state = w["state"]
        conv_display = resolve_conv_display(w["conv_key"], chat_type_by_id) if w["conv_key"] else {"chat": "—", "thread": ""}
        # Resolve sender: hardcoded map first, then Lark API fallback (cached)
        sender_id = w["sender_id"]
        sender_name = ""
        if sender_id:
            sender_name = SENDER_NAMES.get(sender_id) or fetch_user_name(sender_id)

        # Fetch thread title from Lark API (cached). API sender is from lark-cli's app scope
        # and usually differs from dispatcher's open_id, so we don't override sender_name here.
        thread_title = ""
        if w["conv_key"] and w["conv_key"] in conv_first_msg:
            msg_info = fetch_message_info(conv_first_msg[w["conv_key"]])
            thread_title = msg_info["title"]

        # Compute timing info
        busy_duration = ""
        clear_countdown = ""

        if state == "BUSY" and w["busy_since"]:
            busy_secs = secs_since(w["busy_since"])
            busy_duration = fmt_duration(busy_secs)
        elif state == "IDLE" and w["idle_since"]:
            idle_secs = secs_since(w["idle_since"])
            remaining = clear_delay_s - idle_secs
            if remaining <= 0:
                clear_countdown = "即将清理"
            else:
                clear_countdown = fmt_duration(remaining)

        stats["total"] += 1
        if state == "BUSY":
            stats["busy"] += 1
        elif state == "IDLE":
            stats["idle"] += 1
        else:
            stats["bare"] += 1

        # Capture tmux activity for any worker with a live tmux session (BARE/IDLE/BUSY all valid)
        tmux_text = capture_tmux_activity(idx) if is_alive else ""

        result_workers.append({
            "id": idx,
            "state": state,
            "chat": conv_display["chat"],
            "thread": thread_title or conv_display["thread"],
            "sender": sender_name,
            "busy_duration": busy_duration,
            "clear_countdown": clear_countdown,
            "tmux": tmux_text,
        })

    return {
        "time": datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "workers": result_workers,
        "stats": stats,
    }


# ═══════════════════════════════════════════════════════════
# HTML Template
# ═══════════════════════════════════════════════════════════

HTML_PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Worker Pool</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0f1117;
    --card-bg: #1a1d27;
    --border: #2a2d3a;
    --text: #e1e4ed;
    --text-dim: #6b7280;
    --accent: #6366f1;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
    --blue: #3b82f6;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    padding: 24px; min-height: 100vh;
  }

  .header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 24px; padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .header h1 { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .header .time { color: var(--text-dim); font-size: 13px; }
  .refresh-dot {
    width: 8px; height: 8px; background: var(--green);
    border-radius: 50%; display: inline-block; animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  /* Stats bar */
  .stats {
    display: flex; gap: 16px; margin-bottom: 20px;
  }
  .stat {
    display: flex; align-items: center; gap: 6px;
    font-size: 14px; color: var(--text-dim);
  }
  .stat .num { font-size: 22px; font-weight: 700; font-family: 'SF Mono', monospace; }
  .stat.busy .num { color: var(--red); }
  .stat.idle .num { color: var(--yellow); }
  .stat.bare .num { color: var(--green); }
  .stat.total .num { color: var(--accent); }

  /* Table */
  .table-wrap {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 12px; overflow: hidden;
  }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th {
    text-align: left; padding: 12px 16px; font-size: 11px;
    color: var(--text-dim); font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; border-bottom: 1px solid var(--border);
    background: rgba(255,255,255,0.02);
  }
  td {
    padding: 10px 16px; border-bottom: 1px solid rgba(42,45,58,0.5);
    vertical-align: middle;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(99,102,241,0.04); }

  .worker-id {
    font-weight: 700; font-family: 'SF Mono', monospace;
    color: var(--accent); font-size: 13px;
  }

  /* State badges */
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px; border-radius: 20px;
    font-size: 12px; font-weight: 600; white-space: nowrap;
  }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .badge.BUSY { background: rgba(239,68,68,0.12); color: #fca5a5; }
  .badge.BUSY .dot { background: var(--red); }
  .badge.IDLE { background: rgba(234,179,8,0.12); color: #fde047; }
  .badge.IDLE .dot { background: var(--yellow); }
  .badge.BARE { background: rgba(34,197,94,0.12); color: #86efac; }
  .badge.BARE .dot { background: var(--green); }

  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
  .dim { color: var(--text-dim); }
  .sender { color: #a5b4fc; font-weight: 500; }
  .thread { color: var(--text); font-size: 13px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .countdown { color: var(--yellow); font-size: 12px; }
  .countdown.soon { color: var(--red); }
  .busy-dur { color: var(--text-dim); }
  .busy-dur.long { color: var(--yellow); }
  .busy-dur.very-long { color: var(--red); }

  /* Expandable tmux panel */
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: rgba(239,68,68,0.06); }
  .expand-arrow { font-size: 10px; color: var(--text-dim); margin-left: 4px; transition: transform 0.2s; display: inline-block; }
  .expand-arrow.open { transform: rotate(90deg); }
  .tmux-row td { padding: 0 16px 12px; background: rgba(0,0,0,0.3); }
  .tmux-panel {
    background: #0d0d0d; border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 16px; margin-top: 4px;
    font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
    font-size: 12px; line-height: 1.5; color: #c9d1d9;
    white-space: pre-wrap; word-break: break-all;
    max-height: 400px; overflow-y: auto;
  }
  .tmux-label {
    font-size: 11px; color: var(--text-dim); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
</style>
</head>
<body>

<div class="header">
  <h1>Worker Pool <span class="refresh-dot"></span></h1>
  <div class="time" id="clock"></div>
</div>

<div class="stats" id="stats"></div>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th style="width:60px">Worker</th>
        <th style="width:80px">状态</th>
        <th style="width:90px">绑定群</th>
        <th style="width:70px">请求人</th>
        <th>话题内容</th>
        <th style="width:90px">忙碌时长</th>
        <th style="width:90px">清理倒计时</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<script>
const STATE_LABELS = { BUSY: '忙碌', IDLE: '空闲', BARE: '待命' };

function getDurClass(dur) {
  if (!dur) return '';
  const h = dur.match(/(\d+)h/);
  if (h && parseInt(h[1]) >= 1) return 'very-long';
  const m = dur.match(/(\d+)m/);
  if (m && parseInt(m[1]) >= 5) return 'long';
  return '';
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Track expanded workers across refreshes
const expandedWorkers = new Set();

function toggleTmux(wid) {
  if (expandedWorkers.has(wid)) expandedWorkers.delete(wid);
  else expandedWorkers.add(wid);
  // Re-render will pick up the change on next refresh; also toggle immediately
  const arrow = document.querySelector(`#arrow-${wid}`);
  const panel = document.querySelector(`#tmux-${wid}`);
  if (arrow) arrow.classList.toggle('open');
  if (panel) panel.closest('tr').style.display = panel.closest('tr').style.display === 'none' ? '' : 'none';
}

function render(data) {
  document.getElementById('clock').textContent = data.time;

  const s = data.stats;
  document.getElementById('stats').innerHTML = `
    <div class="stat total"><span class="num">${s.total}</span> 总计</div>
    <div class="stat busy"><span class="num">${s.busy}</span> 忙碌</div>
    <div class="stat idle"><span class="num">${s.idle}</span> 空闲</div>
    <div class="stat bare"><span class="num">${s.bare}</span> 待命</div>
  `;

  document.getElementById('tbody').innerHTML = data.workers.map(w => {
    const label = STATE_LABELS[w.state] || w.state;
    const durCls = getDurClass(w.busy_duration);
    const cdCls = w.clear_countdown === '即将清理' ? 'soon' : '';
    const hasTmux = !!w.tmux;
    const isOpen = expandedWorkers.has(w.id);
    const clickAttr = hasTmux ? `class="clickable" onclick="toggleTmux(${w.id})"` : '';
    const arrowHtml = hasTmux ? `<span id="arrow-${w.id}" class="expand-arrow ${isOpen ? 'open' : ''}">▶</span>` : '';

    let html = `<tr ${clickAttr}>
      <td><span class="worker-id">w${w.id}</span>${arrowHtml}</td>
      <td><span class="badge ${w.state}"><span class="dot"></span>${label}</span></td>
      <td>${w.chat === '—' ? '<span class="dim">—</span>' : esc(w.chat)}</td>
      <td>${w.sender ? `<span class="sender">${esc(w.sender)}</span>` : '<span class="dim">—</span>'}</td>
      <td>${w.thread ? `<span class="thread" title="${esc(w.thread)}">${esc(w.thread)}</span>` : '<span class="dim">—</span>'}</td>
      <td>${w.state === 'BUSY' ? `<span class="mono busy-dur ${durCls}">${w.busy_duration || '—'}</span>` : '<span class="dim">—</span>'}</td>
      <td>${w.state === 'IDLE' ? `<span class="countdown ${cdCls}">${w.clear_countdown || '—'}</span>` : '<span class="dim">—</span>'}</td>
    </tr>`;

    if (hasTmux) {
      const display = isOpen ? '' : 'display:none';
      html += `<tr class="tmux-row" style="${display}">
        <td colspan="7">
          <div class="tmux-label">Claude CLI 实时输出</div>
          <div class="tmux-panel" id="tmux-${w.id}">${esc(w.tmux)}</div>
        </td>
      </tr>`;
    }

    return html;
  }).join('');
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    render(data);
  } catch (e) {
    console.error('Fetch error:', e);
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/status":
            data = build_api_data()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode())
        elif self.path == "/" or self.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    server = HTTPServer(("0.0.0.0", port), Handler)
    print(f"🚀 Dashboard running at http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutdown.")
        server.server_close()
