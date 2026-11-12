"""Authenticated encrypted storage. Keys and access sessions exist only in memory.

Each file contains a size-authenticated header and independently authenticated
1 MiB AES-256-GCM blocks. Seeking audio never requires a plaintext disk copy.
"""
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path
import secrets
import struct
import time
import uuid

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"SLCVA1\r\n"
HEADER = struct.Struct(">8s16sQ")
BLOCK = 1024 * 1024
TAG = 16
COOKIE = "scribe_vault"
IDLE_SECONDS = 300


def file_cipher(key, salt):
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=b"local-encoder-file-v1").derive(key)
    return AESGCM(derived)


class VaultError(Exception):
    pass


class EncryptedReader(io.RawIOBase):
    def __init__(self, path, key, binding):
        super().__init__()
        self.source = path.open("rb")
        try:
            self.header = self.source.read(HEADER.size)
            if len(self.header) != HEADER.size:
                raise VaultError("암호화 파일의 헤더가 손상되었습니다.")
            magic, self.prefix, self.size = HEADER.unpack(self.header)
            count = max(1, math.ceil(self.size / BLOCK))
            if magic != MAGIC or count >= 2**32 or path.stat().st_size != HEADER.size + self.size + count * TAG:
                raise VaultError("암호화 파일의 길이 또는 형식이 올바르지 않습니다.")
            self.cipher, self.binding = file_cipher(key, self.prefix), binding
            self.position, self.cached_index, self.cached = 0, -1, b""
            # Authenticate the header even for an empty file or a zero-byte read.
            self._block(0)
        except Exception:
            self.source.close()
            raise

    def _block(self, index):
        if self.cached_index != index:
            size = min(BLOCK, max(0, self.size - index * BLOCK))
            self.source.seek(HEADER.size + index * (BLOCK + TAG))
            encrypted = self.source.read(size + TAG)
            counter = struct.pack(">I", index)
            try:
                self.cached = self.cipher.decrypt(b"\0" * 8 + counter, encrypted, self.binding + self.header + counter)
            except InvalidTag as exc:
                raise VaultError("암호화 파일이 손상되었거나 다른 보관함의 파일입니다.") from exc
            self.cached_index = index
        return self.cached

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        position = offset if whence == io.SEEK_SET else self.position + offset if whence == io.SEEK_CUR else self.size + offset
        if whence not in (io.SEEK_SET, io.SEEK_CUR, io.SEEK_END) or position < 0:
            raise ValueError("Invalid seek")
        self.position = position
        return position

    def read(self, size=-1):
        if self.closed:
            raise ValueError("File is closed")
        left = max(0, self.size - self.position)
        left = left if size is None or size < 0 else min(left, size)
        result = bytearray()
        while left:
            index, start = divmod(self.position, BLOCK)
            part = self._block(index)[start:start + left]
            result.extend(part)
            self.position += len(part)
            left -= len(part)
        return bytes(result)

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def close(self):
        self.source.close()
        self.cached = b""
        self.cipher = None
        super().close()


