"""Fresh install contract in a disposable directory. Requires prepared local models.

Run: python3 tests/install-smoke.py [--ollama-archive /path/to/official/ollama-darwin.tgz]
The optional archive avoids downloading the same official asset again; its digest is still checked.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import runpy
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import bootstrap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ollama-archive", type=Path)
    args = parser.parse_args()
    receipt = ROOT / ".local-install.json"
    installed = Path(json.loads(receipt.read_text())["runtime_path"]) if receipt.exists() else ROOT
    models = installed / "data" / "models"
    assert (models / "faster-whisper-small" / "model.bin").is_file(), "Prepare Whisper small first."
    with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2) as response:
        available = json.load(response)
    assert any(item["name"] == "qwen3:4b-instruct" for item in available["models"]), "Prepare Qwen first."
    # Keep the macOS Unix-domain authentication socket below its 104-byte limit.
    with tempfile.TemporaryDirectory(prefix="scribe-i-", dir="/tmp") as temp:
        temp = Path(temp)
        source, home = temp / "source", temp / "h"
        source.mkdir()
        home.mkdir()
        for name in ("bootstrap.py", "launcher.py", "server.py", "vault.py", "native_auth.py", "requirements.txt", "requirements-lock.txt"):
            shutil.copy2(ROOT / name, source / name)
        for folder in ("menubar", "static"):
            shutil.copytree(ROOT / folder, source / folder, ignore=shutil.ignore_patterns("__pycache__"))
        # This affects only this Python process's install paths, not macOS HOME or user settings.
        with patch.object(Path, "home", return_value=home):
            runpy.run_path(str(source / "menubar" / "build.py"), run_name="__install_check__")
        runtime = home / "Library" / "Application Support" / "Azimuth Scribe Local"
        app = home / "Applications" / "Local LLM Encoder.app"
        info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
        assert info["ScribeProjectPath"] == str(runtime)
        assert not (source / "data").exists() and not (source / ".venv").exists()
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        print("PASS: clean source installs a signed native controller with an isolated runtime", flush=True)

        python = bootstrap.ensure_python(runtime, sync=True)
        uv = shutil.which("uv") or str(runtime / ".bootstrap" / "bin" / "uv")
        subprocess.run([uv, "pip", "check", "--python", str(python)], check=True)
        print("PASS: fresh Python 3.12 environment installs and resolves the locked dependency set", flush=True)

        with patch.object(bootstrap, "find_ollama", return_value=None):
            if args.ollama_archive:
                with patch.object(bootstrap, "OLLAMA_URL", args.ollama_archive.resolve().as_uri()):
                    ollama = bootstrap.ensure_ollama(runtime)
            else:
                ollama = bootstrap.ensure_ollama(runtime)
        subprocess.run([ollama, "--version"], check=True)
        assert Path(ollama).is_file()
        print("PASS: official Ollama archive digest, extraction, library links and executable", flush=True)

        (runtime / "data" / "models").symlink_to(models, target_is_directory=True)
        env = {**os.environ, "SCRIBE_PORT": "18767", "PYTHONUNBUFFERED": "1"}
        command = [str(python), str(source / "launcher.py")]
        try:
            prepared = subprocess.run(command + ["--download-models"], env=env, capture_output=True, text=True, timeout=180)
            print(prepared.stdout, end="", flush=True)
            assert prepared.returncode == 0, prepared.stderr
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            setup = urllib.request.Request("http://127.0.0.1:18767/api/vault/setup", method="POST",
                                           data=json.dumps({"password": "test-only-install-password"}).encode(),
                                           headers={"Content-Type": "application/json", "X-Scribe-Request": "1"})
            try:
                opener.open(setup, timeout=10)
                raise AssertionError("HTTP password login must be disabled")
            except urllib.error.HTTPError as error:
                assert error.code == 410
            try:
                opener.open("http://127.0.0.1:18767/api/state", timeout=2)
                raise AssertionError("Private state must require Mac authentication")
            except urllib.error.HTTPError as error:
                assert error.code == 423
            with opener.open("http://127.0.0.1:18767/api/models/status", timeout=2) as response:
                assert json.load(response)["job"]["status"] == "completed"
            with opener.open("http://127.0.0.1:18767/api/vault/status", timeout=2) as response:
                assert json.load(response)["initialized"] is False
            processes = json.loads((runtime / "data" / "processes.json").read_text())
            assert "ollama" not in processes, "Existing shared Ollama must not become owned."
            print("PASS: source launcher redirects to installed runtime and waits for actual model readiness", flush=True)

            subprocess.run(command + ["--stop"], env=env, check=True)
            settings_file = runtime / "data" / "settings.json"
            settings = json.loads(settings_file.read_text())
            settings["llm_model"] = "not-an-auto-download-model"
            settings_file.write_text(json.dumps(settings))
            rejected = subprocess.run(command + ["--download-models"], env=env, capture_output=True, text=True, timeout=10)
            assert rejected.returncode != 0, "A rejected model setup must not report success."
            print("PASS: rejected model preparation returns a failure exit status", flush=True)
        finally:
            subprocess.run(command + ["--stop"], env=env, check=True)
        assert not (runtime / "data" / "processes.json").exists()
        print("PASS: only the disposable server is stopped; shared Ollama remains available", flush=True)


if __name__ == "__main__":
    main()
