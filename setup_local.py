"""Install the native controller, dependencies, and local models on Apple Silicon macOS."""
import json
from pathlib import Path
import platform
import subprocess
import sys

from bootstrap import ensure_ollama, ensure_python

ROOT = Path(__file__).resolve().parent


def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64" or int(platform.mac_ver()[0].split(".")[0]) < 14:
        raise RuntimeError("메뉴 앱 설치는 macOS 14 이상 Apple Silicon Mac을 지원합니다.")
    compiler = subprocess.run(["/usr/bin/xcrun", "--find", "swiftc"], capture_output=True)
    if compiler.returncode:
        raise RuntimeError("Apple Command Line Tools가 필요합니다. xcode-select --install 로 설치한 뒤 다시 실행하세요.")
    print("1/3 메뉴 앱 설치… (기존 설치는 메뉴에서 모두 종료한 뒤 진행)", flush=True)
    subprocess.run([sys.executable, str(ROOT / "menubar" / "build.py")], check=True)
    runtime = Path(json.loads((ROOT / ".local-install.json").read_text())["runtime_path"])
    print("2/3 Python 3.12 · 잠긴 의존성 · Ollama 준비…", flush=True)
    python = ensure_python(runtime, sync=True)
    ensure_ollama(runtime)
    print("3/3 Whisper · Qwen 다운로드… 최초 준비에는 시간이 걸립니다.", flush=True)
    subprocess.run([str(python), str(runtime / "launcher.py"), "--download-models"], check=True)
    print("설치 완료. ~/Applications/Local LLM Encoder.app 을 열어 주세요.", flush=True)
    print("프로그램: http://localhost:18765 · 종료: stop.command", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"설치 오류: {exc}", file=sys.stderr)
        sys.exit(1)
