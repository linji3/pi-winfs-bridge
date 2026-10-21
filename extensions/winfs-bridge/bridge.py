#!/usr/bin/env python3
"""
pi-winfs-bridge - Windows-side file service for pi running inside WSL2.

Why this exists
---------------
WSL2 exposes Windows drives through drvfs/9p. Every stat/open/readdir crosses
the 9p boundary, so metadata-heavy work is brutally slow compared to native
NTFS (measured on this machine: walking 4927 files took 6.4 s over 9p and
0.12 s on Windows - a 55x difference).

This process runs *on Windows* and performs the file operations directly
against NTFS. pi (inside WSL) talks to it over a plain TCP socket that
crosses the WSL virtual NIC, so the 9p penalty is paid once per operation
batch instead of once per metadata call.

Protocol
--------
Newline-delimited JSON, one request per line:

    -> {"id": 1, "token": "...", "op": "stat", "args": {"path": "C:\\Users\\x"}}
    <- {"id": 1, "ok": true, "result": {...}}
    <- {"id": 1, "ok": false, "error": "message"}

Only the stdlib is used, so any Python 3.8+ on Windows works.
"""

from __future__ import annotations

import argparse
import base64
import fnmatch
import json
import os
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time

VERSION = "1.0.0"
PROTOCOL = 1
_SCRIPT_HASH = None

# Guards against a model (or a runaway glob) pulling gigabytes through the socket.
MAX_TRANSFER_BYTES = 96 * 1024 * 1024
MAX_WALK_ENTRIES = 200000

TOKEN = ""
ALLOWED_ROOTS = []
RG_PATH = None
LOG = False
IDLE_TIMEOUT = 3600.0
LAST_ACTIVITY = time.time()


def log(msg: str) -> None:
    if LOG:
        sys.stderr.write("[winfs-bridge] %s\n" % msg)
        sys.stderr.flush()


# --------------------------------------------------------------------------
# path helpers
# --------------------------------------------------------------------------

def win_path(raw: str) -> str:
    """Normalise a Windows path. Rejects relative paths."""
    if raw is None:
        raise ValueError("path is required")
    p = str(raw).strip().strip('"')
    if not p:
        raise ValueError("path is required")
    p = p.replace("/", os.sep)
    if not (len(p) > 1 and p[1] == ":"):
        raise ValueError("not an absolute Windows path: %s" % raw)
    return os.path.normpath(p)


def is_allowed(p: str) -> bool:
    if not ALLOWED_ROOTS:
        return True
    target = os.path.abspath(p)
    for root in ALLOWED_ROOTS:
        root_abs = os.path.abspath(root)
        try:
            if os.path.commonpath([target, root_abs]) == root_abs:
                return True
        except ValueError:
            continue
    return False


def check_path(raw: str) -> str:
    p = win_path(raw)
    if not is_allowed(p):
        raise PermissionError("path outside allowed roots: %s" % raw)
    return p


def find_rg() -> str | None:
    """Locate ripgrep for Windows (fast, gitignore aware)."""
    global RG_PATH
    if RG_PATH:
        return RG_PATH
    found = shutil.which("rg") or shutil.which("rg.exe")
    if not found:
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            import glob as _glob
            hits = _glob.glob(
                os.path.join(local, "Microsoft", "WinGet", "Packages", "*", "ripgrep*", "rg.exe")
            )
            if hits:
                found = hits[0]
    RG_PATH = found
    return found


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------

def script_hash() -> str:
    """Hash of the running script.

    The client compares it with the hash of its own bridge.py so that a helper
    built from an older version is never reused.
    """
    global _SCRIPT_HASH
    if _SCRIPT_HASH is None:
        try:
            import hashlib

            with open(os.path.abspath(__file__), "rb") as fh:
                _SCRIPT_HASH = hashlib.sha256(fh.read()).hexdigest()
        except OSError:
            _SCRIPT_HASH = ""
    return _SCRIPT_HASH


def op_ping(args):
    return {
        "version": VERSION,
        "protocol": PROTOCOL,
        "pid": os.getpid(),
        "rg": bool(find_rg()),
        "rgPath": find_rg(),
        "roots": ALLOWED_ROOTS,
        "script": script_hash(),
    }


