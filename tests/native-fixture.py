"""Disposable test harness: simulate the already-authenticated native boundary.

This is not loaded by the app. It refuses installed/user data directories.
Real LocalAuthentication remains a manual Mac UI check.
"""
import base64
import json
import os
from pathlib import Path
import socket
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SECRET = base64.b64encode(b"T" * 32).decode()
IDENTITY = "a" * 32


def test_folder(value):
    folder = Path(value).resolve()
    assert folder.parent == Path(tempfile.gettempdir()).resolve() and folder.name.startswith("scribe-"), "Disposable test data only"
    return folder


def unlock(folder):
    folder = test_folder(folder)
    metadata = folder / "vault.json"
    body = {"action": "unlock" if metadata.exists() else "initialize", "id": IDENTITY, "secret": SECRET}
    with socket.socket(socket.AF_UNIX) as channel:
        channel.connect(str(folder / ".native-auth.sock"))
        channel.sendall(json.dumps(body).encode() + b"\n")
        with channel.makefile("rb") as response:
            result = json.loads(response.readline())
    assert result.get("ok"), result.get("error")
    return result


if __name__ == "__main__":
    folder = test_folder(os.environ["SCRIBE_DATA_DIR"])
    if sys.argv[1] == "unlock":
        print(json.dumps(unlock(folder)))  # Captured by the parent test, never logged.
    elif sys.argv[1] == "serve":
        import server
        import uvicorn
        # Mock kernel peer attestation only in this fenced, disposable test process.
        server.native_channel.verify_peer = lambda _connection: True
        uvicorn.run(server.app, host="127.0.0.1", port=int(os.environ["SCRIBE_PORT"]), log_level="warning")
    else:
        raise SystemExit("Unknown fixture action")
