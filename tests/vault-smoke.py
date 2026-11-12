"""Focused vault contracts, using disposable data and no Keychain prompts/models."""
import asyncio
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import wave

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vault import Vault, VaultError, BLOCK, HEADER, IDLE_SECONDS

PASSWORD = "test-only-long-vault-passphrase"
SECRET = "개인 회의 기록: 금요일 오전 열 시에 제품 발표"


def wave_data():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * 16000)
    return output.getvalue()


class FileContracts(unittest.TestCase):
    def test_seek_authentication_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "audio.wav"
            data = os.urandom(BLOCK + 357)
            vault = Vault(root)
            vault.setup(PASSWORD)
            vault.write_bytes(path, data)
            self.assertFalse(path.exists())
            with vault.open(path) as audio:
                self.assertEqual(audio.read(17), data[:17])
                audio.seek(BLOCK - 7)
                self.assertEqual(audio.read(50), data[BLOCK - 7:BLOCK + 43])
                audio.seek(-30, io.SEEK_END)
                self.assertEqual(audio.read(), data[-30:])
            vault.lock()
            with self.assertRaises(VaultError):
                vault.read_bytes(path)
            reopened = Vault(root)
            with self.assertRaises(VaultError):
                reopened.unlock("wrong-password")
            reopened.unlock(PASSWORD)
            self.assertEqual(reopened.read_bytes(path), data)
            encrypted = vault.encrypted(path)
            content = bytearray(encrypted.read_bytes())
            content[HEADER.size + 20] ^= 1
            encrypted.write_bytes(content)
            with self.assertRaises(VaultError):
                reopened.read_bytes(path)

    def test_verified_migration_and_conflict_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "workspace.json"
            path.write_text(SECRET)
            vault = Vault(root)
            vault.setup(PASSWORD)
            vault.import_file(path)
            self.assertFalse(path.exists())
            self.assertEqual(vault.read_bytes(path).decode(), SECRET)
            # A crash after the verified copy and before unlink can be resumed.
            path.write_text(SECRET)
            vault.import_file(path)
            self.assertFalse(path.exists())
            path.write_text("different original")
            with self.assertRaises(VaultError):
                vault.import_file(path)
            self.assertEqual(path.read_text(), "different original")
            self.assertEqual(vault.read_bytes(path).decode(), SECRET)

    def test_empty_truncated_and_renamed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vault = Vault(root)
            vault.setup(PASSWORD)
            path = root / "empty.txt"
            vault.write_bytes(path, b"")
            self.assertEqual(vault.read_bytes(path), b"")
            other = root / "other.txt"
            vault.encrypted(other).write_bytes(vault.encrypted(path).read_bytes())
            with self.assertRaises(VaultError):
                vault.read_bytes(other)
            vault.encrypted(path).write_bytes(vault.encrypted(path).read_bytes()[:-1])
            with self.assertRaises(VaultError):
                vault.read_bytes(path)

    def test_missing_metadata_does_not_replace_existing_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vault = Vault(root)
            vault.setup(PASSWORD)
            path = root / "workspace.json"
            vault.write_bytes(path, SECRET.encode())
            original = vault.encrypted(path).read_bytes()
            vault.meta_path.unlink()
            incomplete = Vault(root)
            with self.assertRaises(VaultError):
                incomplete.setup("different-new-password")
            self.assertFalse(vault.meta_path.exists())
            self.assertEqual(vault.encrypted(path).read_bytes(), original)


