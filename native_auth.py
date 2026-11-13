"""Private Mac controller channel. Vault credentials never enter the HTTP API."""
import ctypes
import json
import os
from pathlib import Path
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import threading

from vault import VaultError

MAX_MESSAGE = 8192


def verify_controller(connection):
    """Check kernel peer credentials and the installed, signed controller path."""
    if sys.platform != "darwin":
        return False
    uid, gid = ctypes.c_uint(), ctypes.c_uint()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0 or uid.value != os.getuid():
        return False
    # Darwin sys/un.h: SOL_LOCAL=0, LOCAL_PEERPID=2.
    pid = struct.unpack("i", connection.getsockopt(0, 2, 4))[0]
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    path = ctypes.create_string_buffer(4096)
    if libproc.proc_pidpath(pid, path, len(path)) <= 0:
        return False
    app = Path.home() / "Applications/Local LLM Encoder.app"
    expected = app / "Contents/MacOS/AzimuthScribe"
    if Path(os.fsdecode(path.value)).resolve() != expected.resolve():
        return False
    verified = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "-R",
        '=identifier "net.realmi.azimuth-scribe.local"', str(app)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    return verified.returncode == 0


class NativeAuthServer:
    def __init__(self, folder, callback):
        self.path = Path(folder) / ".native-auth.sock"
        self.callback = callback
        self.verify_peer = verify_controller
        self.server = self.thread = None

    def start(self):
        if self.path.exists() or self.path.is_symlink():
            existing = self.path.lstat()
            if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
                raise RuntimeError("Mac 인증 소켓 경로를 확인하세요. 기존 파일을 보존했습니다.")
            with socket.socket(socket.AF_UNIX) as probe:
                probe.settimeout(.2)
                try:
                    probe.connect(str(self.path))
                except (ConnectionRefusedError, FileNotFoundError):
                    self.path.unlink(missing_ok=True)
                else:
                    raise RuntimeError("이 보관함의 Mac 인증 서버가 이미 실행 중입니다.")
        owner = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(10)
                try:
                    if not owner.verify_peer(self.connection):
                        raise VaultError("설치된 Mac 앱의 시스템 인증으로만 열 수 있습니다.")
                    raw = self.rfile.readline(MAX_MESSAGE + 1)
                    if len(raw) > MAX_MESSAGE or not raw.endswith(b"\n"):
                        raise VaultError("Mac 인증 요청 형식이 올바르지 않습니다.")
                    payload = json.loads(raw)
                    if not isinstance(payload, dict):
                        raise VaultError("Mac 인증 요청 형식이 올바르지 않습니다.")
                    result = owner.callback(payload)
                    reply = {"ok": True, **result}
                except VaultError as error:
                    reply = {"ok": False, "error": str(error)}
                except Exception:
                    reply = {"ok": False, "error": "Mac 인증 요청을 완료하지 못했습니다. 보관함 파일은 보존됩니다."}
                try:
                    self.wfile.write(json.dumps(reply, ensure_ascii=False).encode() + b"\n")
                except OSError:
                    pass

        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = True

        self.server = Server(str(self.path), Handler)
        self.path.chmod(0o600)
        self.inode = self.path.stat().st_ino
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .1}, daemon=True)
        self.thread.start()

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=1)
            if self.path.exists() and self.path.stat().st_ino == self.inode:
                self.path.unlink()
