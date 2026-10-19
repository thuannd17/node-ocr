#!/usr/bin/env python3
"""
Quick health check for PaddleOCR runtime on Windows.

- Detects suspicious broken site-packages leftovers (~addle...)
- Reports installed Paddle/PaddleOCR versions
- Runs lightweight import checks
- Spawns a child process to initialize PaddleOCR safely and capture native crash codes
"""

import importlib.metadata as md
import inspect
import os
import platform
import subprocess
import sys
from pathlib import Path


def add_windows_cuda_dll_paths():
    if os.name != "nt":
        return
    base = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if not base.is_dir():
        return
    for bin_dir in base.rglob("bin"):
        try:
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(bin_dir))
        except Exception:
            pass
        dll_dir = str(bin_dir)
        if dll_dir not in os.environ.get("PATH", ""):
            os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")


add_windows_cuda_dll_paths()


def get_version(pkg_name):
    try:
        return md.version(pkg_name)
    except md.PackageNotFoundError:
        return None


def find_suspicious_sitepackages_dirs():
    suspicious = []
    for p in sys.path:
        if not p or "site-packages" not in p.lower():
            continue
        sp = Path(p)
        if not sp.exists() or not sp.is_dir():
            continue
        for child in sp.iterdir():
            name = child.name.lower()
            if name.startswith("~addle") or name.startswith("~-ddle"):
                suspicious.append(str(child))
    return suspicious


def child_init():
    from paddleocr import PaddleOCR

    init_params = set(inspect.signature(PaddleOCR.__init__).parameters)
    is_paddle3 = "device" in init_params
    kwargs = {
        "lang": "en",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    ocr_device = os.environ.get("OCR_DEVICE", "").strip()
    if ocr_device:
        if is_paddle3:
            kwargs["device"] = ocr_device
        else:
            kwargs["use_gpu"] = ocr_device.lower() == "gpu"
            kwargs["use_angle_cls"] = False
            kwargs["show_log"] = False
    elif not is_paddle3:
        kwargs["use_gpu"] = False
        kwargs["use_angle_cls"] = False
        kwargs["show_log"] = False

    print("[child] Initializing PaddleOCR with:", kwargs)
    _ = PaddleOCR(**kwargs)
    print("[child] PaddleOCR init OK")


def main():
    if "--child-init" in sys.argv:
        child_init()
        return 0

    print("=" * 70)
    print("PaddleOCR Health Check")
    print("=" * 70)
    print(f"Python   : {sys.version.split()[0]} ({sys.executable})")
    print(f"Platform : {platform.platform()}")

    paddle_gpu_ver = get_version("paddlepaddle-gpu")
    paddle_cpu_ver = get_version("paddlepaddle")
    paddleocr_ver = get_version("paddleocr")

    print(f"paddlepaddle-gpu : {paddle_gpu_ver or 'not installed'}")
    print(f"paddlepaddle     : {paddle_cpu_ver or 'not installed'}")
    print(f"paddleocr        : {paddleocr_ver or 'not installed'}")

    suspicious = find_suspicious_sitepackages_dirs()
    if suspicious:
        print("\n[warn] Suspicious broken package folders found:")
        for d in suspicious:
            print(f"  - {d}")

    # Import/runtime check first.
    try:
        import paddle

        print(f"\npaddle.__version__ = {paddle.__version__}")
        print(f"compiled_with_cuda = {paddle.device.is_compiled_with_cuda()}")
    except Exception as exc:
        print(f"\n[fail] Cannot import paddle: {exc}")
        return 1

    try:
        import paddleocr

        print(f"paddleocr.__version__ = {paddleocr.__version__}")
    except Exception as exc:
        print(f"[fail] Cannot import paddleocr: {exc}")
        return 1

    if paddle_gpu_ver and "b" in paddle_gpu_ver:
        print("\n[warn] You are using a beta GPU wheel. This is a common cause of native crashes on Windows.")

    # Isolate native crash in child process so this script can print actionable output.
    cmd = [sys.executable, "-u", __file__, "--child-init"]
    print("\nRunning PaddleOCR initialization probe in a child process...")
    proc = subprocess.run(cmd, capture_output=True, text=True)

    if proc.stdout:
        print(proc.stdout.rstrip())
    if proc.stderr:
        print(proc.stderr.rstrip())

    if proc.returncode == 0:
        print("\n[ok] PaddleOCR initialization succeeded.")
        return 0

    print(f"\n[fail] PaddleOCR initialization failed with return code: {proc.returncode}")
    if proc.returncode == -1073741819:
        print("[hint] 0xC0000005 (Access Violation): native binary/runtime incompatibility is likely.")
        print("[hint] Recommended: use clean venv + stable CPU stack from scripts/requirements.txt.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

