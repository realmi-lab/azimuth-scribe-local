"""Focused integration check with real local models and disposable test data.

Run: .venv/bin/python tests/smoke.py
Requires macOS 'say', the prepared Whisper small model and local qwen3:4b-instruct.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import av
import httpx

ROOT = Path(__file__).resolve().parents[1]
INSTALL_LINK = ROOT / ".local-install.json"
MODEL_ROOT = Path(json.loads(INSTALL_LINK.read_text())["runtime_path"]) if INSTALL_LINK.exists() else ROOT
URL = "http://127.0.0.1:8766"
HEADERS = {"X-Scribe-Request": "1"}
PHRASE = "오늘 회의에서는 다음 주 월요일 오전 열 시에 제품 시연을 진행하기로 했습니다. 김민수 씨는 발표 자료를 준비하고, 이지연 씨는 참석자에게 안내 메일을 보내기로 했습니다. 예산은 삼십만 원으로 정했습니다."


def browser_audio(source, target, codec):
    with av.open(str(source)) as inp, av.open(str(target), "w") as out:
        stream = out.add_stream(codec, rate=48000)
        stream.layout = "mono"
        resampler = av.AudioResampler(format="s16" if codec == "libopus" else "fltp", layout="mono", rate=48000)
        for frame in inp.decode(audio=0):
            for converted in resampler.resample(frame):
                converted.pts = None
                for packet in stream.encode(converted):
                    out.mux(packet)
        for converted in resampler.resample(None):
            converted.pts = None
            for packet in stream.encode(converted):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)


def main():
    with tempfile.TemporaryDirectory(prefix="scribe-smoke-") as temp:
        folder = Path(temp)
        (folder / "models").symlink_to(MODEL_ROOT / "data" / "models", target_is_directory=True)
        audio = folder / "회의_검증.aiff"
        subprocess.run(["say", "-v", "Yuna", "-r", "150", "-o", str(audio), PHRASE], check=True)
        browser_inputs = (folder / "회의_검증.webm", folder / "회의_검증.m4a")
        browser_audio(audio, browser_inputs[0], "libopus")
        browser_audio(audio, browser_inputs[1], "aac")
        env = {**os.environ, "SCRIBE_DATA_DIR": str(folder), "SCRIBE_PORT": "8766"}
        log = (folder / "server.log").open("w")
        process = subprocess.Popen([sys.executable, str(ROOT / "server.py")], env=env, stdout=log, stderr=log)
        client = httpx.Client(base_url=URL, headers=HEADERS, trust_env=False, timeout=15)

        def request(method, path, **kwargs):
            response = client.request(method, path, **kwargs)
            response.raise_for_status()
            return response.json()

        def wait_ready():
            for _ in range(150):
                try:
                    if client.get("/api/health").json().get("app") == "azimuth-scribe-local":
                        return
                except (httpx.HTTPError, ValueError):
                    pass
                time.sleep(0.1)
            raise AssertionError("Test server did not start")

        def wait_job(limit=180):
            deadline = time.monotonic() + limit
            while time.monotonic() < deadline:
                state = request("GET", "/api/state")
                if state["runtime"]["job"]["status"] not in ("running", "stopping"):
                    return state
                time.sleep(0.25)
            raise AssertionError("Local inference timed out")

        try:
            wait_ready()
            assert request("GET", "/api/state")["files"] == []
            page = client.get("/")
            assert page.status_code == 200 and "STEP 4 : Local LLM Summary" in page.text
            assert "connect-src 'self'" in page.headers["content-security-policy"]
            assert client.patch("/api/text", json={"transcript": "x"}, headers={"Origin": "https://example.com"}).status_code == 403
            print("PASS: localhost boundary and application assets", flush=True)

            items = []
            for browser_input in browser_inputs:
                with browser_input.open("rb") as source:
                    result = request("POST", "/api/files", files={"files": (browser_input.name, source, "application/octet-stream")}, data={"recording": "true"})
                items.append(result["files"][0])
            first, second = items
            with av.open(str(folder / "Recordings" / first["stored_name"])) as container:
                assert container.streams.audio[0].codec_context.sample_rate == 16000
                assert container.streams.audio[0].codec_context.layout.nb_channels == 1
            assert first["duration"] > 0 and first["name"].endswith(".wav")
            request("POST", f"/api/transcribe?file_id={first['id']}")
            state = wait_job()
            assert state["runtime"]["job"]["status"] == "completed", state["runtime"]["job"]
            assert state["files"][0]["status"] == "Completed" and state["files"][1]["status"] == "Pending", state["files"]
            transcript = state["transcript"]
            assert len(transcript) > 60 and "시연" in transcript, transcript
            print("PASS: WebM/Opus + M4A/AAC import, 16 kHz mono WAV, real Korean STT and file selection", flush=True)
            print("STT:", transcript[:250], flush=True)

            request("PATCH", "/api/files/selection", json={"ids": [first["id"]], "selected": False})
            request("PATCH", "/api/files/selection", json={"ids": [second["id"]], "selected": True})
            request("POST", "/api/transcribe")
            request("POST", "/api/cancel")
            state = wait_job()
            assert state["runtime"]["job"]["status"] == "cancelled"
            assert state["files"][1]["status"] == "Pending" and state["transcript"] == transcript
            print("PASS: STT cancellation preserves finished results", flush=True)

            edited = transcript + "\n\n확인: 다음 회의는 금요일 오후 두 시입니다."
            request("PATCH", "/api/text", json={"transcript": edited})
            request("POST", "/api/summary", json={"prompt": "회의록"})
            state = wait_job()
            assert state["runtime"]["job"]["status"] == "completed", state["runtime"]["job"]
            summary = state["summary"]
            assert len(summary) > 40 and "시연" in summary, summary
            assert "<think>" not in summary and not summary.lstrip().startswith(("Okay", "Let me", "We need")), summary
            request("POST", "/api/summary", json={"prompt": "회의록", "file_id": first["id"]})
            clip_state = wait_job()
            assert clip_state["runtime"]["job"]["status"] == "completed"
            assert len(clip_state["files"][0]["summary"]) > 40
            assert clip_state["summary"] == summary and not clip_state["files"][1].get("summary")
            print("PASS: per-recording transcription and meeting minutes", flush=True)
            for fmt in ("txt", "md"):
                output = request("POST", "/api/export", json={"kind": "summary", "format": fmt})
                assert client.get(output["url"]).text == summary
                assert (folder / "Results" / output["filename"]).read_text() == summary
            print("PASS: real Qwen summary, edited transcript, TXT/Markdown exports", flush=True)
            print("SUMMARY:", summary[:350], flush=True)

            request("POST", "/api/summary", json={"prompt": "일반 요약"})
            for _ in range(240):
                state = request("GET", "/api/state")
                if state["summary"] or state["runtime"]["job"]["status"] != "running":
                    break
                time.sleep(0.05)
            assert state["runtime"]["job"]["status"] == "running", "Summary completed before cancellation could be checked"
            assert state["summary"], "No live partial summary observed"
            request("POST", "/api/cancel")
            state = wait_job()
            assert state["runtime"]["job"]["status"] == "cancelled"
            assert state["summary"]
            print("PASS: live partial summary and cancellation", flush=True)

            prompts = state["prompts"] | {"사용자 서식": "대화에서 결정한 일만 정리하세요."}
            request("PUT", "/api/prompts", json={"prompts": prompts})
            request("PUT", "/api/settings", json=state["settings"] | {"temperature": 0.1})
            request("POST", "/api/files/remove", json={"ids": [second["id"]]})
            assert client.get(f"/api/download/recordings/{second['stored_name']}").status_code == 200
            before = request("GET", "/api/state")
            process.terminate(); process.wait(timeout=10)
            process = subprocess.Popen([sys.executable, str(ROOT / "server.py")], env=env, stdout=log, stderr=log)
            wait_ready()
            after = request("GET", "/api/state")
            assert after["transcript"] == before["transcript"] and after["summary"] == before["summary"]
            assert after["prompts"] == prompts and after["settings"]["temperature"] == 0.1
            assert len(after["files"]) == 1 and len(request("GET", "/api/storage/results")["files"]) == 2
            print("PASS: remove from list, preserved recordings, settings/prompts/results survive restart", flush=True)
        finally:
            client.close()
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
            log.close()
            if process.returncode not in (0, -15):
                print((folder / "server.log").read_text()[-3000:])


if __name__ == "__main__":
    main()