def op_stat(args):
    p = check_path(args["path"])
    try:
        st = os.stat(p)
    except FileNotFoundError:
        return {"exists": False}
    except OSError as exc:
        return {"exists": False, "error": str(exc)}
    return {
        "exists": True,
        "isDir": os.path.isdir(p),
        "isFile": os.path.isfile(p),
        "size": st.st_size,
        "mtimeMs": st.st_mtime * 1000.0,
    }


def op_read(args):
    p = check_path(args["path"])
    limit = int(args.get("limit") or 0)
    with open(p, "rb") as fh:
        if limit > 0:
            data = fh.read(limit)
        else:
            # Read to EOF. Do not pass a huge size to read(): it would make
            # Python pre-allocate a 96 MB buffer for every single file.
            data = fh.read()
    truncated = False
    if len(data) >= MAX_TRANSFER_BYTES:
        data = data[:MAX_TRANSFER_BYTES]
        truncated = True

    # Optional line window: the caller only needs a slice of the file, and
    # sending a few lines instead of the whole file keeps the transfer small.
    offset = int(args.get("offset") or 0)
    limit = int(args.get("limit") or 0)
    if offset > 0 or limit > 0:
        text = data.decode("utf-8", errors="replace")
        all_lines = text.split("\n")
        total_lines = len(all_lines)
        start = max(0, offset - 1) if offset > 0 else 0
        end = min(total_lines, start + limit) if limit > 0 else total_lines
        selected = "\n".join(all_lines[start:end])
        return {
            "encoding": "utf8",
            "data": selected,
            "bytes": len(data),
            "truncated": truncated,
            "totalLines": total_lines,
            "startLine": start,
            "endLine": end,
        }
    try:
        text = data.decode("utf-8")
        return {"encoding": "utf8", "data": text, "bytes": len(data), "truncated": truncated}
    except UnicodeDecodeError:
        return {
            "encoding": "base64",
            "data": base64.b64encode(data).decode("ascii"),
            "bytes": len(data),
            "truncated": truncated,
        }


