#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
python3 menubar/build.py
exec /usr/bin/open "$HOME/Applications/Local LLM Encoder.app"
