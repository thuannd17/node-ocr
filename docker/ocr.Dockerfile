# PaddleOCR server (src/scripts/ocr_server.py), for the app image to call at http://ocr:8501.
#
#   CPU: docker build -f docker/ocr.Dockerfile -t roster-ocr-ocr .
#   GPU: docker build -f docker/ocr.Dockerfile -t roster-ocr-ocr-gpu \
#          --build-arg PADDLE=paddlepaddle-gpu==3.0.0 \
#          --build-arg PADDLE_INDEX=https://www.paddlepaddle.org.cn/packages/stable/cu118/ \
#          --build-arg OCR_DEVICE=gpu .
#        (docker-compose.gpu.yml does this; run it with --gpus / the compose GPU reservation)
#
# No model in the image: at start the server downloads the recognition model in use from MinIO
# (models/rec/active.json, src/scripts/rec_model.py; MINIO_* from docker-compose.yml) into /work. The stock text
# detector is downloaded by PaddleOCR on first start (kept in the /home/ocr/.paddleocr volume).
# Paddle 3.0.0 on both: the Linux CPU wheel of 2.6.2 crashes on CPUs without AVX-512 (AMD Ryzen); the
# GPU wheel for CUDA 11.8 brings its CUDA / cuDNN libraries as pip packages, so no CUDA base image is needed
# (the NVIDIA container toolkit provides the driver).

FROM python:3.11.10-slim-bookworm

ARG PADDLE=paddlepaddle==3.0.0
ARG PADDLE_INDEX=
ARG OCR_DEVICE=cpu

# OpenCV (pulled in by PaddleOCR) needs these
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN if [ -n "$PADDLE_INDEX" ]; then \
      pip install --no-cache-dir "$PADDLE" --index-url "$PADDLE_INDEX" --extra-index-url https://pypi.org/simple; \
    else \
      pip install --no-cache-dir "$PADDLE"; \
    fi
COPY docker/requirements-ocr.txt docker/requirements-ocr.txt
RUN pip install --no-cache-dir -r docker/requirements-ocr.txt

# Paddle 3 turns oneDNN on for CPU inference by default, and PaddleOCR 2.9 does not expect it: from the
# 2nd or 3rd image on, requests fail with "could not execute a primitive" (tried: oneDNN with a shape
# cache of 10, and unlimited; both fail). Turn it off unless PaddleOCR is asked for it (enable_mkldnn).
# (CPU branch only: no effect on the GPU image.)
RUN U=/usr/local/lib/python3.11/site-packages/paddleocr/tools/infer/utility.py \
 && sed -i 's/^            config.disable_gpu()$/            config.disable_gpu()\n            if not args.enable_mkldnn:\n                config.disable_mkldnn()/' "$U" \
 && grep -q "config.disable_mkldnn()" "$U"

COPY src/scripts/ocr_server.py src/scripts/rec_model.py src/scripts/ocr_healthcheck.py src/scripts/
COPY models/dict models/dict

# The app sends file PATHS (not bytes) to /ocr, so both containers mount the work folder (/work: uploads,
# media mirror; the OCR models are downloaded there too) at the same path. uid 1000 here = "node" in the app image.
RUN useradd --create-home --uid 1000 ocr \
 && mkdir -p /work /home/ocr/.paddleocr \
 && chown ocr:ocr /work /home/ocr/.paddleocr
USER ocr

ENV OCR_SERVER_HOST=0.0.0.0 \
    OCR_SERVER_PORT=8501 \
    OCR_DEVICE=${OCR_DEVICE} \
    ROSTER_WORK_DIR=/work \
    OCR_TEXT_DET_LIMIT_SIDE_LEN=1920 \
    PYTHONUNBUFFERED=1

EXPOSE 8501
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8501/health', timeout=4).status == 200 else 1)"

CMD ["python", "-u", "src/scripts/ocr_server.py"]
