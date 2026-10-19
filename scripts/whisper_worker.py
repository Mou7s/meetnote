"""Offline PCM16/16 kHz mono worker. Length-prefixed frames; zero length flushes."""
import json
import struct
import sys

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps

RATE = 16000


def emit(kind, **data):
    print(json.dumps(dict(type=kind, **data), ensure_ascii=False), flush=True)


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        part = stream.read(size - len(result))
        if not part:
            raise EOFError("Incomplete PCM frame")
        result.extend(part)
    return result


def run():
    model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=8, local_files_only=True)
    options = VadOptions(min_silence_duration_ms=700, speech_pad_ms=200, min_speech_duration_ms=250, max_speech_duration_s=15)
    # Initialize VAD before reporting ready; no microphone or recorded audio is read.
    get_speech_timestamps(np.zeros(512, dtype=np.float32), options)
    emit("ready")
    pending = np.empty(0, dtype=np.float32)
    base = 0
    unchecked = 0

    def drain(force=False):
        nonlocal pending, base
        while len(pending):
            spans = get_speech_timestamps(pending, options)
            if not spans:
                keep = 0 if force else min(len(pending), RATE)
                base += len(pending) - keep
                pending = pending[len(pending) - keep:] if keep else np.empty(0, dtype=np.float32)
                return
            span = spans[0]
            end = span["end"]
            complete = end < len(pending) - int(0.15 * RATE)
            if not force and not complete and len(pending) < 16 * RATE:
                emit("status", text="Whisper 正在听写，停顿后显示文字…")
                return
            start = span["start"]
            emit("status", text="Whisper 正在识别本段声音…")
            segments, _ = model.transcribe(pending[start:end], language="zh", task="transcribe", beam_size=5,
                                          temperature=0, condition_on_previous_text=False, vad_filter=False)
            for segment in segments:
                text = segment.text.strip()
                # Reject timestamps beyond this audio span rather than persisting invented timing.
                if text and segment.start < (end - start) / RATE:
                    emit("final", start=(base + start) / RATE + max(0, segment.start), text=text)
            base += end
            pending = pending[end:]
            emit("status", text="")

    source = sys.stdin.buffer
    while True:
        header = source.read(4)
        if not header:
            break
        if len(header) < 4:
            header += read_exact(source, 4 - len(header))
        size = struct.unpack("<I", header)[0]
        if size > 3200000 or size % 2:
            raise ValueError("Invalid PCM frame size")
        if not size:
            drain(True)
            unchecked = 0
            continue
        samples = np.frombuffer(read_exact(source, size), dtype="<i2").astype(np.float32) / 32768
        pending = np.concatenate((pending, samples))
        unchecked += len(samples)
        if unchecked >= RATE // 2:
            unchecked = 0
            drain()
    drain(True)
    emit("status", text="")


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        emit("error", text=str(error))
        raise
