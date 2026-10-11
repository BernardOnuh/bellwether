#!/bin/sh
# Full rebuild of the demo video. Optional: VOICE="Ava (Premium)" ./build.sh
set -e
cd "$(dirname "$0")"
python3 make_tg.py >/dev/null
python3 make_vo.py
python3 make_scenes.py
python3 make_audio.py
python3 render_video.py
