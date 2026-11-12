"""Start/stop only this project's local processes. No account or cloud service."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

from bootstrap import ensure_python, find_ollama

SOURCE_ROOT = Path(__file__).resolve().parent
ROOT = SOURCE_ROOT
INSTALL_LINK = SOURCE_ROOT / ".local-install.json"
if INSTALL_LINK.exists():
    installation = json.loads(INSTALL_LINK.read_text())
    candidate = Path(installation["runtime_path"]).resolve()
    receipt = json.loads((candidate / "installation.json").read_text())
    if receipt.get("source_path") != str(SOURCE_ROOT) or installation.get("source_path") != str(SOURCE_ROOT):
        raise RuntimeError("설치 경로가 이 프로젝트와 일치하지 않습니다. 메뉴 앱을 다시 설치하세요.")
    ROOT = candidate
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True, mode=0o700)
PIDFILE = DATA / "processes.json"
PORT = int(os.environ.get("SCRIBE_PORT", "18765"))
URL = f"http://localhost:{PORT}"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(url, body=None):
    headers = {"Content-Type": "application/json", "X-Scribe-Request": "1"}
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with OPENER.open(req, timeout=3) as response:
        return json.load(response)


def alive(url):
    try:
        return request(url)
    except (OSError, ValueError):
        return None


def start_process(args, logfile, env=None):
    with (DATA / logfile).open("a") as output:
        process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=output, stderr=output, start_new_session=True)
    return {"pid": process.pid, "args": args}


def stop():
    if not PIDFILE.exists():
        print("이 실행기가 시작한 프로세스 기록이 없습니다.")
        return
    processes = json.loads(PIDFILE.read_text())
    for name in ("server", "ollama"):
        entry = processes.get(name)
        if not entry:
            continue
        result = subprocess.run(["ps", "-p", str(entry["pid"]), "-o", "command="], capture_output=True, text=True)
        expected = " ".join(entry["args"])
        if result.returncode == 0 and expected in result.stdout.strip():
            os.kill(entry["pid"], signal.SIGTERM)
            for _ in range(50):
                current = subprocess.run(["ps", "-p", str(entry["pid"]), "-o", "command="], capture_output=True, text=True)
                if current.returncode != 0 or expected not in current.stdout.strip():
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError(f"{name}의 종료를 기다리는 중입니다. 잠시 후 stop.command를 다시 실행하세요.")
            print(f"{name} 중지 완료")
    PIDFILE.unlink(missing_ok=True)


def prepare_python():
    return ensure_python(ROOT)


def prepare_models(wait=False):
    job = request(URL + "/api/models/prepare", {"whisper": True, "ollama": True})
    if not wait:
        return
    message = None
    while True:
        current = request(URL + "/api/state")["runtime"]["job"]
        if not current or current["id"] != job["id"]:
            raise RuntimeError("모델 준비 작업이 변경되었습니다. 화면의 상태를 확인하세요.")
        if current["message"] != message:
            message = current["message"]
            progress = current.get("progress")
            print(message + (f" ({progress:.0%})" if progress is not None else ""), flush=True)
        if current["status"] == "completed":
            return
        if current["status"] in ("error", "cancelled"):
            raise RuntimeError(current["message"])
        time.sleep(0.5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--open", action="store_true", help="사용자가 실행할 때 기본 브라우저 열기")
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--download-models", action="store_true", help="로컬 모델을 내려받고 준비 완료까지 대기 (서버도 시작)")
    args = parser.parse_args()
    if args.stop:
        stop()
        return
    existing = alive(URL + "/api/health")
    if existing:
        if existing.get("app") != "azimuth-scribe-local" or existing.get("root") != str(ROOT):
            raise RuntimeError(f"포트 {PORT}에서 다른 앱이 실행 중입니다. SCRIBE_PORT를 변경해 주세요.")
        print(f"이미 실행 중입니다: {URL}")
        if args.download_models:
            prepare_models(wait=True)
        if args.open:
            webbrowser.open(URL)
        return
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(("127.0.0.1", PORT)) == 0:
            raise RuntimeError(f"포트 {PORT}에서 다른 앱이 실행 중입니다. SCRIBE_PORT를 변경해 주세요.")
    python = prepare_python()
    processes = {}
    if not alive("http://127.0.0.1:11434/api/tags"):
        ollama = find_ollama(ROOT)
        if not ollama:
            raise RuntimeError("Ollama가 필요합니다. setup.command로 설치하거나 https://ollama.com/download 를 확인하세요.")
        env = {**os.environ, "OLLAMA_HOST": "127.0.0.1:11434", "OLLAMA_NO_CLOUD": "1"}
        processes["ollama"] = start_process([ollama, "serve"], "ollama.log", env)
        PIDFILE.write_text(json.dumps(processes, indent=2))
        for _ in range(80):
            if alive("http://127.0.0.1:11434/api/tags"):
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("Ollama 시작에 실패했습니다. data/ollama.log를 확인하세요.")
    processes["server"] = start_process([str(python), str(ROOT / "server.py")], "server.log")
    PIDFILE.write_text(json.dumps(processes, indent=2))
    PIDFILE.chmod(0o600)
    for _ in range(100):
        health = alive(URL + "/api/health")
        if health and health.get("app") == "azimuth-scribe-local" and health.get("root") == str(ROOT):
            break
        time.sleep(0.2)
    else:
        raise RuntimeError(f"서버 시작에 실패했습니다. 포트 {PORT}와 data/server.log를 확인하세요.")
    print(f"Local LLM Encoder 실행 완료: {URL}")
    print("종료: stop.command 또는 python3 launcher.py --stop")
    prepare_models(wait=args.download_models)
    if args.open:
        webbrowser.open(URL)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"실행 오류: {exc}", file=sys.stderr)
        sys.exit(1)
