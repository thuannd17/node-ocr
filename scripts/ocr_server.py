#!/usr/bin/env python3
"""
PaddleOCR micro-service (HTTP) cho Node.js.
Hỗ trợ tự động detect GPU (CUDA) hoặc fallback về CPU.

Stability mode:
  - Chỉ chạy single-worker để tránh treo máy do nhân bản nhiều process OCR.
"""

import json
import inspect
import os
import sys
import threading
import time
import traceback
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Load .env file (nếu có python-dotenv). Các biến đã set sẵn trong shell
# sẽ KHÔNG bị ghi đè (override=False).
try:
    from dotenv import load_dotenv
    _env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    load_dotenv(_env_path, override=False)
except ImportError:
    pass  # python-dotenv chưa cài — bỏ qua, dùng env vars từ shell
# Tắt MKLDNN/oneDNN để tránh lỗi ConvertPirAttribute trên Windows/CPU
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_use_mkldnn_batch_norm", "0")
# GPU allocator (2026-10-08): Paddle's default auto_growth lets VRAM balloon to
# ~5.9 GB and recognition slows ~3x as the server runs. naive_best_fit: 2.8 s ->
# 0.8 s per image, identical OCR text. Set here (not .env) so training processes
# started by retrain-check / kfold keep the default. Override via env if needed.
os.environ.setdefault("FLAGS_allocator_strategy", "naive_best_fit")
os.environ.setdefault("FLAGS_fraction_of_gpu_memory_to_use", "0.5")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")


def _add_windows_cuda_dll_paths():
    if os.name != "nt":
        return
    base = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    if not os.path.isdir(base):
        return
    for root, _, _ in os.walk(base):
        if os.path.basename(root).lower() != "bin":
            continue
        try:
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(root)
        except Exception:
            pass
        if root not in os.environ.get("PATH", ""):
            os.environ["PATH"] = root + os.pathsep + os.environ.get("PATH", "")


_add_windows_cuda_dll_paths()

