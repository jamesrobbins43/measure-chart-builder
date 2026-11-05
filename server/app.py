# Chart Play-Along analysis server (runs on Modal, one L4 GPU, scales to zero when idle).
#
# POST /  (body = the song file the member picked, any format ffmpeg reads)
#   -> binary reply: b"MCB1" + uint32 JSON length + JSON + the stem MP3s back to back
#      JSON: timings, beats/downbeats (beat_this), per-frame chord evidence (BTC large-vocabulary model
#      on the separated music, without drums and vocals), bass chroma from the bass stem, and where each stem is.
# The song is decoded in memory and nothing is written to disk or kept after the reply (CJ: don't store audio).
#
# Models (all MIT licensed, so fine for a paid membership site):
#   Demucs htdemucs_6s  - drums, bass, vocals, guitar, piano, other   (facebookresearch/demucs)
#   beat_this final0    - beats and downbeats                          (CPJKU/beat_this)
#   BTC large vocab     - chord probabilities, 170 classes             (jayg996/BTC-ISMIR19)
import io, json, os, struct, subprocess, sys, time

import modal

APP = "chart-play-along"
BTC_REV = "master"
app = modal.App(APP)


def _bake():
    """Runs once while the image is built, so a cold start never downloads anything."""
    from demucs.pretrained import get_model
    get_model("htdemucs_6s")
    from beat_this.inference import Audio2Beats
    Audio2Beats(checkpoint_path="final0", device="cpu")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "curl")
    .pip_install(
        "torch==2.4.1", "torchaudio==2.4.1", "numpy<2", "scipy", "librosa==0.10.2.post1", "soundfile",
        "demucs==4.0.1", "beat-this==1.1.0", "einops", "rotary-embedding-torch", "soxr", "pyyaml",
        "fastapi[standard]",
    )
    .run_commands(
        f"git clone https://github.com/jayg996/BTC-ISMIR19 /opt/btc && cd /opt/btc && git checkout {BTC_REV}",
        "test -s /opt/btc/test/btc_model_large_voca.pt",
        # the BTC code predates NumPy 1.24, which removed np.float / np.int / np.bool
        r"sed -i -E 's/np\.(float|int|bool)\b/\1/g' /opt/btc/*.py /opt/btc/utils/*.py",
    )
    .run_function(_bake)
)

# spending guard: the page is public, so cap how many songs can be processed (CJ pays per GPU second)
LIMITS = {"per_ip_hour": int(os.environ.get("MCB_PER_IP_HOUR", "12")), "per_day": int(os.environ.get("MCB_PER_DAY", "400"))}
counts = modal.Dict.from_name("mcb-counts", create_if_missing=True)
ORIGINS = {"https://measure-chart-builder.pages.dev", "https://www.dontgiveup.pro", "https://dontgiveup.pro"}

SR = 44100
QUAL = {  # BTC large-vocab qualities -> pitch classes above the root
    "min": [0, 3, 7], "maj": [0, 4, 7], "dim": [0, 3, 6], "aug": [0, 4, 8], "min6": [0, 3, 7, 9], "maj6": [0, 4, 7, 9],
    "min7": [0, 3, 7, 10], "minmaj7": [0, 3, 7, 11], "maj7": [0, 4, 7, 11], "7": [0, 4, 7, 10], "dim7": [0, 3, 6, 9],
    "hdim7": [0, 3, 6, 10], "sus2": [0, 2, 7], "sus4": [0, 5, 7],
}
QLIST = ["min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4"]
ROOTS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def decode(data: bytes):
    import numpy as np
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "2", "-ar", str(SR), "pipe:1"],
                       input=data, capture_output=True, check=True)
    x = np.frombuffer(p.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
    return x  # (2, T)


def mp3(x, kbps=112) -> bytes:
    import numpy as np
    pcm = np.ascontiguousarray(np.clip(x.T, -1, 1).astype(np.float32)).tobytes()
    p = subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ac", str(x.shape[0]), "-ar", str(SR), "-i", "pipe:0",
                        "-codec:a", "libmp3lame", "-b:a", f"{kbps}k", "-f", "mp3", "pipe:1"], input=pcm, capture_output=True, check=True)
    return p.stdout


