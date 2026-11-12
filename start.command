#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
python3 launcher.py
scribe_app="$HOME/Applications/Local LLM Encoder.app"
if [ -d "$scribe_app" ]; then
  exec /usr/bin/open "$scribe_app"
fi
exec python3 launcher.py --open