class Vault:
    def __init__(self, folder):
        self.folder = Path(folder).resolve()
        self.meta_path = self.folder / "vault.json"
        self.meta = json.loads(self.meta_path.read_text()) if self.meta_path.exists() else None
        if self.meta and (self.meta.get("version") != 1 or len(self.meta.get("id", "")) != 32):
            raise VaultError("지원하지 않는 보관함입니다. 원본을 보존하세요.")
        self._key = None
        self.sessions = set()
        self.last_activity = 0
        self.closing = False
        self.failed_attempts, self.retry_at = 0, 0

    @property
    def unlocked(self):
        return self._key is not None and not self.closing

    def status(self):
        return {"initialized": self.meta is not None, "locked": not self.unlocked,
                "locking": self.closing, "id": self.meta["id"] if self.meta else None,
                "auth_mode": self.meta.get("auth_mode", "legacy") if self.meta else "macos",
                "idle_seconds": IDLE_SECONDS}

    @staticmethod
    def _derive(password, salt):
        return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(password.encode("utf-8"))

    def setup(self, password, *, identity=None, native=False):
        if self.meta:
            raise VaultError("이미 보관함이 있습니다. 비밀번호로 잠금을 해제하세요.")
        if any(self.folder.glob("*.enc")):
            raise VaultError("기존 암호화 파일의 vault.json이 없습니다. 보관함 전체 백업을 복원하세요.")
        if any(path.exists() and next(path.glob("*.enc"), None) for path in (self.folder / "Recordings", self.folder / "Results")):
            raise VaultError("기존 암호화 파일의 vault.json이 없습니다. 보관함 전체 백업을 복원하세요.")
        if not 8 <= len(password) <= 256 or not password.strip() or len(password.encode("utf-8")) > 1024:
            raise VaultError("보관함 비밀번호는 8~256자로 입력하세요.")
        if native:
            self._native_secret(password)
        identity = identity or uuid.uuid4().hex
        if not re.fullmatch(r"[0-9a-f]{32}", identity):
            raise VaultError("보관함 식별자가 올바르지 않습니다.")
        key, salt, nonce = secrets.token_bytes(32), secrets.token_bytes(16), secrets.token_bytes(12)
        wrapped = AESGCM(self._derive(password, salt)).encrypt(nonce, key, identity.encode())
        meta = {"version": 1, "id": identity, "salt": salt.hex(), "nonce": nonce.hex(), "wrapped_key": wrapped.hex()}
        if native:
            meta["auth_mode"] = "macos"
        # Commit the wrapped key before migration: a crash can always be resumed.
        self._atomic(self.meta_path, json.dumps(meta).encode())
        self.meta, self._key = meta, bytearray(key)

    @staticmethod
    def _native_secret(secret):
        if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9+/]{43}=", secret):
            raise VaultError("Mac 키체인 인증 키 형식이 올바르지 않습니다.")

    def adopt_native(self, legacy_secret, native_secret):
        """Rewrap the same data key, retaining the ID and every encrypted file."""
        self._native_secret(native_secret)
        if not self.meta or self.meta.get("auth_mode") == "macos":
            raise VaultError("기존 비밀번호 방식의 보관함이 아닙니다.")
        self.unlock(legacy_secret)
        salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
        wrapped = AESGCM(self._derive(native_secret, salt)).encrypt(nonce, bytes(self._key), self.meta["id"].encode())
        meta = {**self.meta, "salt": salt.hex(), "nonce": nonce.hex(), "wrapped_key": wrapped.hex(), "auth_mode": "macos"}
        self._atomic(self.meta_path, json.dumps(meta).encode())
        self.meta = meta
        self.sessions.clear()

    def unlock(self, password):
        if not self.meta:
            raise VaultError("먼저 보관함 비밀번호를 설정하세요.")
        if time.monotonic() < self.retry_at:
            raise VaultError("잠시 후 다시 시도하세요.")
        try:
            derived = self._derive(password, bytes.fromhex(self.meta["salt"]))
            key = AESGCM(derived).decrypt(bytes.fromhex(self.meta["nonce"]), bytes.fromhex(self.meta["wrapped_key"]), self.meta["id"].encode())
        except InvalidTag as exc:
            self.failed_attempts += 1
            if self.failed_attempts >= 5:
                self.retry_at = time.monotonic() + 30
            raise VaultError("보관함 비밀번호가 올바르지 않습니다.") from exc
        self.failed_attempts = 0
        self._key = bytearray(key)
        self.closing = False

    def new_session(self):
        token = secrets.token_urlsafe(32)
        self.sessions.add(hashlib.sha256(token.encode()).digest())
        self.touch()
        return token

    def authorized(self, token):
        return self.unlocked and bool(token) and hashlib.sha256(token.encode()).digest() in self.sessions

    def touch(self):
        self.last_activity = time.monotonic()

    def lock(self):
        self.sessions.clear()
        if self._key is not None:
            self._key[:] = b"\0" * len(self._key)
        self._key = None
        self.closing = False

    def _binding(self, path):
        relative = Path(path).resolve().relative_to(self.folder)
        return b"scribe-vault-v1\0" + self.meta["id"].encode() + b"\0" + relative.as_posix().encode() + b"\0"

    @staticmethod
    def encrypted(path):
        return Path(str(path) + ".enc")

    @staticmethod
    def _sync_directory(folder):
        descriptor = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _atomic(path, data):
        temp = path.with_name("." + path.name + "." + secrets.token_hex(8) + ".tmp")
        try:
            with temp.open("xb") as output:
                os.chmod(temp, 0o600)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp, path)
            Vault._sync_directory(path.parent)
        finally:
            temp.unlink(missing_ok=True)

    def seal(self, path, source, size):
        if self._key is None:
            raise VaultError("보관함이 잠겨 있습니다.")
        path = Path(path)
        destination = self.encrypted(path)
        temp = destination.with_name("." + destination.name + "." + secrets.token_hex(8) + ".tmp")
        prefix = secrets.token_bytes(16)
        header = HEADER.pack(MAGIC, prefix, size)
        cipher, binding = file_cipher(bytes(self._key), prefix), self._binding(path)
        try:
            with temp.open("xb") as output:
                os.chmod(temp, 0o600)
                output.write(header)
                left = size
                for index in range(max(1, math.ceil(size / BLOCK))):
                    part = source.read(min(BLOCK, left))
                    if len(part) != min(BLOCK, left):
                        raise VaultError("암호화 중 원본 파일이 변경되었습니다. 원본을 보존했습니다.")
                    counter = struct.pack(">I", index)
                    output.write(cipher.encrypt(b"\0" * 8 + counter, part, binding + header + counter))
                    left -= len(part)
                if source.read(1):
                    raise VaultError("암호화 중 원본 파일이 변경되었습니다. 원본을 보존했습니다.")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp, destination)
            self._sync_directory(destination.parent)
        finally:
            temp.unlink(missing_ok=True)

    def open(self, path):
        if self._key is None:
            raise VaultError("보관함이 잠겨 있습니다.")
        return EncryptedReader(self.encrypted(path), bytes(self._key), self._binding(path))

    def read_bytes(self, path):
        with self.open(path) as source:
            return source.read()

    def write_bytes(self, path, data):
        self.seal(path, io.BytesIO(data), len(data))

    def load_json(self, path, default):
        return json.loads(self.read_bytes(path)) if self.encrypted(path).exists() else default

    def save_json(self, path, value):
        self.write_bytes(path, json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8"))

    def import_file(self, path):
        """Verify a recoverable encrypted copy before unlinking the legacy file."""
        path = Path(path)
        if path.is_symlink() or not path.is_file():
            raise VaultError("보관함 안의 파일 경로를 확인하세요.")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for part in iter(lambda: source.read(BLOCK), b""):
                digest.update(part)
            source.seek(0)
            if not self.encrypted(path).exists():
                self.seal(path, source, path.stat().st_size)
        verified = hashlib.sha256()
        with self.open(path) as encrypted:
            for part in iter(lambda: encrypted.read(BLOCK), b""):
                verified.update(part)
        if not secrets.compare_digest(digest.digest(), verified.digest()):
            raise VaultError("암호화 복사본이 원본과 다릅니다. 두 파일을 모두 보존했습니다.")
        path.unlink()
        self._sync_directory(path.parent)

    def migrate(self):
        for name in ("workspace.json", "prompts.json", "replacements.json", "workspace.tmp", "prompts.tmp", "replacements.tmp"):
            path = self.folder / name
            if path.exists():
                self.import_file(path)
        for name in ("Recordings", "Results"):
            for path in (self.folder / name).iterdir():
                if path.is_file() and not path.name.endswith((".enc", ".tmp")):
                    self.import_file(path)
