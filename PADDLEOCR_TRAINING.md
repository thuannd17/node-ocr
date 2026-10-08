# PaddleOCR Roster Extraction - Hướng dẫn Training & Cải thiện Accuracy

Pipeline trích xuất dữ liệu bảng roster từ ảnh, hoạt động 100% offline.

---

## 1. Kiến trúc hệ thống

```
┌──────────────┐     HTTP      ┌──────────────────┐
│  Node.js     │ ──────────→   │  Python OCR      │
│  Express     │   :8501/ocr   │  Micro-service   │
│  Server      │ ←──────────   │  (PaddleOCR)     │
└──────┬───────┘   raw lines   └──────────────────┘
       │
       ▼
┌──────────────────┐
│  Roster Parser   │  ← Learned patterns (parser-patterns.json)
│  (self-learning) │  → { published: [...], planned: [...] }
└──────────────────┘
       ↑
┌──────────────────┐
│  Parser Learner  │  ← Labels (ground truth)
│  (calibration)   │  → parser-patterns.json
└──────────────────┘
```

**Luồng xử lý:**
1. Upload ảnh → Node.js Express server
2. Node.js gửi ảnh sang Python OCR server (PaddleOCR det + rec)
3. Python trả về danh sách lines: `{text, confidence, box}`
4. Node.js parser phân tích bảng → structured data `{published, planned}`

**Components:**
| Component | File | Vai trò |
|-----------|------|---------|
| Express app | `index.js` | Entry point, mount routes |
| API routes | `routes/api.js` | Upload, labels, benchmark |
| Upload UI | `views/upload.html` | Giao diện upload & kết quả |
| PaddleOCR client | `services/paddle-ocr.js` | Gọi OCR server, trả kết quả |
| Strategy router | `services/parsers.js` | Chọn strategy (paddleocr/vlm) |
| **Table parser** | `services/roster-parser.js` | **Parse OCR lines → bảng roster** |
| **Parser learner** | `services/parser-learner.js` | **Học patterns từ labeled data** |
| OCR server | `scripts/ocr_server.py` | Python PaddleOCR micro-service |
| Auto-labeler | `scripts/auto-label.mjs` | VLM tự động label ảnh mới |
| Calibration | `scripts/calibrate.mjs` | Calibrate parser từ labels |

---

## 2. Chạy hệ thống

### 2.1 Khởi động

```bash
# Terminal 1: Start OCR server (chạy TRƯỚC)
npm run ocr-server
# hoặc: python scripts/ocr_server.py

# Terminal 2: Start Node.js app
npm start
```

### 2.1.1 Preset GPU nhanh hơn

Nếu bạn muốn ưu tiên tốc độ OCR trên GPU, dùng preset sau:

```bash
npm run ocr-server:fast-gpu
```

Preset này bật `OCR_FAST_MODE=1`, giảm detector side length xuống `640`, và tăng recognition batch lên `16`.

**Tùy chọn Node-side resize:**

```bash
# Resize nhỏ hơn để OCR nhanh hơn trên GPU
set OCR_FAST_MODE=1
set OCR_FAST_OCR_MAX_WIDTH=1600
```

Tradeoff: ảnh quá nhỏ có thể làm mất text mảnh hoặc ký tự nhỏ ở roster dày.

### 2.2 Sử dụng

1. Mở `http://localhost:3000/upload`
2. Chọn strategy **PaddleOCR (offline)**
3. Upload ảnh roster → xem kết quả

### 2.3 Benchmark

```bash
# Full benchmark (tất cả ảnh trong fake-data/)
npm run bench:full

# Quick benchmark (15 ảnh đầu)
npm run bench:quick

# Debug chi tiết 1 ảnh
npm run debug:detail
```

---

## 3. Chuẩn bị dữ liệu training cho roster mới

### 3.1 Thu thập ảnh mẫu

Chụp/lưu ảnh roster vào thư mục `fake-data/`:
- Hỗ trợ: `.jpg`, `.jpeg`, `.png`, `.bmp`, `.jfif`
- Nên có **ít nhất 30-50 ảnh** đa dạng (khác ngày, khác crew, khác format)
- Độ phân giải tối thiểu: 700x900 pixels

### 3.2 Label dữ liệu

Mở `http://localhost:3000/label` để label từng ảnh.