@app.cls(image=image, gpu=["L4", "A10G", "T4"], timeout=300, scaledown_window=300, max_containers=4, enable_memory_snapshot=False)
@modal.concurrent(max_inputs=1)
class Analyzer:
    @modal.enter()
    def load(self):
        import torch
        sys.path.insert(0, "/opt/btc")
        from demucs.pretrained import get_model
        from beat_this.inference import Audio2Beats
        from btc_model import BTC_model
        t = time.time()
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.sep = get_model("htdemucs_6s").to(self.dev).eval()
        self.beats = Audio2Beats(checkpoint_path="final0", device=self.dev, float16=self.dev == "cuda")
        cfg = dict(feature_size=144, timestep=108, num_chords=170, input_dropout=0.2, layer_dropout=0.2, attention_dropout=0.2,
                   relu_dropout=0.2, num_layers=8, num_heads=4, hidden_size=128, total_key_depth=128, total_value_depth=128,
                   filter_size=128, loss="ce", probs_out=False)
        ck = torch.load("/opt/btc/test/btc_model_large_voca.pt", map_location=self.dev, weights_only=False)
        self.btc = BTC_model(config=cfg).to(self.dev).eval()
        self.btc.load_state_dict(ck["model"])
        self.btc_mean, self.btc_std = float(ck["mean"]), float(ck["std"])
        import numpy as np
        T = np.zeros((170, 12), np.float32)  # each chord class as the pitch classes it sounds
        for i in range(168):
            r, q = divmod(i, 14)
            for iv in QUAL[QLIST[q]]:
                T[i, (r + iv) % 12] = 1.0
        self.tmpl = T
        self.load_s = round(time.time() - t, 2)

    def run(self, data: bytes):
        import numpy as np, torch, librosa
        tm = {}; t0 = time.time()
        x = decode(data); dur = x.shape[1] / SR; tm["decode"] = round(time.time() - t0, 2)
        if dur > 15 * 60: raise ValueError("song longer than 15 minutes")

        # 1) parts
        t = time.time()
        from demucs.apply import apply_model
        wav = torch.from_numpy(x).to(self.dev)
        ref = wav.mean(0); m, s = ref.mean(), ref.std() + 1e-8
        with torch.no_grad():
            out = apply_model(self.sep, ((wav - m) / s)[None], shifts=0, split=True, overlap=0.25, device=self.dev, progress=False)[0]
        out = (out * s + m).float().cpu().numpy()  # (6, 2, T)
        stems = dict(zip(self.sep.sources, out))  # drums, bass, other, vocals, guitar, piano
        tm["separate"] = round(time.time() - t, 2)

        # 2) beats on the whole song
        t = time.time()
        b, db = self.beats(x.mean(0), SR)
        tm["beats"] = round(time.time() - t, 2)

        # 3) chords on the music without drums and vocals (BTC: 22.05 kHz mono, CQT 144 bins, 24/oct, hop 2048, 10 s pieces)
        t = time.time()
        # every feature is worked out in the same 10 s pieces BTC was trained on, so all frames line up (108 frames per piece)
        L = 22050 * 10
        def pieces(y, fn):
            return np.concatenate([fn(np.pad(y[a:a + L], (0, max(0, 22050 - len(y[a:a + L]))))) for a in range(0, len(y), L)], 1)
        mus = (stems["bass"] + stems["other"] + stems["guitar"] + stems["piano"]).mean(0)
        y = librosa.resample(mus, orig_sr=SR, target_sr=22050)
        F = np.log(pieces(y, lambda z: np.abs(librosa.cqt(z, sr=22050, n_bins=144, bins_per_octave=24, hop_length=2048))) + 1e-6).T
        n = F.shape[0]; F = (F - self.btc_mean) / self.btc_std
        pad = (-n) % 108; F = np.pad(F, ((0, pad), (0, 0)))
        with torch.no_grad():
            ft = torch.tensor(F, dtype=torch.float32, device=self.dev)[None]
            P = []
            for k in range(0, ft.shape[1], 108):
                h, _ = self.btc.self_attn_layers(ft[:, k:k + 108])
                P.append(torch.softmax(self.btc.output_layer.output_projection(h), -1)[0])
            P = torch.cat(P, 0)[:n].cpu().numpy()  # (n, 170)
        C = P @ self.tmpl  # chord evidence per pitch class
        top = P.argmax(1)
        fps = 108 / 10.0
        labels = []; cur = None; st = 0
        for i, c in enumerate(list(top) + [-1]):
            if c != cur:
                if cur is not None and i > st:
                    lab = "N" if cur == 169 else "X" if cur == 168 else ROOTS[cur // 14] + ("" if cur % 14 == 1 else ":" + QLIST[cur % 14])
                    labels.append([round(st / fps, 3), round(i / fps, 3), lab])
                cur, st = c, i
        # bass notes from the bass part
        yb = librosa.resample(stems["bass"].mean(0), orig_sr=SR, target_sr=22050)
        Bq = pieces(yb, lambda z: np.abs(librosa.cqt(z, sr=22050, n_bins=48, bins_per_octave=12, hop_length=2048, fmin=librosa.note_to_hz("E1"))))
        B = np.zeros((Bq.shape[1], 12), np.float32)
        for k in range(48):
            B[:, (k + 4) % 12] += Bq[k]  # E1 is pitch class 4
        E = pieces(y, lambda z: librosa.feature.rms(y=z, frame_length=4096, hop_length=2048, center=True))[0]
        m_ = min(len(B), n, len(E)); B = B[:m_]; C = C[:m_]; E = E[:m_]
        tm["chords"] = round(time.time() - t, 2)

        # 4) parts back to the page as MP3 (other = the song minus these, worked out in the page)
        t = time.time()
        from concurrent.futures import ThreadPoolExecutor
        names = ["vocals", "drums", "bass", "guitar", "piano"]
        with ThreadPoolExecutor(5) as ex:
            blobs = list(ex.map(lambda k: mp3(stems[k]), names))
        lv = {k: float(np.sqrt(np.mean(stems[k][:, ::50] ** 2))) for k in self.sep.sources}
        tm["encode"] = round(time.time() - t, 2)
        tm["total"] = round(time.time() - t0, 2)

        meta = {"v": 1, "dur": dur, "timings": tm, "load_s": self.load_s, "beats": [round(float(v), 4) for v in b],
                "downbeats": [round(float(v), 4) for v in db],
                "chroma": {"fps": fps, "offset": 0.0, "frames": int(m_), "C": np.round(C, 4).ravel().tolist(),
                           "B": np.round(B / (B.max(1, keepdims=True) + 1e-9), 3).ravel().tolist(), "E": np.round(E, 5).tolist()},
                "chords": labels, "levels": lv, "stems": []}
        off = 0
        for k, bl in zip(names, blobs):
            meta["stems"].append({"name": k, "offset": off, "length": len(bl)}); off += len(bl)
        js = json.dumps(meta, separators=(",", ":")).encode()
        return b"MCB1" + struct.pack("<I", len(js)) + js + b"".join(blobs)

    @modal.method()
    def analyze(self, data: bytes) -> bytes:
        return self.run(data)

    @modal.asgi_app()
    def api(self):
        from fastapi import FastAPI, Request
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse, Response
        web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        web.add_middleware(CORSMiddleware, allow_origins=sorted(ORIGINS), allow_methods=["GET", "POST"], allow_headers=["content-type"], max_age=86400)

        @web.get("/warm")
        def warm():  # the page calls this when it opens, so the GPU is ready by the time a song is picked
            return {"ok": True, "load_s": self.load_s}

        @web.post("/analyze")
        async def analyze(request: Request):
            if request.headers.get("origin", "") not in ORIGINS:
                return JSONResponse({"error": "not allowed"}, 403)
            ip = (request.headers.get("x-forwarded-for", "") or "?").split(",")[0].strip()
            hr, day = time.strftime("%Y%m%d%H", time.gmtime()), time.strftime("%Y%m%d", time.gmtime())
            ki, kd = f"ip:{ip}:{hr}", f"day:{day}"
            ni, nd = counts.get(ki, 0) + 1, counts.get(kd, 0) + 1
            if ni > LIMITS["per_ip_hour"] or nd > LIMITS["per_day"]:
                return JSONResponse({"error": "busy"}, 429)
            counts[ki] = ni; counts[kd] = nd
            data = await request.body()
            if not data or len(data) > 60_000_000:
                return JSONResponse({"error": "bad size"}, 413)
            try:
                out = self.run(data)
            except Exception as e:  # noqa: BLE001
                print("analyze failed:", repr(e))
                return JSONResponse({"error": "could not read that song"}, 422)
            finally:
                del data
            return Response(out, media_type="application/octet-stream")

        return web
