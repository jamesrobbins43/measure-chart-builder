# Checks the deployed server end to end with a made-up 32 s song (no real music): C G Am F, 120 BPM, with a kick drum.
import json, struct, sys, time
import numpy as np
import modal

SR = 44100
def tone(f, n): t = np.arange(n) / SR; return sum(np.sin(2 * np.pi * f * k * t) / k for k in (1, 2, 3)) * np.exp(-t * 1.5)
def chord(notes, n): return sum(tone(440 * 2 ** ((m - 69) / 12), n) for m in notes) / len(notes)
bar = int(SR * 2.0)  # 4 beats at 120 BPM
prog = [("C", [48, 60, 64, 67]), ("G", [43, 59, 62, 67]), ("A:min", [45, 60, 64, 69]), ("F", [41, 60, 65, 69])]
y = np.concatenate([chord(n, bar) for _, n in prog] * 4)
kick = np.exp(-np.arange(int(SR * 0.12)) / (SR * 0.03)) * np.sin(2 * np.pi * 55 * np.arange(int(SR * 0.12)) / SR)
for b in range(0, len(y) - len(kick), SR // 2): y[b:b + len(kick)] += 0.8 * kick
y = (0.4 * y / np.abs(y).max()).astype(np.float32)
import subprocess
data = subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ac", "1", "-ar", str(SR), "-i", "pipe:0", "-b:a", "128k", "-f", "mp3", "pipe:1"],
                      input=y.tobytes(), capture_output=True, check=True).stdout

A = modal.Cls.from_name("chart-play-along", "Analyzer")()
t = time.time(); out = A.analyze.remote(data); wall = time.time() - t
assert out[:4] == b"MCB1", out[:40]
n = struct.unpack("<I", out[4:8])[0]; meta = json.loads(out[8:8 + n])
print("round trip", round(wall, 1), "s; server timings", meta["timings"], "model load", meta["load_s"], "s")
print("beats", len(meta["beats"]), "first", meta["beats"][:4], "downbeats", meta["downbeats"][:4])
print("chords", [c for c in meta["chords"] if c[1] - c[0] > 0.5][:12])
print("stems", [(s["name"], s["length"]) for s in meta["stems"]], "reply", len(out), "bytes")
try: print("WEB URL", A.api.get_web_url())
except Exception as e: print("web url lookup failed", e)
found = {c[2] for c in meta["chords"] if c[1] - c[0] > 0.5}
ok = {"C", "G", "A:min", "F"} <= found and len(meta["beats"]) > 40
print("SMOKE", "PASS" if ok else "FAIL", sorted(found))
sys.exit(0 if ok else 1)
