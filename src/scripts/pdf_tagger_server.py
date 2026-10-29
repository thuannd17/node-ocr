"""
The learned extractor's tagger kept running for the app (services/pdf-ai-extract.js): the imports
(numpy, scipy, sklearn) take ~2-3 s, a model ~0.1 s, tagging one file well under that.

  one JSON request per line on stdin:   {"id": 1, "dir": model_dir, "pages": [...]}
  one JSON answer per line on stdout:   {"id": 1, "fields": [[...]]}  |  {"id": 1, "error": "..."}

Models are kept per version folder and loaded again when tagger.joblib changes. The header words
(pdf_tagger.HEADER_WORDS) are the built-in ones plus the version's tagger's own (tagger-words.json or conventions.json), as in
pdf_tagger_predict.py, set again whenever a request is for another version.
"""
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joblib  # noqa: E402
import pdf_tagger  # noqa: E402  (the pickled model refers to pdf_tagger)
from pdf_tagger_predict import tag_pages  # noqa: E402

BASE_HEADER_WORDS = set(pdf_tagger.HEADER_WORDS)
models = {}  # model_dir -> (mtime of tagger.joblib, model)
words_of = None  # the version whose header words are in HEADER_WORDS


def model_for(model_dir):
    global words_of
    path = os.path.join(model_dir, 'tagger.joblib')
    mtime = os.path.getmtime(path)
    hit = models.get(model_dir)
    if not hit or hit[0] != mtime:
        hit = models[model_dir] = (mtime, joblib.load(path))
        words_of = None  # its conventions.json may have changed too
    if words_of != model_dir:
        pdf_tagger.HEADER_WORDS.clear()
        pdf_tagger.HEADER_WORDS.update(BASE_HEADER_WORDS)
        pdf_tagger.use_learned_header_words(pdf_tagger.tagger_words_file(model_dir))
        words_of = model_dir
    return hit[1]


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            answer = {'id': req.get('id'), 'fields': tag_pages(model_for(req['dir']), req['pages'])}
        except Exception as e:  # noqa: BLE001  (one bad file must not stop the others)
            traceback.print_exc(file=sys.stderr)
            answer = {'id': req.get('id'), 'error': f'{type(e).__name__}: {e}'}
        sys.stdout.write(json.dumps(answer) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
