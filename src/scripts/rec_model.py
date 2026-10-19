"""
Where the OCR server gets its text-recognition model from (scripts/ocr_server.py).

The versions live in MinIO (services/rec-models.js on the Node side):
    models/rec/<vN|stock>/infer/...    what PaddleOCR loads
    models/rec/active.json             {"id": "v5"}: the one in use (/models, npm run ocr:use-model)
PaddleOCR only loads a model from a folder, so the version is downloaded into
<ROSTER_WORK_DIR>/models/rec/<ver>/infer (only the files that changed) and loaded from there.

    OCR_CUSTOM_REC=<folder>    load that folder as it is (training runs, tests); MinIO is not asked
    OCR_REC_VERSION=v4         this version instead of active.json
MinIO settings: MINIO_ENDPOINT, MINIO_PORT, MINIO_USE_SSL, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET
(MEDIA_BACKEND=fs + MEDIA_FS_DIR: a folder with the same layout instead of MinIO).
When MinIO cannot be reached, the copy downloaded last time is used.
"""
import hashlib
import json
import os
import shutil
import tempfile

PREFIX = 'models/rec/'


def work_dir():
    return os.environ.get('ROSTER_WORK_DIR') or os.path.join(tempfile.gettempdir(), 'roster-ocr-work')


def _md5(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


class _MinioSource:
    def __init__(self):
        from minio import Minio  # only needed when the model comes from MinIO
        endpoint = os.environ.get('MINIO_ENDPOINT', 'localhost')
        port = os.environ.get('MINIO_PORT', '9000')
        self.bucket = os.environ.get('MINIO_BUCKET', 'roster-ocr')
        self.where = f'MinIO {endpoint}:{port}/{self.bucket}'
        self.client = Minio(f'{endpoint}:{port}', access_key=os.environ.get('MINIO_ACCESS_KEY', ''),
                            secret_key=os.environ.get('MINIO_SECRET_KEY', ''),
                            secure=os.environ.get('MINIO_USE_SSL', '').lower() in ('1', 'true'))

    def read(self, key):
        r = self.client.get_object(self.bucket, key)
        try:
            return r.read()
        finally:
            r.close()
            r.release_conn()

    def list(self, prefix):
        """[(key, size, etag)]"""
        return [(o.object_name, o.size, (o.etag or '').strip('"'))
                for o in self.client.list_objects(self.bucket, prefix=prefix, recursive=True)]

    def download(self, key, target):
        self.client.fget_object(self.bucket, key, target)


class _FolderSource:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.where = f'folder {self.root}'

    def _path(self, key):
        return os.path.join(self.root, *key.split('/'))

    def read(self, key):
        with open(self._path(key), 'rb') as f:
            return f.read()

    def list(self, prefix):
        base = self._path(prefix)
        out = []
        for d, _, files in os.walk(base):
            for n in files:
                p = os.path.join(d, n)
                out.append((prefix + os.path.relpath(p, base).replace(os.sep, '/'), os.path.getsize(p), _md5(p)))
        return out

    def download(self, key, target):
        shutil.copyfile(self._path(key), target)


def _source():
    if os.environ.get('MEDIA_BACKEND', '').lower() == 'fs':
        return _FolderSource(os.environ.get('MEDIA_FS_DIR') or 'media-data')
    return _MinioSource()


def resolve_rec_model(log=print):
    """-> (folder for PaddleOCR's rec_model_dir, name for /health), or (None, 'stock (PaddleOCR)') when there is none."""
    custom = os.environ.get('OCR_CUSTOM_REC', '').strip()
    if custom:
        return custom, custom
    root = os.path.join(work_dir(), 'models', 'rec')
    last_file = os.path.join(root, '.last-loaded.json')  # what was loaded last time: used when MinIO is down
    pinned = os.environ.get('OCR_REC_VERSION', '').strip()
    try:
        src = _source()
        version = pinned or json.loads(src.read(PREFIX + 'active.json'))['id']
        prefix = f'{PREFIX}{version}/infer/'
        objects = src.list(prefix)
        if not objects:
            raise RuntimeError(f'no files under {prefix} in {src.where}')
        got = 0
        for key, size, etag in objects:
            target = os.path.join(root, version, 'infer', *key[len(prefix):].split('/'))
            if os.path.exists(target) and os.path.getsize(target) == size and ('-' in etag or _md5(target) == etag):
                continue  # same file (a multipart upload's ETag is no MD5: the size decides then)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src.download(key, target + '.part')
            os.replace(target + '.part', target)
            got += 1
        folder = os.path.join(root, version, 'infer')
        os.makedirs(root, exist_ok=True)
        with open(last_file, 'w', encoding='utf-8') as f:
            json.dump({'id': version}, f)
        log(f"[ocr-server] Recognition model {version} from {src.where}{f' ({got} file(s) downloaded)' if got else ''} -> {folder}")
        return folder, version
    except Exception as e:  # noqa: BLE001 - MinIO down / no credentials / no such version
        version = pinned
        if not version and os.path.exists(last_file):
            with open(last_file, encoding='utf-8') as f:
                version = json.load(f).get('id')
        folder = os.path.join(root, version or '', 'infer')
        if version and os.path.exists(os.path.join(folder, 'inference.pdiparams')):
            log(f'[ocr-server] Cannot get the recognition model from MinIO ({e}); using the copy of {version} in {folder}')
            return folder, version
        raise RuntimeError(f'Cannot get the OCR recognition model from MinIO and there is no local copy yet: {e}') from e