def _sniff_mime_type(buffer: bytes):
    """Detect a supported inline image type from the file header."""
    if buffer.startswith(b"\xff\xd8\xff"):
        return None if len(buffer) > 3 and buffer[3] == 0xF7 else "image/jpeg"
    if buffer.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(buffer) >= 16 and buffer[12:16] == b"IHDR":
            animated = b"acTL" in buffer[:1024]
            return None if animated else "image/png"
        return None
    if buffer[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if buffer[:4] == b"RIFF" and buffer[8:12] == b"WEBP":
        return "image/webp"
    if buffer[:2] == b"BM":
        return "image/bmp"
    return None


def op_sniff(args):
    """Report the inline image mime type of a file (None for non-images)."""
    p = check_path(args["path"])
    try:
        with open(p, "rb") as fh:
            head = fh.read(4100)
    except OSError:
        return {"mimeType": None}
    return {"mimeType": _sniff_mime_type(head)}


def op_bench(args):
    """Diagnostics: time the stages of a large read (read/encode/serialize)."""
    p = check_path(args["path"])
    t0 = time.time()
    with open(p, "rb") as fh:
        data = fh.read()
    t1 = time.time()
    encoding = "utf8"
    try:
        payload_text = data.decode("utf-8")
    except UnicodeDecodeError:
        payload_text = base64.b64encode(data).decode("ascii")
        encoding = "base64"
    t2 = time.time()
    payload = json.dumps(
        {"id": 1, "ok": True, "result": {"encoding": encoding, "data": payload_text, "bytes": len(data)}},
        ensure_ascii=False,
    )
    t3 = time.time()
    return {
        "bytes": len(data),
        "readMs": round((t1 - t0) * 1000, 2),
        "encodeMs": round((t2 - t1) * 1000, 2),
        "dumpMs": round((t3 - t2) * 1000, 2),
        "payloadBytes": len(payload),
    }


def op_write(args):
    p = check_path(args["path"])
    encoding = args.get("encoding", "utf8")
    data = args.get("data", "")
    parent = os.path.dirname(p)
    if parent:
        os.makedirs(parent, exist_ok=True)
    raw = data.encode("utf-8") if encoding == "utf8" else base64.b64decode(data)
    with open(p, "wb") as fh:
        fh.write(raw)
    return {"bytes": len(raw), "path": p}


def op_mkdir(args):
    p = check_path(args["path"])
    os.makedirs(p, exist_ok=True)
    return {"path": p}


def op_list(args):
    """One round trip listing: names plus a directory flag (avoids N stat calls)."""
    p = check_path(args["path"])
    out = []
    with os.scandir(p) as it:
        for entry in it:
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            out.append({"name": entry.name, "isDir": is_dir})
    return {"entries": out}


def op_rm(args):
    p = check_path(args["path"])
    recursive = bool(args.get("recursive"))
    if os.path.isdir(p) and not os.path.islink(p):
        if not recursive:
            os.rmdir(p)
        else:
            shutil.rmtree(p)
    else:
        os.remove(p)
    return {"removed": p}


def op_rename(args):
    src = check_path(args["path"])
    dst = check_path(args["to"])
    parent = os.path.dirname(dst)
    if parent:
        os.makedirs(parent, exist_ok=True)
    os.replace(src, dst)
    return {"from": src, "to": dst}


def op_realpath(args):
    p = check_path(args["path"])
    return {"path": os.path.realpath(p)}


def _walk(root, max_entries, max_depth, skip_dirs, include_files):
    """Directory walk using os.scandir (native speed on NTFS)."""
    entries = []
    stack = [(root, 0, "")]
    total = 0
    while stack:
        current, depth, prefix = stack.pop()
        if max_depth and depth > max_depth:
            continue
        try:
            with os.scandir(current) as it:
                items = sorted(it, key=lambda e: e.name.lower())
        except OSError:
            continue
        for entry in items:
            if total >= max_entries:
                return entries, True
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            rel = prefix + entry.name
            if is_dir:
                if entry.name in skip_dirs:
                    continue
                entries.append({"path": rel, "isDir": True, "depth": depth})
                stack.append((entry.path, depth + 1, rel + "/"))
            elif include_files:
                try:
                    size = entry.stat(follow_symlinks=False).st_size
                except OSError:
                    size = 0
                entries.append({"path": rel, "isDir": False, "depth": depth, "size": size})
                total += 1
    return entries, total >= max_entries


def op_tree(args):
    root = check_path(args["path"])
    max_entries = int(args.get("maxEntries") or 20000)
    max_depth = int(args.get("maxDepth") or 0)
    include_files = bool(args.get("includeFiles", True))
    skip = set(args.get("skipDirs") or [".git", "node_modules", ".venv", "__pycache__", ".mypy_cache", "dist", "build"])
    entries, truncated = _walk(root, max_entries, max_depth, skip, include_files)
    return {"root": root, "entries": entries, "truncated": truncated}


def op_find(args):
    """Glob search for file names (rg --files when available, else python walk)."""
    root = check_path(args["path"])
    pattern = args["pattern"]
    limit = int(args.get("limit") or 1000)
    rg = find_rg()
    if rg:
        # rg matches --glob patterns against the path relative to its working
        # directory, so run it inside the search root and re-attach the root.
        cwd, target = _rg_cwd(root)
        cmd = [rg, "--files", "--null", "--hidden", "--glob", pattern, "--", target]
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=cwd,
            )
        except OSError as exc:
            return {"output": "", "count": 0, "error": str(exc)}
        chunks = []
        count = 0
        try:
            assert proc.stdout is not None
            for chunk in iter(lambda: proc.stdout.read(65536), b""):
                chunks.append(chunk)
                count += chunk.count(b"\x00")
                if count >= limit:
                    proc.terminate()
                    break
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass
            proc.wait(timeout=10)
        output = b"".join(chunks)
        if count > limit:
            output = b"\x00".join(output.split(b"\x00")[:limit])
        return {"output": output.decode("utf-8", errors="replace"), "count": min(count, limit), "engine": "rg"}

    # Fallback: walk and match the pattern against the relative path.
    entries, _ = _walk(root, limit * 4, 0, {".git", "node_modules"}, True)
    rx = _glob_to_regex(pattern)
    files = []
    for entry in entries:
        rel = entry["path"]
        if rx.match(rel) or fnmatch.fnmatch(os.path.basename(rel), pattern):
            files.append(os.path.join(root, rel.replace("/", os.sep)))
            if len(files) >= limit:
                break
    return {"output": "\x00".join(files), "count": len(files), "engine": "python"}


