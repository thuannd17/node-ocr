"""
Tags the words of one roster PDF with the saved model (the app's learned extractor).

  python scripts/pdf_tagger_predict.py model_dir < {"pages": [{width, height, tokens: [{t, x, y, w, h}]}]}
  -> {"fields": [[field per token] per page]}
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import joblib  # noqa: E402
from pdf_tagger import doc_features, use_learned_header_words  # noqa: E402,F401  (the pickled model refers to pdf_tagger)


def main():
    if len(sys.argv) < 2:
        sys.exit('usage: pdf_tagger_predict.py model_dir  (the app passes the active version, services/ai-models.js)')
    model_dir = sys.argv[1]
    model = joblib.load(os.path.join(model_dir, 'tagger.joblib'))
    use_learned_header_words(os.path.join(model_dir, 'conventions.json'))  # the header words it was trained with
    pages = json.load(sys.stdin)['pages']
    X, ctx = doc_features(pages)
    kind = pages[0].get('kind') if pages else None  # 'acars': only ACARS fields (pdf_tagger.predict_masked)
    pred = model.predict({'X': X, 'ctx': ctx, 'kind': kind}) if X else []
    out, k = [], 0
    for page in pages:
        out.append([str(p) for p in pred[k:k + len(page['tokens'])]])
        k += len(page['tokens'])
    sys.stdout.write(json.dumps({'fields': out}))


if __name__ == '__main__':
    main()