class APIContracts(unittest.IsolatedAsyncioTestCase):
    async def test_storage_authentication_migration_and_lock(self):
        with tempfile.TemporaryDirectory(prefix="scribe-vault-api-") as directory:
            root = Path(directory)
            (root / "Recordings").mkdir()
            (root / "Results").mkdir()
            audio = wave_data()
            (root / "Recordings/legacy.wav").write_bytes(audio)
            (root / "Results/legacy.txt").write_text(SECRET)
            (root / "pending-recording.m4a").write_bytes(b"excluded-recording-temp")
            (root / "workspace.json").write_text(json.dumps({"files": [{"id": "legacy", "name": "legacy.wav", "stored_name": "legacy.wav", "selected": True,
                "duration": 1, "status": "Completed", "transcript": SECRET, "error": None}], "transcript": SECRET, "summary": ""}))
            previous = os.environ.get("SCRIBE_DATA_DIR")
            os.environ["SCRIBE_DATA_DIR"] = directory
            import server as s
            if previous is None:
                os.environ.pop("SCRIBE_DATA_DIR")
            else:
                os.environ["SCRIBE_DATA_DIR"] = previous
            s.ollama_status = lambda **_kw: {"connected": False, "models": [], "running": [], "error": "Test: no model required"}
            headers = {"X-Scribe-Request": "1"}
            transport = httpx.ASGITransport(app=s.app)
            async with s.app.router.lifespan_context(s.app), httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:18765", headers=headers) as client:
                async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:18765", headers=headers) as anonymous:
                    self.assertEqual((await client.get("/api/state")).status_code, 423)
                    self.assertEqual((await client.post("/api/vault/setup", json={"password": "short"})).status_code, 400)
                    setup = await client.post("/api/vault/setup", json={"password": PASSWORD})
                    self.assertEqual(setup.status_code, 200, setup.text)
                    self.assertIn("HttpOnly", setup.headers["set-cookie"])
                    old_token = setup.json()["session"]
                    self.assertFalse((root / "workspace.json").exists())
                    self.assertFalse((root / "Recordings/legacy.wav").exists())
                    self.assertEqual((root / "pending-recording.m4a").read_bytes(), b"excluded-recording-temp")
                    self.assertNotIn(PASSWORD, (root / "vault.json").read_text())
                    self.assertEqual((await anonymous.get("/api/state")).status_code, 401)
                    self.assertEqual((await anonymous.get("/api/storage/recordings")).status_code, 401)
                    self.assertEqual((await anonymous.get("/api/download/recordings/legacy.wav")).status_code, 401)
                    state = (await client.get("/api/state")).json()
                    self.assertEqual(state["transcript"], SECRET)
                    self.assertEqual((await client.get("/api/download/recordings/legacy.wav")).content, audio)
                    # PyAV/faster-whisper consume the seekable encrypted reader directly.
                    from faster_whisper.audio import decode_audio
                    with s.VAULT.open(root / "Recordings/legacy.wav") as reader:
                        self.assertEqual(len(decode_audio(reader, sampling_rate=16000)), 16000)
                    with io.BytesIO(audio) as source:
                        added = await client.post("/api/files", files={"files": ("new.wav", source, "audio/wav")}, data={"recording": "true"})
                    self.assertEqual(added.status_code, 200, added.text)
                    self.assertEqual(added.json()["files"][0]["duration"], 1)
                    saved = root / "Recordings" / added.json()["files"][0]["stored_name"]
                    self.assertFalse(saved.exists())
                    self.assertTrue(s.VAULT.encrypted(saved).exists())
                    self.assertEqual((await client.patch("/api/text", json={"summary": SECRET})).status_code, 200)
                    exported = (await client.post("/api/export", json={"kind": "summary", "format": "md"})).json()
                    self.assertTrue((root / "Results" / (exported["filename"] + ".enc")).exists())
                    self.assertFalse((root / "Results" / exported["filename"]).exists())
                    self.assertEqual((await client.get(exported["url"])).text, SECRET)
                    self.assertEqual((await client.put("/api/replacements", json={"rules": [{"find": "개인회의", "replace": "회의"}]})).status_code, 200)
                    self.assertTrue((root / "replacements.json.enc").exists())
                    self.assertEqual((await client.patch("/api/text", json={"summary": "x"}, headers={"Origin": "https://example.com"})).status_code, 403)
                    self.assertEqual((await client.post("/api/vault/lock")).status_code, 200)
                    self.assertIsNone(s.VAULT._key)
                    self.assertEqual(s.STATE["transcript"], "")
                    self.assertEqual((await client.get("/api/state")).status_code, 423)
                    self.assertEqual((await client.post("/api/vault/unlock", json={"password": "wrong"})).status_code, 400)
                    unlock = await client.post("/api/vault/unlock", json={"password": PASSWORD})
                    self.assertEqual(unlock.status_code, 200, unlock.text)
                    self.assertEqual((await client.get("/api/state")).json()["summary"], SECRET)
                    self.assertEqual((await anonymous.get("/api/state", headers={"Authorization": "Bearer " + old_token})).status_code, 401)
                    # Verify idle locking independently of any status/HTTP polling.
                    s.VAULT.last_activity -= IDLE_SECONDS + 1
                    await asyncio.sleep(1.2)
                    self.assertIsNone(s.VAULT._key)
                    self.assertEqual((await client.get(exported["url"])).status_code, 423)
                    self.assertEqual((await client.post("/api/vault/unlock", json={"password": PASSWORD})).status_code, 200)
                    # Locking cancels a running private worker before its key is cleared.
                    def worker():
                        s.RT.cancel.wait(3)
                        s.persist()
                        s.check_cancel()
                    s.start_job("summary", worker)
                    await client.post("/api/vault/lock")
                    for _ in range(50):
                        if s.VAULT._key is None:
                            break
                        await asyncio.sleep(0.02)
                    self.assertIsNone(s.VAULT._key)
                    self.assertEqual((await client.get("/api/state")).status_code, 423)
            for path in root.rglob("*.enc"):
                self.assertNotIn(SECRET.encode(), path.read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)
