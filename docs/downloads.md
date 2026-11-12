# 모델·의존성 다운로드

## 한 번에 설치

**[프로그램 소스 ZIP](https://github.com/realmi-lab/azimuth-scribe-local/archive/refs/heads/main.zip)** 또는 **[최신 릴리스](https://github.com/realmi-lab/azimuth-scribe-local/releases/latest)**를 받은 뒤 압축을 풀고 다음을 실행합니다.

```sh
zsh setup.command
```

macOS 14 이상 Apple Silicon Mac과 Apple Command Line Tools가 필요합니다. 도구가 없다면 먼저 `xcode-select --install`로 설치를 마칩니다. 설치기는 Python 환경, 아래 의존성과 기본 모델을 준비한 뒤 `http://localhost:18765` 서버를 실행합니다. 메뉴 앱은 `~/Applications/Local LLM Encoder.app`에 설치합니다. 모델 파일은 각 공식 배포처에서 받으며 Git 저장소에는 포함하지 않습니다.

## 기본 모델

| 용도 | 모델 | 공식 다운로드·모델 페이지 | 자동 다운로드 방법 |
| --- | --- | --- | --- |
| 한국어 요약 | **Qwen3 4B Instruct** · `qwen3:4b-instruct` · 약 2.5GB | [Ollama 모델 페이지](https://ollama.com/library/qwen3:4b-instruct) | `ollama pull qwen3:4b-instruct` 또는 앱의 모델 준비 |
| 음성 인식 | **faster-whisper small** · 다국어 · `model.bin` 약 484MB | [Systran 모델 페이지](https://huggingface.co/Systran/faster-whisper-small), [model.bin 다운로드](https://huggingface.co/Systran/faster-whisper-small/resolve/main/model.bin), [전체 파일 목록](https://huggingface.co/Systran/faster-whisper-small/tree/main) | `download-models.command` 또는 앱의 모델 준비 |

설치가 끝난 뒤 모델만 다시 준비하려면:

```sh
zsh download-models.command
# 같은 명령
python3 launcher.py --download-models
```

서버가 없으면 함께 시작합니다. 현재 설정의 Whisper·Qwen 모델을 준비하고 성공·오류·중단을 확인한 뒤 종료합니다. 모델 다운로드가 끝나도 서버는 유지됩니다. 모델 준비 중에는 터미널에 단계별 진행 상태가 표시됩니다. 다른 STT·요약 작업 중에는 모델 준비를 시작하지 않습니다.

수동으로 Whisper 모델을 받으려면 전용 Python 환경에서 다음을 실행합니다. 기본 설치 위치가 기준입니다.

```sh
"$HOME/Library/Application Support/Azimuth Scribe Local/.venv/bin/python" - <<'PY'
from pathlib import Path
from huggingface_hub import snapshot_download
target = Path.home() / "Library/Application Support/Azimuth Scribe Local/data/models/faster-whisper-small"
snapshot_download(
    repo_id="Systran/faster-whisper-small",
    local_dir=str(target),
    allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "preprocessor_config.json"],
)
PY
```

Ollama를 앱 전용 폴더에 설치한 경우 CLI는 `~/Library/Application Support/Azimuth Scribe Local/.vendor/ollama-0.33.3/ollama`입니다. 위 `download-models.command`는 이 경로를 자동으로 찾습니다. Qwen은 `~/.ollama/models/`, Whisper는 앱의 `data/models/`에 보관합니다.

## 실행 의존성

| 항목 | 설치 방법·버전 | 공식 링크 |
| --- | --- | --- |
| Apple Command Line Tools | 메뉴 앱 컴파일용, `xcode-select --install` | [Apple](https://developer.apple.com/xcode/resources/) |
| Python | 설치기가 **3.12** 환경을 준비 | [Python](https://www.python.org/downloads/), [uv 관리형 Python](https://docs.astral.sh/uv/guides/install-python/) |
| uv | 기존 uv 사용, 없으면 전용 환경에 **0.13.7** 설치 | [PyPI](https://pypi.org/project/uv/0.13.7/) |
| Ollama | 기존 설치 사용, 없으면 공식 CLI **0.33.3** 설치 | [다운로드 페이지](https://ollama.com/download), [고정 버전 배포본](https://github.com/ollama/ollama/releases/tag/v0.33.3) |
| Python 패키지 | FastAPI, Uvicorn, faster-whisper, CTranslate2, PyAV, HTTPX, cryptography 및 전이 의존성 | [전체 잠금 파일](../requirements-lock.txt), [직접 의존성 범위](../requirements.txt) |

Ollama 자동 설치의 고정 배포 파일:

- [ollama-darwin.tgz · v0.33.3](https://github.com/ollama/ollama/releases/download/v0.33.3/ollama-darwin.tgz)
- SHA-256: `342db03df80bb9db84ff64246031bd5f70c09b59ff52fa5cc9aaae3476cc4a9d`

Python 의존성만 소스 폴더에 설치하는 개발용 명령:

```sh
python3 bootstrap.py --python-only
```

PyAV가 사용하는 FFmpeg 라이브러리는 [공식 binary wheel](https://pyav.org/docs/stable/overview/installation.html)에 포함되므로 기본 설치에 별도 FFmpeg CLI는 필요하지 않습니다. 앱 실행에는 Node.js·npm·Docker가 필요하지 않습니다. `jsdom`은 선택적인 개발 검증에만 사용합니다.

## 업데이트와 데이터

기존 설치를 업데이트할 때는 메뉴의 **모두 종료**로 이 앱이 시작한 프로세스를 종료하고, 같은 소스 폴더에서 `git pull` 후 `zsh setup.command`를 실행합니다. 기존 데이터와 모델은 유지됩니다. 기존 Ollama 프로세스를 공유한 경우에는 그 프로세스를 종료하지 않습니다.

녹음·텍스트·설정·모델·로그·Python 가상환경은 Git에 올리지 않습니다. 백업은 `~/Library/Application Support/Azimuth Scribe Local/data/`를 복사합니다. 모델과 의존성의 라이선스는 [Third-party notices](../THIRD_PARTY_NOTICES.md)를 확인하세요.

1.1.0부터 보관함 비밀번호 설정 후 녹음·텍스트를 암호화합니다. `vault.json`과 `.enc` 파일을 함께 백업하고 비밀번호를 따로 보관하세요. [암호화와 기존 데이터 이관](security.md)을 확인하세요. 기존 모델 준비 명령은 잠긴 상태에서도 사용할 수 있습니다.

1.2.0부터 새 보관함 비밀번호의 최소 길이는 8자입니다. 기존 보관함의 비밀번호와 저장 데이터는 유지됩니다. 기록 화면은 사이드바와 녹음별 카드로 구성하며, 각 녹음의 원문·요약 편집과 암호화 음성 재생을 지원합니다.