try:  # Windows console encoding
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = os.environ.get("OCR_SERVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("OCR_SERVER_PORT", "8501"))

if (os.environ.get("OCR_WORKERS") or "1").strip() not in ("", "1"):
    print(f"[ocr-server] Stability mode: OCR_WORKERS={os.environ.get('OCR_WORKERS')} ignored, using 1.")
OCR_WORKERS = 1
# Max requests allowed to WAIT behind the one being OCR'd; beyond that the
# server answers 503 busy at once instead of making the caller wait N x ~3 s.
# 0 = unlimited (old behaviour).
OCR_MAX_QUEUE = max(0, int(os.environ.get("OCR_MAX_QUEUE", "4") or 0))

# Model config
OCR_DET_MODEL = os.environ.get("OCR_DET_MODEL", "")
OCR_REC_MODEL = os.environ.get("OCR_REC_MODEL", "")
OCR_CUSTOM_DET = os.environ.get("OCR_CUSTOM_DET", "")
OCR_CUSTOM_REC = os.environ.get("OCR_CUSTOM_REC", "")
OCR_VERSION = os.environ.get("OCR_VERSION", "")
OCR_FAST_MODE_RAW = os.environ.get("OCR_FAST_MODE", "")
OCR_FAST_MODE = OCR_FAST_MODE_RAW.lower() in {"1", "true", "yes", "on"}
OCR_FAST_MODE_SET = OCR_FAST_MODE_RAW.strip() != ""
OCR_FAST_DET_LIMIT_SIDE_LEN = int(os.environ.get("OCR_FAST_DET_LIMIT_SIDE_LEN", "736"))
OCR_FAST_RECOGNITION_BATCH_SIZE = int(os.environ.get("OCR_FAST_RECOGNITION_BATCH_SIZE", "8"))
OCR_WARMUP = os.environ.get("OCR_WARMUP", "1").lower() in {"1", "true", "yes", "on"}

def _get_int_env(name, default=0):
    try:
        return int(os.environ.get(name, str(default)))
    except Exception:
        return default

OCR_TEXT_DET_LIMIT_SIDE_LEN = _get_int_env("OCR_TEXT_DET_LIMIT_SIDE_LEN", 0)
OCR_TEXT_RECOGNITION_BATCH_SIZE = _get_int_env("OCR_TEXT_RECOGNITION_BATCH_SIZE", 0)

_engine = None
_engine_lock = threading.Lock()
_predict_lock = threading.Lock()

# Concurrency metrics: requests share one model behind _predict_lock, so a
# request's latency = time waiting for the lock (queueMs) + inference (inferMs).
_stats_lock = threading.Lock()
_stats = {"inflight": 0, "waiting": 0, "maxWaiting": 0, "served": 0, "failed": 0,
          "queueMsTotal": 0, "inferMsTotal": 0, "maxQueueMs": 0, "rejectedBusy": 0}

def _stat_add(**deltas):
    with _stats_lock:
        for k, v in deltas.items():
            _stats[k] += v
        _stats["maxWaiting"] = max(_stats["maxWaiting"], _stats["waiting"])

def _detect_device():
    """Tự động chọn GPU nếu có, fallback về CPU."""
    try:
        import paddle
        if paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0:
            gpu_name = ""
            try:
                gpu_name = f" ({paddle.device.cuda.get_device_name(0)})"
            except Exception:
                pass
            print(f"[ocr-server] ✅ GPU detected{gpu_name} → using GPU")
            return "gpu"
    except Exception as e:
        print(f"[ocr-server] GPU check failed: {e}")
    print("[ocr-server] ℹ️  No GPU available → using CPU")
    return "cpu"

def _resolve_fast_mode(device):
    if OCR_FAST_MODE_SET:
        return OCR_FAST_MODE
    return device == "gpu"

def _apply_fast_profile(kwargs, is_paddle3):
    if is_paddle3:
        kwargs["text_detection_model_name"] = OCR_DET_MODEL or "PP-OCRv5_mobile_det"
        kwargs["text_recognition_model_name"] = OCR_REC_MODEL or "en_PP-OCRv5_mobile_rec"
        kwargs.setdefault("text_det_limit_side_len", OCR_FAST_DET_LIMIT_SIDE_LEN)
        kwargs.setdefault("text_recognition_batch_size", OCR_FAST_RECOGNITION_BATCH_SIZE)
    else:
        kwargs.setdefault("det_limit_side_len", OCR_FAST_DET_LIMIT_SIDE_LEN)
        kwargs.setdefault("rec_batch_num", OCR_FAST_RECOGNITION_BATCH_SIZE)

def _warmup_engine(engine, device):
    if not OCR_WARMUP:
        return
    warmup_path = None
    try:
        from PIL import Image, ImageDraw

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            warmup_path = tmp.name

        img = Image.new("RGB", (512, 128), "white")
        draw = ImageDraw.Draw(img)
        draw.text((16, 48), f"warmup-{device}", fill="black")
        img.save(warmup_path, "PNG")

        if hasattr(engine, "predict"):
            list(engine.predict(warmup_path))
        else:
            engine.ocr(warmup_path, cls=False)
    except Exception as exc:
        print(f"[ocr-server] Warmup skipped: {exc}")
    finally:
        if warmup_path and os.path.exists(warmup_path):
            try:
                os.remove(warmup_path)
            except Exception:
                pass

def get_engine():
    """Khởi tạo PaddleOCR an toàn nhất có thể."""
    global _engine
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is not None:
            return _engine

        try:
            from paddleocr import PaddleOCR

            device = os.environ.get("OCR_DEVICE", "").lower() or _detect_device()
            init_params = set(inspect.signature(PaddleOCR.__init__).parameters)
            is_paddle3 = "device" in init_params
            fast_mode = _resolve_fast_mode(device)

            # Cấu hình BAREBONE: Tắt các pipeline phụ gây crash/chậm
            kwargs = {
                "use_doc_orientation_classify": False,
                "use_doc_unwarping": False,
                "use_textline_orientation": False,
            }

            if is_paddle3:
                kwargs["device"] = device
            else:
                kwargs["use_gpu"] = device == "gpu"
                kwargs["use_angle_cls"] = False
                kwargs["show_log"] = False

            if OCR_TEXT_DET_LIMIT_SIDE_LEN > 0:
                if is_paddle3:
                    kwargs["text_det_limit_side_len"] = OCR_TEXT_DET_LIMIT_SIDE_LEN
                else:
                    kwargs["det_limit_side_len"] = OCR_TEXT_DET_LIMIT_SIDE_LEN
            if OCR_TEXT_RECOGNITION_BATCH_SIZE > 0:
                if is_paddle3:
                    kwargs["text_recognition_batch_size"] = OCR_TEXT_RECOGNITION_BATCH_SIZE
                else:
                    kwargs["rec_batch_num"] = OCR_TEXT_RECOGNITION_BATCH_SIZE

            if OCR_VERSION:
                kwargs["ocr_version"] = OCR_VERSION

            # OCR_CUSTOM_DET / OCR_CUSTOM_REC can be set independently — e.g. a
            # fine-tuned recognition model paired with the stock detector.
            # `lang` still applies as the fallback for whichever side isn't
            # overridden (PaddleOCR lets an explicit *_model_dir win over it).
            kwargs["lang"] = "en"
            if OCR_CUSTOM_DET:
                kwargs["det_model_dir"] = OCR_CUSTOM_DET
            if OCR_CUSTOM_REC:
                kwargs["rec_model_dir"] = OCR_CUSTOM_REC
            if OCR_CUSTOM_DET or OCR_CUSTOM_REC:
                print(f"[ocr-server] Using custom models: det={OCR_CUSTOM_DET or '(stock)'}, rec={OCR_CUSTOM_REC or '(stock)'}")

            if not (OCR_CUSTOM_DET and OCR_CUSTOM_REC):
                if fast_mode:
                    _apply_fast_profile(kwargs, is_paddle3)
                    print(f"[ocr-server] Fast mode enabled (device={device}, det={OCR_FAST_DET_LIMIT_SIDE_LEN}, rec_batch={OCR_FAST_RECOGNITION_BATCH_SIZE})")
                elif is_paddle3:
                    if OCR_DET_MODEL: kwargs["text_detection_model_name"] = OCR_DET_MODEL
                    if OCR_REC_MODEL: kwargs["text_recognition_model_name"] = OCR_REC_MODEL

            print(f"[ocr-server] Initializing PaddleOCR with kwargs: {kwargs}")
            _engine = PaddleOCR(**kwargs)
            _warmup_engine(_engine, device)
            print("[ocr-server] ✅ PaddleOCR engine ready!")
            return _engine

        except Exception as e:
            print(f"[ocr-server] Critical error initializing engine: {e}")
            traceback.print_exc()
            raise RuntimeError(f"Cannot initialize PaddleOCR: {e}")

def _result_dict(res):
    if isinstance(res, dict): return res
    for attr in ("json", "res"):
        d = getattr(res, attr, None)
        if isinstance(d, dict): return d
    try: return dict(res)
    except: return {}

def _to_box(poly):
    try:
        pts = poly.tolist() if hasattr(poly, "tolist") else list(poly)
        return [[float(p[0]), float(p[1])] for p in pts]
    except: return []

def _to_score(v, default=1.0):
    try: return float(v)
    except: return float(default)

def _append_from_predict_page(page, lines):
    d = _result_dict(page)
    texts = d.get("rec_texts") or []
    scores = d.get("rec_scores") or []
    polys = d.get("rec_polys") or d.get("dt_polys") or []
    if not (isinstance(texts, list) and isinstance(polys, list) and texts and polys):
        return False

    n = min(len(texts), len(polys))
    for i in range(n):
        text = str(texts[i] or "").strip()
        if not text:
            continue
        score = _to_score(scores[i], 1.0) if i < len(scores) else 1.0
        lines.append({"text": text, "confidence": score, "box": _to_box(polys[i])})
    return True

def _append_from_legacy_page(page, lines):
    if not isinstance(page, list):
        return
    for item in page:
        if not (isinstance(item, (list, tuple)) and len(item) >= 2):
            continue
        box, rec = item[0], item[1]
        if isinstance(rec, (tuple, list)) and len(rec) >= 2:
            text, score = str(rec[0]), _to_score(rec[1], 1.0)
        else:
            text, score = str(rec), 1.0
        text = text.strip()
        if not text:
            continue
        lines.append({"text": text, "confidence": score, "box": _to_box(box)})

def run_ocr(path):
    engine = get_engine()
    width = height = None
    temp_path = None
    try:
        from PIL import Image
        with Image.open(path) as im:
            width, height = im.size
            ext = os.path.splitext(path)[1].lower()
            needs_convert = ext in {'.jfif', '.webp', '.bmp', '.tiff', '.tif'}
            if needs_convert:
                im = im.convert('RGB')
                fd, temp_path = tempfile.mkstemp(suffix='.png')
                os.close(fd)
                im.save(temp_path, 'PNG')
                path = temp_path
    except Exception as e:
        print(f"[ocr-server] Image prepare failed: {e}")

    lines = []
    timing = {"queueMs": 0, "inferMs": 0}
    try:
        t_wait = time.time()
        if not _predict_lock.acquire(blocking=False):
            _stat_add(waiting=1)
            _predict_lock.acquire()
            _stat_add(waiting=-1)
        timing["queueMs"] = int((time.time() - t_wait) * 1000)
        t_infer = time.time()
        try:
            if hasattr(engine, "predict"):
                # PaddleOCR 3.x khuyến nghị dùng predict() thay cho ocr().
                results = engine.predict(path)
                for page in results or []:
                    if _append_from_predict_page(page, lines):
                        continue
                    _append_from_legacy_page(page, lines)
            else:
                # PaddleOCR 2.x: dùng ocr() và parse kết quả legacy.
                results = engine.ocr(path, cls=False)
                for page in results or []:
                    _append_from_legacy_page(page, lines)
        finally:
            _predict_lock.release()
            timing["inferMs"] = int((time.time() - t_infer) * 1000)
    except NotImplementedError as e:
        msg = str(e)
        if "ConvertPirAttribute2RuntimeAttribute" in msg:
            raise RuntimeError(
                "Paddle oneDNN/MKLDNN runtime error on CPU. "
                "Try: 1) Install paddlepaddle-gpu for CUDA support, or "
                "2) Set FLAGS_use_mkldnn=0 (already set, may need reinstall). "
                "GPU install: pip install paddlepaddle-gpu==3.0.0b1 "
                "-i https://www.paddlepaddle.org.cn/packages/stable/cu123/"
            )
        raise
    finally:
        if temp_path and os.path.exists(temp_path):
            try: os.remove(temp_path)
            except: pass
    return lines, width, height, timing

class Handler(BaseHTTPRequestHandler):
    server_version = "PaddleOCRServer/1.0"
    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path.rstrip("/") == "/stats":
            with _stats_lock:
                self._send(200, {"ok": True, **_stats})
            return
        if self.path.rstrip("/") in ("/health", ""):
            import paddle
            gpu_ok = paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0
            self._send(200, {
                "ok": True,
                "device": "gpu" if gpu_ok else "cpu",
                "paddle_version": paddle.__version__,
                "cuda_compiled": paddle.device.is_compiled_with_cuda(),
                "workers": 1,
                "worker_index": os.environ.get("OCR_WORKER_INDEX", "0"),
                "inflight": _stats["inflight"],
                "waiting": _stats["waiting"],
                "maxQueue": OCR_MAX_QUEUE,
            })
        else:
            self._send(404, {"ok": False, "error": "Not found"})
    def do_POST(self):
        if self.path.rstrip("/") == "/stats/reset":
            with _stats_lock:
                for k in _stats:
                    if k not in ("inflight", "waiting"):
                        _stats[k] = 0
                _stats["maxWaiting"] = _stats["waiting"]
            self._send(200, {"ok": True})
            return
        if self.path.rstrip("/") != "/ocr":
            self._send(404, {"ok": False, "error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            self._send(400, {"ok": False, "error": f"Invalid JSON body: {e}"})
            return
        img_path = req.get("path")
        if not img_path:
            self._send(400, {"ok": False, "error": "Missing 'path' in request body"})
            return
        img_path = os.path.abspath(img_path)
        if not os.path.isfile(img_path):
            self._send(404, {"ok": False, "error": f"File not found: {img_path}"})
            return
        t0 = time.time()
        with _stats_lock:
            busy = OCR_MAX_QUEUE and _stats["inflight"] >= 1 + OCR_MAX_QUEUE
            if busy:
                _stats["rejectedBusy"] += 1
            else:
                _stats["inflight"] += 1
            inflight_now = _stats["inflight"]
        if busy:
            print(f"[ocr-server] busy: rejected {os.path.basename(img_path)} ({inflight_now} in flight, max queue {OCR_MAX_QUEUE})")
            self._send(503, {"ok": False, "busy": True, "inflight": inflight_now, "maxQueue": OCR_MAX_QUEUE,
                             "error": f"OCR server busy ({inflight_now} requests in flight)"})
            return
        try:
            lines, width, height, timing = run_ocr(img_path)
            elapsed = int((time.time() - t0) * 1000)
            with _stats_lock:
                _stats["served"] += 1
                _stats["queueMsTotal"] += timing["queueMs"]
                _stats["inferMsTotal"] += timing["inferMs"]
                _stats["maxQueueMs"] = max(_stats["maxQueueMs"], timing["queueMs"])
                waiting_now = _stats["waiting"]
            print(f"[ocr-server] {os.path.basename(img_path)} -> {len(lines)} lines in {elapsed}ms "
                  f"(queue {timing['queueMs']}ms, infer {timing['inferMs']}ms, still waiting {waiting_now})")
            self._send(200, {"ok": True, "path": img_path, "width": width, "height": height, "lineCount": len(lines),
                             "elapsedMs": elapsed, "queueMs": timing["queueMs"], "inferMs": timing["inferMs"], "lines": lines})
        except Exception as e:
            _stat_add(failed=1)
            traceback.print_exc()
            self._send(500, {"ok": False, "error": str(e)})
        finally:
            _stat_add(inflight=-1)
    def log_message(self, fmt, *args): pass


def main():
    print("=" * 60)
    print("PaddleOCR micro-service (GPU-aware)")
    print(f"  Listen  : http://{HOST}:{PORT}")
    print(f"  Workers : {OCR_WORKERS}")
    print(f"  Max queue: {OCR_MAX_QUEUE or 'unlimited'} (OCR_MAX_QUEUE)")
    print("=" * 60)

    label = "[ocr-server]"
    try:
        get_engine()
    except Exception as e:
        print(f"{label} Fatal Error: {e}")
        sys.exit(1)

    # Default listen backlog is 5: on Windows a burst of >5 simultaneous
    # connections gets ECONNREFUSED. Accepted requests just queue on _predict_lock.
    ThreadingHTTPServer.request_queue_size = 64
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"{label} Stability mode enabled (single worker).")
    print(f"{label} Ready → http://{HOST}:{PORT}. Node.js: OCR_SERVER_URL=http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n{label} Shutting down.")


if __name__ == "__main__":
    main()