def _glob_to_regex(pattern: str) -> re.Pattern:
    """Translate a glob into a regex over posix relative paths."""
    pat = pattern.replace("\\", "/")
    out = []
    i = 0
    while i < len(pat):
        ch = pat[i]
        if pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif ch == "*":
            out.append("[^/]*")
            i += 1
        elif ch == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(ch))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def _rg_cwd(root: str):
    """Working directory and target for ripgrep.

    ripgrep matches --glob patterns against the path relative to its working
    directory, so it has to run inside the search root for patterns such as
    "*.ts" or "src/**/*.spec.ts" to behave like fd does.
    """
    if os.path.isdir(root):
        return root, "."
    return os.path.dirname(root) or root, os.path.basename(root)


def op_grep(args):
    """Content search.

    ripgrep runs on the Windows side and its raw output is forwarded verbatim
    to the client, which parses it. The output format is
    `path\\0:line:text` for matches and `path\\0-line-text` for context lines
    (`--null` makes the path unambiguous even with drive letters).
    """
    root = check_path(args["path"])
    pattern = args["pattern"]
    glob = args.get("glob")
    ignore_case = bool(args.get("ignoreCase"))
    literal = bool(args.get("literal"))
    context = int(args.get("context") or 0)
    limit = int(args.get("limit") or 100)
    rg = find_rg()

    if rg:
        cwd, target = _rg_cwd(root)
        cmd = [rg, "--null", "-H", "--line-number", "--no-heading", "--color=never", "--hidden"]
        if ignore_case:
            cmd.append("--ignore-case")
        if literal:
            cmd.append("--fixed-strings")
        if glob:
            cmd += ["--glob", glob]
        if context:
            cmd += ["--context", str(context)]
        cmd += ["--", pattern, target]
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=cwd,
            )
        except OSError as exc:
            return {"output": "", "count": 0, "error": str(exc)}
        chunks = []
        matches = 0
        try:
            assert proc.stdout is not None
            # Read raw bytes: decoding every line in Python is much slower than
            # forwarding the bytes and letting the client parse them.
            while True:
                chunk = proc.stdout.read(262144)
                if not chunk:
                    break
                chunks.append(chunk)
                # Output lines look like `path\0<line><sep><text>` where the
                # separator is ":" for a match and "-" for a context line.
                matches += len(re.findall(rb"\x00\d+:", chunk))
                if matches >= limit:
                    proc.terminate()
                    break
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass
            proc.wait(timeout=10)
        raw = b"".join(chunks)
        return {"output": raw.decode("utf-8", errors="replace"), "count": matches, "engine": "rg"}

    matches = _python_grep(root, pattern, ignore_case, literal, glob, limit)
    if context > 0:
        _attach_context(matches, context)
    lines = []
    for match in matches:
        lines.append("%s\x00:%d:%s" % (match["file"], match["line"], match["text"]))
    return {"output": "\n".join(lines), "count": len(matches), "engine": "python"}


def _python_grep(root, pattern, ignore_case, literal, glob, limit):
    flags = re.IGNORECASE if ignore_case else 0
    try:
        rx = re.compile(re.escape(pattern) if literal else pattern, flags)
    except re.error as exc:
        raise ValueError("invalid pattern: %s" % exc)
    matches = []
    entries, _ = _walk(root, 50000, 0, {".git", "node_modules"}, True)
    for entry in entries:
        if glob and not fnmatch.fnmatch(os.path.basename(entry["path"]), glob):
            continue
        full = os.path.join(root, entry["path"].replace("/", os.sep))
        try:
            with open(full, "rb") as fh:
                raw = fh.read(4 * 1024 * 1024)
        except OSError:
            continue
        if b"\x00" in raw[:4096]:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for idx, line in enumerate(text.splitlines(), start=1):
            if rx.search(line):
                matches.append({"file": full, "line": idx, "text": line})
                if len(matches) >= limit:
                    return matches
    return matches


def _attach_context(matches, context):
    """Add surrounding lines for each match (one file read per file)."""
    by_file = {}
    for m in matches:
        by_file.setdefault(m["file"], []).append(m)
    for file_path, group in by_file.items():
        try:
            with open(file_path, "rb") as fh:
                raw = fh.read(8 * 1024 * 1024)
            text = raw.decode("utf-8", errors="replace")
            lines = text.split("\n")
        except OSError:
            for m in group:
                m["before"] = []
                m["after"] = []
            continue
        total = len(lines)
        for m in group:
            idx = m["line"]
            start = max(1, idx - context)
            end = min(total, idx + context)
            m["before"] = lines[start - 1: idx - 1]
            m["after"] = lines[idx: end]


