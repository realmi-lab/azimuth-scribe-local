"""Install the app's isolated Python dependencies and the official local Ollama CLI."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile

PYTHON_VERSION = "3.12"
UV_VERSION = "0.13.7"
OLLAMA_VERSION = "0.33.3"
OLLAMA_URL = f"https://github.com/ollama/ollama/releases/download/v{OLLAMA_VERSION}/ollama-darwin.tgz"
OLLAMA_SHA256 = "342db03df80bb9db84ff64246031bd5f70c09b59ff52fa5cc9aaae3476cc4a9d"


def ensure_python(root, sync=False):
    root = Path(root)
    python = root / ".venv" / "bin" / "python"
    if python.exists() and not sync:
        check = subprocess.run([str(python), "-c",
                                "import sys,fastapi,uvicorn,faster_whisper,multipart,httpx; "
                                "assert sys.version_info[:2] == (3,12)"], capture_output=True)
        if check.returncode == 0:
            return python
    uv = shutil.which("uv")
    if not uv:
        bootstrap = root / ".bootstrap"
        bootstrap_python = bootstrap / "bin" / "python"
        if not bootstrap_python.exists():
            subprocess.run([sys.executable, "-m", "venv", str(bootstrap)], check=True)
        uv = str(bootstrap / "bin" / "uv")
        if not Path(uv).exists():
            subprocess.run([str(bootstrap_python), "-m", "pip", "install",
                            "--disable-pip-version-check", f"uv=={UV_VERSION}"], check=True)
    if not python.exists():
        subprocess.run([uv, "venv", "--python", PYTHON_VERSION, str(root / ".venv")], check=True)
    requirements = root / "requirements-lock.txt"
    if not requirements.is_file():
        raise RuntimeError("requirements-lock.txt가 없습니다. 소스 ZIP 전체를 다시 받아 주세요.")
    subprocess.run([uv, "pip", "sync", "--python", str(python), str(requirements)], check=True)
    return python


def portable_ollama(root):
    return Path(root) / ".vendor" / f"ollama-{OLLAMA_VERSION}" / "ollama"


def find_ollama(root):
    existing = shutil.which("ollama")
    if existing:
        return existing
    for folder in (Path("/Applications"), Path.home() / "Applications"):
        app_cli = folder / "Ollama.app" / "Contents" / "Resources" / "ollama"
        if os.access(app_cli, os.X_OK):
            return str(app_cli)
    portable = portable_ollama(root)
    return str(portable) if os.access(portable, os.X_OK) else None


def ensure_ollama(root):
    existing = find_ollama(root)
    if existing:
        print(f"기존 Ollama 사용: {existing}", flush=True)
        return existing
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("자동 설치는 Apple Silicon Mac용입니다. https://ollama.com/download 에서 Ollama를 설치하세요.")
    target = portable_ollama(root).parent
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".download-", dir=target.parent) as temp:
        temp = Path(temp)
        archive = temp / "ollama-darwin.tgz"
        print(f"Ollama {OLLAMA_VERSION} 공식 배포본 다운로드: {OLLAMA_URL}", flush=True)
        subprocess.run(["/usr/bin/curl", "--fail", "--location", "--retry", "2",
                        "--output", str(archive), OLLAMA_URL], check=True)
        digest = hashlib.sha256()
        with archive.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != OLLAMA_SHA256:
            raise RuntimeError("Ollama 다운로드의 SHA-256이 공식 배포본과 일치하지 않습니다.")
        extracted = temp / "extracted"
        extracted.mkdir()
        with tarfile.open(archive) as package:
            # The pinned official archive includes relative library symlinks.
            for member in package.getmembers():
                path = Path(member.name)
                if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir() or member.issym()):
                    raise RuntimeError("Ollama 압축 파일의 경로를 확인할 수 없습니다.")
                if member.issym():
                    link = Path(member.linkname)
                    if link.is_absolute() or ".." in link.parts:
                        raise RuntimeError("Ollama 라이브러리 링크를 확인할 수 없습니다.")
            options = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
            package.extractall(extracted, **options)
        if not os.access(extracted / "ollama", os.X_OK):
            raise RuntimeError("다운로드한 Ollama 실행 파일이 없습니다.")
        # Replace only an incomplete copy created by this installer, never a system install.
        previous = temp / "previous"
        if target.exists():
            target.rename(previous)
        try:
            extracted.rename(target)
        except Exception:
            if previous.exists():
                previous.rename(target)
            raise
    print(f"Ollama 설치 완료: {target}", flush=True)
    return str(target / "ollama")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--python-only", action="store_true", help="Python 의존성만 설치")
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    python = ensure_python(args.root, sync=True)
    if not args.python_only:
        ensure_ollama(args.root)
    print(f"Python 의존성 준비 완료: {python}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"의존성 설치 오류: {exc}", file=sys.stderr)
        sys.exit(1)
