#!/usr/bin/env bash
set -eu
# Optional local speech/OCR runtime. Model weights are provisioned separately.
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cache_dir=${HARNESS_LOCAL_TOOLS_DIR:-/workspace/.cache/harness}
mkdir -p "$cache_dir/tessdata"
python3 -m venv "$cache_dir/speech-venv"
"$cache_dir/speech-venv/bin/python" -m pip --cache-dir "$cache_dir/pip" install -r "$repo_dir/requirements/local-speech.lock"
for tool in ffmpeg ffprobe pdftotext pdfinfo tesseract; do
  command -v "$tool" >/dev/null || { echo "Missing system tool: $tool" >&2; exit 1; }
done
curl --fail --location --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/chi_sim.traineddata \
  -o "$cache_dir/tessdata/chi_sim.traineddata.download"
printf '%s  %s\n' a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730 "$cache_dir/tessdata/chi_sim.traineddata.download" | sha256sum --check
mv "$cache_dir/tessdata/chi_sim.traineddata.download" "$cache_dir/tessdata/chi_sim.traineddata"
# Use the system's installed English data, never silently substitute for Chinese.
system_tessdata=$(tesseract --list-langs 2>&1 | sed -n 's/.*"\(.*\)".*/\1/p' | head -1)
if [ -n "$system_tessdata" ] && [ -f "$system_tessdata/eng.traineddata" ]; then
  cp "$system_tessdata/eng.traineddata" "$cache_dir/tessdata/eng.traineddata"
fi
echo 'Local runtime ready. Provision trusted faster-whisper-small weights separately before speech inference.'