**Format label JSON:**
```json
{
  "published": [
    {
      "date": "17 Apr 20",
      "day": "FRI",
      "duty": "C19",
      "dep": "BRU",
      "begin": "00:00 Z",
      "end": "23:59 Z",
      "arr": ""
    }
  ],
  "planned": [
    {
      "date": "27 Apr 20",
      "day": "MON",
      "duty": "OFF(Z)",
      "dep": "BRU",
      "begin": "00:00 Z",
      "end": "21:00 Z",
      "arr": ""
    }
  ]
}
```

**Các trường:**
| Field | Mô tả | Ví dụ |
|-------|--------|-------|
| `date` | Ngày (DD Mon YY) | `17 Apr 20` |
| `day` | Thứ trong tuần (3 ký tự) | `FRI`, `MON` |
| `duty` | Loại nhiệm vụ | `C19`, `OFF(Z)`, `SBY1030-Z`, `FR 8075` |
| `dep` | Sân bay khởi hành | `BRU`, `STN` |
| `begin` | Giờ bắt đầu | `00:00 Z` |
| `end` | Giờ kết thúc | `23:59 Z` |
| `arr` | Sân bay đến | `STN` (có thể rỗng) |

**Label files** được lưu vào `labels/<tên_ảnh>.json`

### 3.3 Validate dataset

```bash
# Kiểm tra tất cả label files hợp lệ
python scripts/train_paddleocr.py --mode validate
```

---

## 4. Training custom model

### 4.1 Cài Python dependencies

```bash
# Cài từ requirements.txt
pip install -r scripts/requirements.txt

# Hoặc cài thủ công
pip install paddleocr paddlepaddle paddle2onnx
```

**Yêu cầu:**
- Python 3.8+
- RAM: 4GB+
- Disk: 2GB (model cache)
- GPU: Không bắt buộc (chạy được trên CPU)

### 4.2 Cấu hình training

Chỉnh sửa trong `scripts/train_paddleocr.py` hoặc `models/paddleocr-roster/train_config.json`:

```json
{
  "backend_freeze": true,
  "exterior_freeze": true,
  "epochs": 10,
  "batch_size": 2,
  "learning_rate": 0.0001,
  "optimizer": "adam",
  "save_dir": "models/paddleocr-roster"
}
```

| Tham số | Mô tả | Khuyến nghị |
|----------|-------|-------------|
| `backend_freeze` | Freeze OCR backbone | `true` (giữ OCR accuracy gốc) |
| `exterior_freeze` | Freeze layout detection | `true` nếu roster giống format cũ |
| `epochs` | Số vòng lặp training | 10-50 (tùy dataset size) |
| `batch_size` | Số ảnh mỗi batch | 2-4 (tùy RAM) |
| `learning_rate` | Tốc độ học | 0.0001-0.001 |

### 4.3 Chạy training

```bash
python scripts/train_paddleocr.py --mode train
```

### 4.4 Export model

```bash
python scripts/export_onnx.py
```

Model sẽ được lưu vào:
```
models/paddleocr-roster/
├── model.onnx          # Recognition model (ONNX)
├── model_det.onnx      # Detection model (ONNX)
├── ppocr/              # Paddle inference format
│   ├── inference.pdiparams
│   └── inference.json
├── train_config.json
└── export_metadata.json
```

### 4.5 Sử dụng custom model

Custom model hiện ở dạng ONNX. Để dùng với OCR server, cần file `.pdmodel` (Paddle inference format).

**Option 1: Giữ dùng model mặc định (khuyến nghị)**

Mặc định OCR server dùng PaddleOCR PP-OCRv5/v6 (mới hơn, chính xác hơn custom model PP-OCRv3). Chỉ cần cải thiện parser.

**Option 2: Dùng custom model**

Cần có file `.pdmodel` trong `models/paddleocr-roster/ppocr/`. Sau đó set env:
```bash
OCR_CUSTOM_DET=models/paddleocr-roster/ppocr
OCR_CUSTOM_REC=models/paddleocr-roster/ppocr
npm run ocr-server
```

---

## 5. Cải thiện độ chính xác

Độ chính xác phụ thuộc vào **2 tầng**: OCR (đọc text) và Parser (phân tích bảng).

### 5.1 Phân tích lỗi

```bash
# Chạy benchmark để xem ảnh nào kém
npm run bench:full

# Debug chi tiết 1 ảnh
npm run debug:detail

# Xem raw OCR output
npm run debug:raw
```

### 5.2 Lỗi tầng OCR (đọc sai text)

**Dấu hiệu:** OCR đọc sai ký tự (VD: `BRD` thay vì `BRU`, `Mav` thay vì `May`)