OPS = {
    "ping": op_ping,
    "stat": op_stat,
    "read": op_read,
    "sniff": op_sniff,
    "bench": op_bench,
    "write": op_write,
    "mkdir": op_mkdir,
    "list": op_list,
    "rm": op_rm,
    "rename": op_rename,
    "realpath": op_realpath,
    "tree": op_tree,
    "find": op_find,
    "grep": op_grep,
}


def dispatch(msg):
    op = msg.get("op")
    args = msg.get("args") or {}
    handler = OPS.get(op)
    if not handler:
        raise ValueError("unknown op: %s" % op)
    return handler(args)


# --------------------------------------------------------------------------
# server
# --------------------------------------------------------------------------

class BridgeHandler(socketserver.StreamRequestHandler):
    timeout = 300

    def handle(self):
        global LAST_ACTIVITY
        authed = False
        try:
            for raw in self.rfile:
                raw = raw.strip()
                if not raw:
                    continue
                LAST_ACTIVITY = time.time()
                try:
                    msg = json.loads(raw.decode("utf-8"))
                except ValueError:
                    self._send({"id": None, "ok": False, "error": "invalid JSON"})
                    continue
                if not authed:
                    if msg.get("token") != TOKEN:
                        self._send({"id": msg.get("id"), "ok": False, "error": "unauthorized"})
                        return
                    authed = True
                try:
                    result = dispatch(msg)
                    self._send({"id": msg.get("id"), "ok": True, "result": result})
                except Exception as exc:  # noqa: BLE001 - report every failure to the client
                    log("op %s failed: %s" % (msg.get("op"), exc))
                    self._send({"id": msg.get("id"), "ok": False, "error": str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send(self, payload):
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.wfile.write(data)
        self.wfile.flush()


class BridgeServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    global TOKEN, ALLOWED_ROOTS, LOG, IDLE_TIMEOUT

    ap = argparse.ArgumentParser(description="pi winfs bridge (Windows side)")
    ap.add_argument("--host", default="127.0.0.1", help="address to bind")
    ap.add_argument("--port", type=int, default=7411, help="preferred port")
    ap.add_argument("--port-range", type=int, default=20, help="how many ports to try")
    ap.add_argument("--token", required=True, help="shared secret")
    ap.add_argument("--allow-root", action="append", default=[], help="allowed root (repeatable)")
    ap.add_argument("--endpoint-file", default="", help="where to write {port, token, pid}")
    ap.add_argument("--idle-timeout", type=float, default=3600, help="exit after N idle seconds")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    TOKEN = args.token
    ALLOWED_ROOTS = [win_path(r) for r in args.allow_root]
    LOG = args.verbose
    IDLE_TIMEOUT = max(0.0, args.idle_timeout)

    server = None
    bound_port = None
    for offset in range(max(1, args.port_range)):
        candidate = args.port + offset
        try:
            server = BridgeServer((args.host, candidate), BridgeHandler)
            bound_port = candidate
            break
        except OSError as exc:
            log("port %s unavailable: %s" % (candidate, exc))
    if server is None:
        sys.stderr.write("winfs-bridge: no free port in %s..%s\n" % (args.port, args.port + args.port_range))
        return 1

    if args.endpoint_file:
        payload = {
            "port": bound_port,
            "token": TOKEN,
            "pid": os.getpid(),
            "version": VERSION,
            "host": args.host,
            "roots": ALLOWED_ROOTS,
        }
        tmp = args.endpoint_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.replace(tmp, args.endpoint_file)

    log("listening on %s:%s (roots=%s)" % (args.host, bound_port, ALLOWED_ROOTS))
    # Announce the endpoint on stdout so the WSL side can connect without
    # waiting for the endpoint file to become visible through drvfs.
    try:
        sys.stdout.write("listening on %s:%s\n" % (args.host, bound_port))
        sys.stdout.flush()
    except Exception:
        pass

    server.timeout = 1.0
    while True:
        server.handle_request()
        if IDLE_TIMEOUT and (time.time() - LAST_ACTIVITY) > IDLE_TIMEOUT:
            log("idle timeout, exiting")
            break
    server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
