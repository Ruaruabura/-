"""Offline only; never download weights or send audio to a service."""
import sys
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
segments, _ = model.transcribe(sys.argv[2], beam_size=1, vad_filter=True)
print("".join(segment.text for segment in segments))