**Giải pháp:**
1. **Thêm data training** - Label thêm ảnh có ký tự bị đọc sai
2. **Cải thiện chất lượng ảnh** - Ảnh rõ nét, độ phân giải cao
3. **Convert format** - Ảnh `.jfif` được tự động convert sang `.jpg`
4. **Training lại** - Chạy training với dataset mở rộng

### 5.3 Lỗi tầng Parser (phân tích sai bảng)

**Dấu hiệu:** OCR đọc đúng text nhưng parser gán sai cột/dòng

**Các lỗi thường gặp và cách fix:**

| Lỗi | Nguyên nhân | Fix trong `services/roster-parser.js` |
|-----|-------------|---------------------------------------|
| Sai cột duty | Fragment nằm ở vùng date nhưng chứa cả duty | Điều chỉnh `dutyLeft` threshold |
| Thiếu dòng | Date line bị gộp vào header | Điều chỉnh pre-extraction logic |
| Sai ngày | Không tìm thấy date gần nhất | Cải thiện `findClosestDate` |
| Duty rỗng | Combined date+duty line không được capture | Kiểm tra overlap-based zone check |

**Parser architecture:**
```
Raw OCR lines
    ↓
1. Sắp xếp theo y-coordinate
    ↓
2. Group thành rows (cùng y ± threshold)
    ↓
3. Tính column zones từ header
    ↓
4. Pre-extract date lines (trước khi group)
    ↓
5. Parse từng row:
   - Date: extract từ text hoặc closest-date lookup
   - Day: từ date hoặc carry-forward
   - Duty: fragments trong duty zone
   - Dep/Begin/End/Arr: theo column x-ranges
    ↓
6. Normalize duty codes (OFF(Z), C19, etc.)
    ↓
Output: { published: [...], planned: [...] }
```

### 5.4 Self-Learning Workflow (Khuyến nghị)

Parser có khả năng **tự học** từ labeled data. Khi thêm roster mới, chỉ cần:

```
Bước 1: Thêm ảnh mới
    ↓  (copy ảnh vào fake-data/)
Bước 2: Auto-label bằng VLM
    ↓  (npm run auto-label)
Bước 3: Review labels (tùy chọn)
    ↓  (http://localhost:3000/label)
Bước 4: Calibrate parser
    ↓  (npm run calibrate)
Bước 5: Parser tự động dùng patterns mới
```

**Chi tiết từng bước:**

```bash
# 1. Copy ảnh roster mới vào fake-data/
cp new_roster.jpg fake-data/

# 2. VLM tự động label ảnh chưa có label
npm run auto-label
# Hoặc đánh dấu cần review:
npm run auto-label -- --review

# 3. (Tùy chọn) Review & sửa labels tại http://localhost:3000/label

# 4. Calibrate parser - parser tự học column zones, duty patterns, etc.
npm run calibrate

# 5. Kiểm tra accuracy
npm run bench:quick
```

**Parser sẽ tự động học:**
- Column positions (duty, dep, begin, end, arr) từ header detection
- Section boundaries (published vs planned markers)
- Duty code patterns và normalizations
- Layout clusters cho multi-format support

**Auto-calibration:** Khi upload ảnh qua web UI, parser tự động kiểm tra và calibrate nếu labels mới hơn patterns cũ.

**Lưu ý quan trọng:**
- VLM labels có thể sai ~5-10%. Nên review trước khi calibrate.
- Càng nhiều labeled data → parser càng chính xác.
- Calibration cần OCR server đang chạy (`npm run ocr-server`).

### 5.5 Các bước cải thiện ưu tiên

1. **Label thêm data** (30-100 ảnh) → tăng coverage
2. **Chạy benchmark** → xác định ảnh kém nhất
3. **Debug từng ảnh** → phân loại lỗi (OCR vs Parser)
4. **Fix parser** cho các lỗi phổ biến (column zones, date parsing)
5. **Training custom model** nếu lỗi OCR quá nhiều

---

## 6. Các dạng Duty Code

Parser hỗ trợ các dạng duty code thường gặp trong roster:

| Pattern | Ví dụ | Mô tả |
|---------|-------|-------|
| Flight | `FR 8075`, `DH 4522` | Chuyến bay |
| Duty code | `C19`, `C24` | Duty type + số |
| OFF | `OFF(Z)`, `OFF()` | Ngày nghỉ |
| Standby | `SBY1030-Z`, `SBY 0800` | Standby |
| Training | `SIM`, `TSIM`, `6TRG` | Đào tạo |
| Airport | `A/L(T)`, `F/D` | Airport/Flight duty |
| Rest | `RST`, `RST2` | Rest day |
| Number only | `8172` | Flight number shorthand |

