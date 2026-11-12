# Local LLM Encoder

[Azimuth Scribe의 공개 소개](https://azimuthkorea.blogspot.com/2026/10/azimuth-scribe.html)와 사용자 매뉴얼의 화면·기능을 참고해 새로 구현한 localhost 웹앱입니다. 원본 Windows 실행 파일이나 원본 프로그램 코드를 사용하지 않습니다.

## 다운로드·처음 설치

- **[설치 파일·릴리스](https://github.com/realmi-lab/azimuth-scribe-local/releases/latest)**
- **[소스 ZIP 바로 다운로드](https://github.com/realmi-lab/azimuth-scribe-local/archive/refs/heads/main.zip)**
- **[모델·의존성 다운로드 링크 모음](docs/downloads.md)**
- **[로컬 LLM(요약 모델) 다운로드](#로컬-llm-다운로드)**

자동 설치 대상은 **macOS 14 이상 / Apple Silicon(M1 이후)**입니다. Windows용 설치 파일은 포함하지 않습니다. Ollama의 macOS 요구 사항은 [공식 문서](https://docs.ollama.com/macos)를 따릅니다.

1. Apple Command Line Tools가 없다면 터미널에서 `xcode-select --install`을 실행해 설치를 마칩니다. [Apple 다운로드 안내](https://developer.apple.com/xcode/resources/)
2. 위 ZIP을 풀고, 해당 폴더에서 `setup.command`를 실행합니다. 터미널에서는 `zsh setup.command`로 실행할 수 있습니다.
3. 설치 완료 메시지가 나오면 `~/Applications/Local LLM Encoder.app`을 엽니다. Dock에 고정하려면 아이콘 우클릭 → 옵션 → Dock에 유지를 선택합니다.
4. 패널에서 **Touch ID** 또는 **Mac 로그인 암호로 열기**를 누르고 macOS 인증창에서 인증합니다. 별도 앱 비밀번호는 만들지 않습니다. 기존 보관함은 저장된 키체인 연결을 한 번의 본인 인증으로 전환합니다. [암호화·백업·보호 범위](docs/security.md)

설치 파일은 Python 3.12, 잠긴 Python 의존성, Ollama, Whisper small, Qwen3 4B Instruct를 준비합니다. Python은 [uv의 관리형 Python 다운로드](https://docs.astral.sh/uv/guides/install-python/)를 사용합니다. Ollama가 없으면 공식 `v0.33.3` CLI 배포본을 받아 SHA-256을 확인하고 앱 전용 폴더에 설치합니다. 기존 Ollama가 있으면 그대로 사용합니다. 처음에는 인터넷과 모델 약 3GB 외에 Python 환경·다운로드 임시 공간이 필요합니다.

Git으로 받는 경우:

```sh
git clone https://github.com/realmi-lab/azimuth-scribe-local.git
cd azimuth-scribe-local
zsh setup.command
```

모델 준비가 끝나야 설치가 성공으로 표시됩니다. 실패하면 터미널의 오류와 `data/server.log`를 확인하세요. 설치 중 시작한 서버는 계속 실행되며 `stop.command`로 중지할 수 있습니다.

## 로컬 LLM 다운로드

요약에 쓰는 로컬 LLM과 음성 인식 모델은 용량이 커서(약 3GB) Git 저장소에 넣지 않습니다. GitHub는 파일당 100MB(LFS도 2GB)까지만 올릴 수 있기 때문입니다. 아래 **공식 배포처**에서 받습니다. `setup.command`를 실행하면 자동으로 받으므로 보통은 따로 받을 필요가 없습니다.

### 1. Ollama 설치

로컬 LLM을 실행하는 프로그램입니다. 없으면 `setup.command`가 공식 CLI를 앱 전용 폴더에 자동 설치합니다.

- 다운로드: **https://ollama.com/download**

### 2. 요약 모델 받기 (Qwen3)

| 모델 | 크기 | 용도 | 공식 페이지 | 받는 명령 |
| --- | --- | --- | --- | --- |
| **Qwen3 4B Instruct** (기본) | 약 2.5GB | 한국어 요약 · 권장 | https://ollama.com/library/qwen3:4b-instruct | `ollama pull qwen3:4b-instruct` |
| Qwen3 1.7B | 약 1.4GB | 가볍고 빠름 · 메모리 8GB Mac | https://ollama.com/library/qwen3:1.7b | `ollama pull qwen3:1.7b` |
| Qwen3 8B | 약 5.2GB | 더 정확함 · 메모리 16GB 이상 권장 | https://ollama.com/library/qwen3:8b | `ollama pull qwen3:8b` |

- 원본 모델(Hugging Face): https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507 · 라이선스 Apache-2.0
- 저장 위치: `~/.ollama/models/`

### 3. 음성 인식 모델 받기 (Whisper)

| 모델 | 크기 | 공식 페이지 | 파일 직접 다운로드 |
| --- | --- | --- | --- |
| **faster-whisper small** (기본) | 약 484MB | https://huggingface.co/Systran/faster-whisper-small | https://huggingface.co/Systran/faster-whisper-small/resolve/main/model.bin |

- 저장 위치: `~/Library/Application Support/Azimuth Scribe Local/data/models/faster-whisper-small/`

### 한 번에 받기

```sh
zsh download-models.command
```

앱 안에서는 `⋯` → **설정…** → **모델 및 음성 인식 설정** → **모델 준비 / 다시 불러오기**를 누르면 됩니다. 인터넷은 처음 모델을 받을 때만 필요하고, 그 뒤 녹음·받아쓰기·요약은 모두 이 Mac 안에서 처리합니다.

## 실행

처음 설치 후에는 모델을 다시 내려받지 않고 로컬 파일을 사용합니다.

1. Dock의 **Local LLM Encoder** 또는 `~/Applications/Local LLM Encoder.app`을 엽니다.
2. 메뉴 막대의 마이크 아이콘을 누르면 아이콘 아래에 작업 패널이 열립니다. 위쪽에서 녹음하고, 왼쪽에서 녹음 파일·받아쓰기, 오른쪽에서 요약을 다룹니다.
3. 받아쓰기·요약의 잘못 인식된 말은 **일괄 수정**으로 한 번에 고칠 수 있습니다. 긴 회의는 자동으로 구간을 나눠 요약합니다.

메뉴에서 환경설정, 서버 시작·중지·재시작, 현재 작업 중단, 녹음·결과 폴더 열기, 로그 보기를 사용할 수 있습니다. 작업 중에는 서버 중지·재시작·모두 종료가 비활성화되므로 먼저 **현재 작업 중단**을 누르세요. **컨트롤러만 종료**는 서버를 유지하고, **모두 종료**는 이 프로젝트가 시작한 서버와 Ollama를 함께 종료합니다. 기존에 실행 중이던 Ollama는 종료하지 않습니다.

패널 창을 닫아도 메뉴 막대 아이콘은 유지됩니다. 아이콘이나 Dock 아이콘을 누르면 패널이 다시 열립니다. **http://localhost:18765**를 브라우저로 열면 Mac 앱으로 이동하는 안내가 표시됩니다. 녹음·메모 접근과 본인 인증은 Mac 앱에서만 제공합니다. 자동 로그인 실행은 설정하지 않습니다.

`start.command`는 서버와 메뉴 컨트롤러를 실행하며, `stop.command`는 서버를 중지합니다. 메뉴 컨트롤러를 다시 빌드·설치하려면 메뉴에서 **모두 종료**를 누른 뒤 `install-menubar.command`를 실행합니다. 빌드에는 Apple Command Line Tools가 필요합니다. 실행 코드와 데이터는 `~/Library/Application Support/Azimuth Scribe Local/`에 설치되므로 앱 실행에 문서 폴더 접근 권한은 필요하지 않습니다. 다시 설치해도 기존 설치의 데이터는 유지합니다.

터미널에서는 다음과 같이 실행할 수 있습니다.

```sh
python3 launcher.py
# 종료
python3 launcher.py --stop
```

서버는 `127.0.0.1`에만 연결합니다. 포트를 바꾸려면 `SCRIBE_PORT=18766 python3 launcher.py`처럼 실행합니다. 다른 앱이 쓰는 포트의 프로세스를 종료하지 않습니다.

## 사용

- **녹음·파일 추가:** 메뉴 막대에서 녹음 시작 → 녹음 종료를 누르거나, 기록 화면의 파일 추가·드래그로 음성을 가져옵니다. 녹음은 localhost에서 16 kHz 모노 WAV로 변환해 저장합니다. 전송 실패 시 녹음을 메모리에 유지하고 다시 저장할 수 있습니다.
- **기록 카드:** 왼쪽 메뉴와 오른쪽 카드 목록에서 파일명·원문·요약을 검색합니다. 카드 안에서 음성 재생, 원문·요약 전환, 복사, 기록 정보, 목록 제거를 할 수 있습니다. 목록에서 제거해도 보관된 음성 파일은 남습니다.
- **다시 처리:** 카드 메뉴에서 해당 음성의 받아쓰기 또는 일반 요약·회의록·진료 기록·법률 상담을 실행합니다. 위쪽 받아쓰기는 화면에 보이는 선택 항목을 일괄 처리합니다. 중단하면 완료된 결과는 남습니다.
- **편집·내보내기:** 카드의 제목이나 편집을 누르면 해당 기록의 원문·요약을 넓게 편집합니다. 내용은 자동 저장됩니다. 저장 버튼은 선택한 기록의 TXT·Markdown을 암호화해 보관하며, 일반 파일 내보내기도 선택할 수 있습니다. ‘전체 메모’는 받아쓰기 합본과 직접 입력하는 메모를 위한 별도 공간입니다.
- **설정·서식:** 왼쪽 메뉴에서 모델·언어·실행 장치와 요약 서식을 편집합니다. 저장한 결과와 녹음 파일은 파일 보관함에서 확인할 수 있습니다.

입력 텍스트, 요약, 파일 목록, 설정, 요약 서식은 앱의 데이터 폴더에 자동 저장되고 재실행 후 복원됩니다.

## 로컬 모델

이 Mac의 기본값은 **Whisper small / CPU int8**, **Qwen3 4B Instruct / Ollama 자동 장치 선택**입니다. 요약 모델은 원본과 같은 `qwen3:4b-instruct`입니다. 원본 매뉴얼의 음성 인식 기본값은 Whisper large-v3입니다. 이 구현에서는 속도와 메모리를 고려해 small을 선택했으며, Preferences에서 base·small·medium·large-v3 중 선택 후 **모델 준비 / 다시 불러오기**를 누를 수 있습니다.

요약용 자동 다운로드는 `qwen3:1.7b`, `qwen3:4b-instruct`, `qwen3:8b`를 지원합니다. 설치된 다른 로컬 모델은 'Qwen 모델만 표시'를 해제해 선택할 수 있습니다. 요약 전에 로컬 GGUF 파일과 텍스트 생성 지원 여부를 확인하며 클라우드·임베딩·추론 전용 모델은 거부합니다. NVIDIA CUDA가 없으면 Whisper는 CPU를 사용하고, Ollama는 지원되는 GPU를 자체 선택합니다.

모델을 따로 준비하려면 `zsh download-models.command` 또는 `python3 launcher.py --download-models`를 실행합니다. 필요한 경우 서버도 시작하고 모델 준비가 끝날 때까지 기다립니다. 화면에서 선택한 모델을 준비하며, 진행 중인 작업이 있으면 이를 덮어쓰지 않습니다. 기본 다운로드 주소와 수동 명령은 [다운로드 안내](docs/downloads.md)에 있습니다.

준비된 Whisper는 `local_files_only=True`로 불러오며 음성·텍스트를 외부 API로 보내지 않습니다. 프론트엔드의 JS·CSS·아이콘도 모두 이 서버에서 제공합니다. 자동 모델 다운로드에 계정·API 키·유료 클라우드 서비스는 필요하지 않습니다.

## 저장 위치

아래 `data/` 경로는 설치 후 **`~/Library/Application Support/Azimuth Scribe Local/data/`** 기준입니다. 프로젝트의 실행 명령도 `.local-install.json`을 통해 같은 설치를 제어합니다. 첫 설치 전에 있던 프로젝트의 `data/`는 원래 위치에 보존되며 이후 저장은 설치된 데이터 폴더에서 이루어집니다. 메뉴의 **녹음 폴더 열기** 또는 **저장 결과 폴더 열기**로 바로 접근할 수 있습니다.

| 경로 | 내용 |
| --- | --- |
| `data/Recordings/*.enc` | 암호화된 녹음 및 불러온 음성 파일 사본 |
| `data/Results/*.enc` | 암호화된 TXT·Markdown 결과 |
| `data/workspace.json.enc` | 암호화된 파일 목록, 받아쓰기, 요약 |
| `data/vault.json` | 키체인에 저장한 무작위 비밀값으로 암호화한 보관함 키와 메타데이터 |
| `data/settings.json` | 모델과 언어 설정 |
| `data/prompts.json.enc`, `data/replacements.json.enc` | 암호화된 사용자 서식과 일괄 수정 규칙 |
| `data/models/` | Whisper 모델 |
| `data/server.log`, `data/ollama.log` | 이 실행기가 시작한 프로세스의 로그 |
| `.venv/`, `.bootstrap/` | 전용 Python 환경과 부트스트랩 도구 |
| `.vendor/ollama-0.33.3/` | 기존 Ollama가 없을 때 설치하는 공식 CLI와 라이브러리 |
| `~/.ollama/models/` | Ollama의 로컬 모델 (기존 Ollama와 공유) |

백업 시 서버를 중지하고 `vault.json`을 포함한 `data/` 전체를 복사합니다. 복원에는 해당 보관함의 Mac 키체인 항목도 필요하며, Mac 로그인 암호만으로 새 Mac에서 복구할 수 없습니다. 목록에서 제거해도 암호화된 음성은 남습니다. 기존에 가져온 원본·이전 백업은 자동으로 변경하지 않습니다. [보호 범위와 복구 안내](docs/security.md)를 확인하세요.

## 검증

암호화 저장·검증 이관·잠금 후 API 차단·자동 잠금은 임시 데이터로 검사합니다.

```sh
.venv/bin/python tests/vault-smoke.py
```

실제 로컬 모델로 한국어 합성 음성을 변환하고 요약하는 통합 검증입니다. 테스트 데이터는 임시 폴더에만 만들고 실제 작업 데이터를 수정하지 않습니다. macOS의 `say`와 이미 준비된 모델이 필요합니다. 소스 폴더에 개발용 Python 환경이 없다면 먼저 `python3 bootstrap.py --python-only`를 실행합니다.

```sh
.venv/bin/python tests/smoke.py
```

JS의 입력·저장·설정·서식·내보내기 연결은 jsdom에서 별도로 확인합니다. jsdom은 개발 검증에만 사용하며 앱 실행에는 필요하지 않습니다.

```sh
npm install --prefix /tmp/azimuth-dom --no-audit --no-fund jsdom
NODE_PATH=/tmp/azimuth-dom/node_modules node tests/dom-smoke.cjs
```

통합 검증용 포트는 8766, DOM 검증용 포트는 8767입니다. 브라우저 렌더링과 실제 마이크의 권한·입력 동작은 이 검증에 포함하지 않습니다.

새 설치의 경로·의존성·공식 Ollama 압축 해제·모델 준비 명령은 다음과 같이 별도 검증합니다. 임시 폴더만 사용하며 기존 설치를 중지하거나 수정하지 않습니다. 이미 준비된 기본 모델과 Ollama가 필요하며, 공식 Ollama CLI 배포본을 임시 폴더로 내려받습니다. 통합 검증용 포트는 18767입니다.

```sh
python3 tests/install-smoke.py
```

## 구현

화면 구성과 후속 개선 방향은 [디자인·UI/UX 참고 조사](docs/ui-ux-references.md)에 정리했습니다.

빌드 과정 없는 HTML/CSS/JavaScript와 FastAPI/Python 서버를 사용합니다. 받아쓰기는 faster-whisper, 파일 디코딩·WAV 저장은 PyAV, 요약은 `127.0.0.1:11434`의 Ollama API가 수행합니다. 의존성은 `requirements-lock.txt`에 고정했습니다. PyAV 19의 API 변경과 faster-whisper 1.2.1의 호환 문제를 피하기 위해 검증한 PyAV 16.1.0을 사용합니다.

오류가 나면 `data/server.log`와 화면 아래 상태 메시지를 확인합니다. 실행 중 포트 충돌이 있으면 `SCRIBE_PORT`를 바꾸어 실행합니다.
