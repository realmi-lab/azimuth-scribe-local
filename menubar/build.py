"""Build/install the native controller without launching or changing Dock settings."""
import os
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path.home() / "Library" / "Application Support" / "Azimuth Scribe Local"
DEST = Path.home() / "Applications" / "Local LLM Encoder.app"
BUILD = ROOT / "build" / "Local LLM Encoder.app"
CONTENTS = BUILD / "Contents"
MACOS = CONTENTS / "MacOS"
RESOURCES = CONTENTS / "Resources"
running = subprocess.run(["pgrep", "-fx", str(DEST / "Contents" / "MacOS" / "AzimuthScribe")], capture_output=True)
if running.returncode == 0:
    raise RuntimeError("메뉴에서 모두 종료를 누른 뒤 다시 설치하세요.")
if (RUNTIME / "data" / "processes.json").exists():
    raise RuntimeError("설치된 서버를 먼저 중지한 뒤 다시 설치하세요.")
MACOS.mkdir(parents=True, exist_ok=True)
RESOURCES.mkdir(parents=True, exist_ok=True)
RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
receipt_path = RUNTIME / "installation.json"
if receipt_path.exists() and json.loads(receipt_path.read_text()).get("source_path") != str(ROOT):
    raise RuntimeError("다른 프로젝트의 설치가 있습니다. 기존 설치를 확인하세요.")
if (ROOT / "data" / "processes.json").exists():
    raise RuntimeError("소스 폴더의 서버를 먼저 중지한 뒤 다시 설치하세요.")
for name in ("bootstrap.py", "launcher.py", "server.py", "requirements.txt", "requirements-lock.txt"):
    shutil.copy2(ROOT / name, RUNTIME / name)
shutil.copytree(ROOT / "static", RUNTIME / "static", dirs_exist_ok=True)
if not (RUNTIME / ".venv").exists() and (ROOT / ".venv").exists():
    shutil.copytree(ROOT / ".venv", RUNTIME / ".venv", symlinks=True)
if not (RUNTIME / "data").exists():
    if (ROOT / "data").exists():
        shutil.copytree(ROOT / "data", RUNTIME / "data")
    else:
        (RUNTIME / "data").mkdir(mode=0o700)
receipt = {"source_path": str(ROOT), "runtime_path": str(RUNTIME)}
receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))

info = {
    "CFBundleName": "Local LLM Encoder", "CFBundleDisplayName": "Local LLM Encoder",
    "CFBundleIdentifier": "net.realmi.azimuth-scribe.local",
    "CFBundleExecutable": "AzimuthScribe", "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": "1.0.0", "CFBundleVersion": "1",
    "LSMinimumSystemVersion": "14.0", "NSHighResolutionCapable": True,
    "NSMicrophoneUsageDescription": "메뉴 막대에서 시작한 녹음을 받아쓰려면 마이크 접근이 필요합니다.",
    "NSPrincipalClass": "NSApplication", "LSMultipleInstancesProhibited": True,
    "CFBundleIconFile": "AppIcon", "ScribeProjectPath": str(RUNTIME),
    "ScribePort": int(os.environ.get("SCRIBE_PORT", "18765")),
}
(CONTENTS / "Info.plist").write_bytes(plistlib.dumps(info))
subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-O", "-framework", "AppKit",
                "-target", "arm64-apple-macos14.0", str(ROOT / "menubar" / "main.swift"), str(ROOT / "menubar" / "Panel.swift"), str(ROOT / "menubar" / "Workspace.swift"),
                "-o", str(MACOS / "AzimuthScribe")], check=True)
subprocess.run(["xcrun", "swift", str(ROOT / "menubar" / "icon.swift"), str(RESOURCES / "AppIcon.icns")], check=True)
subprocess.run(["codesign", "--force", "--sign", "-", str(BUILD)], check=True)
DEST.parent.mkdir(parents=True, exist_ok=True)
if DEST.exists():
    old = plistlib.loads((DEST / "Contents" / "Info.plist").read_bytes())
    if old.get("CFBundleIdentifier") != info["CFBundleIdentifier"]:
        raise RuntimeError("같은 이름의 다른 앱이 있습니다. 설치 경로를 확인하세요.")
with tempfile.TemporaryDirectory(prefix=".azimuth-install-", dir=DEST.parent) as staging:
    replacement = Path(staging) / DEST.name
    shutil.copytree(BUILD, replacement)
    if DEST.exists():
        DEST.rename(Path(staging) / "previous.app")
    try:
        replacement.rename(DEST)
    except Exception:
        previous = Path(staging) / "previous.app"
        if previous.exists():
            previous.rename(DEST)
        raise
(ROOT / ".local-install.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
print(f"Installed: {DEST}")
print(f"Runtime: {RUNTIME}")