---

## 7. Scripts hữu ích

| Script | Mô tả | Cách chạy |
|--------|-------|-----------|
| `npm run ocr-server` | Start Python OCR server | Terminal riêng |
| `npm start` | Start Node.js app | Terminal riêng |
| `npm run auto-label` | VLM tự động label ảnh chưa có label | Cần VLM_API_KEY |
| `npm run calibrate` | Calibrate parser từ labeled data | Cần OCR server |
| `npm run ocr-server:fast-gpu` | OCR server GPU nhanh | Khuyến nghị cho production |
| `npm run label` | Mở label tool | Browser: `http://localhost:3000/label` |

---

## 8. Environment Variables

```bash
# .env file
HOST=localhost
PORT=3000
STRATEGY=paddleocr          # paddleocr | vlm

# OCR Server (optional)
OCR_SERVER_URL=http://127.0.0.1:8501
OCR_TIMEOUT_MS=180000

# Custom model (optional - nếu có .pdmodel files)
OCR_CUSTOM_DET=
OCR_CUSTOM_REC=

# OCR speed tuning (optional)
OCR_FAST_MODE=false              # true => dùng PP-OCRv5 mobile (nhanh hơn)
OCR_TEXT_DET_LIMIT_SIDE_LEN=0    # ví dụ 960 hoặc 736 để tăng tốc detect
OCR_TEXT_RECOGNITION_BATCH_SIZE=0

# VLM (chỉ dùng khi STRATEGY=vlm)
VLM_PROVIDER=gemini
VLM_API_KEY=
VLM_MODEL=gemini-3.5-flash
```

---

## 9. Troubleshooting

### OCR Server không kết nối được
```bash
# Kiểm tra server đang chạy
curl http://127.0.0.1:8501/health

# Nếu không chạy, start lại
npm run ocr-server
```

### OCR server crash trên Windows (exit code -1073741819)

Nếu Python process bị văng ngay khi khởi tạo `PaddleOCR(...)`, thường là lỗi native runtime (DLL/CUDA wheel mismatch).

```bash
# 1) Chạy health check để xem nhanh tình trạng môi trường
npm run ocr:check

# 2) Tạo môi trường sạch và cài bản stable (khuyến nghị)
python -m venv .venv
.\.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r scripts/requirements.txt

# 3) Chạy lại health check và OCR server
.\.venv\Scripts\python scripts/ocr_healthcheck.py
.\.venv\Scripts\python scripts/ocr_server.py
```

**Lưu ý:** Tránh dùng `paddlepaddle-gpu` bản beta trên Windows nếu không bắt buộc.

### Upload ảnh không trả về data
- Kiểm tra OCR server đang chạy
- Đảm bảo chọn strategy **PaddleOCR** trong dropdown
- Kiểm tra log terminal Node.js để xem lỗi cụ thể
- File `.jfif` được tự động convert sang `.jpg`

### Ảnh jfif trả về 0 lines
- Đã có auto-convert jfif → jpg (cả Node.js upload và benchmark)
- Nếu vẫn lỗi, restart OCR server: `npm run ocr-server`

### Benchmark chạy chậm
- Mỗi ảnh mất ~60 giây (PaddleOCR PP-OCRv6_medium trên CPU)
- 67 ảnh ≈ 60-70 phút
- Dùng `npm run bench:quick` để test nhanh (15 ảnh)

### Parser cho kết quả sai
```bash
# Debug chi tiết
npm run debug:detail    # So sánh expected vs predicted
npm run debug:raw       # Xem raw OCR output
```

---

## 10. So sánh Strategies

| | PaddleOCR (offline) | VLM (Gemini) |
|---|---|---|
| **Accuracy** | ~30% (parser-limited) | ~66% (baseline) |
| **Cost** | Free | Free tier / trả phí |
| **Speed** | ~60s/image (CPU) | 1-2s/image |
| **Offline** | ✅ | ❌ Cần internet |
| **Rate limit** | Unlimited | 1500 req/day |
| **Setup** | Cần OCR server | Cần API key |

**Lưu ý:** Accuracy PaddleOCR thấp chủ yếu do parser chưa tối ưu, không phải do OCR đọc sai. Việc cải thiện parser sẽ tăng accuracy đáng kể mà không cần train model mới.

---

**Last Update:** 2026-08-20
