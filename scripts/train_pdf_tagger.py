"""
Word tagger for roster PDFs: which field (date, duty, dep, arr, begin, end, ac,
registration, hotel, dc, info, ci, co, co_info) each word is, or O (not in a row).
The model itself is in scripts/pdf_tagger.py.

Trained on exports/pdf-tokens/ (scripts/build-pdf-token-data.mjs). Features are
generic: the shape of the word, the column header above it (found on the page,
not hard-coded per layout), its place between that header and the next one,
and its line and neighbours.

  .venv/Scripts/python scripts/train_pdf_tagger.py            # evaluate (by file, and leaving one layout out)
  .venv/Scripts/python scripts/train_pdf_tagger.py --save     # also train on everything -> models/pdf-tagger/
  .venv/Scripts/python scripts/train_pdf_tagger.py --no-eval --save DIR   # only train and save (the app's retrain)
  .venv/Scripts/python scripts/train_pdf_tagger.py --predict file|layout|one   # tags from models that never saw the file
  .venv/Scripts/python scripts/train_pdf_tagger.py --curve    # how many labeled files a new layout needs
"""
import json
import os
import sys
from collections import Counter

import numpy as np
from sklearn.metrics import classification_report

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_tagger import HEADER_WORDS, doc_features, fit, use_learned_header_words  # noqa: E402

# Training words: PDFs (build-pdf-token-data.mjs) and roster images (build-image-token-data.mjs).
# --pdf-only: the PDFs alone.
DATA = ['exports/pdf-tokens'] + ([] if '--pdf-only' in sys.argv else ['exports/image-tokens'])


def family(doc):
    """Layout family, for leaving one out and for weighting layouts the same."""
    words = {t['t'] for p in doc['pages'] for t in p['tokens']}
    if doc.get('kind') == 'image':
        return 'image-roster'
    if doc.get('format') in (None, 'unknown'):
        return 'file:' + doc['file']  # a format the parser does not read: known only from its label
    if doc['format'] != 'netline-duty-plan':
        return doc['format']
    if 'stops' in words and 'req' in words:
        return 'netline-ryr'
    head = max((sum(1 for t in p['tokens'] if t['t'] == 'date') for p in doc['pages']), default=0)
    return 'netline-2block' if head == 2 else 'netline-3block'


def load():
    docs = []
    for data in DATA:
        if not os.path.isdir(data):
            continue
        for name in sorted(os.listdir(data)):
            if name == 'summary.json':
                continue
            doc = json.load(open(os.path.join(data, name), encoding='utf-8'))
            X, ctxs = doc_features(doc['pages'])
            y = [t['field'] for page in doc['pages'] for t in page['tokens']]
            docs.append({'file': doc['file'], 'kind': doc.get('kind', 'pdf'), 'family': family(doc), 'X': X, 'y': y, 'ctx': ctxs, 'doc': doc})
    return docs


def evaluate(docs, groups, title):
    y_true, y_pred = [], []
    for g in sorted(set(groups)):
        train = [d for d, gg in zip(docs, groups) if gg != g]
        test = [d for d, gg in zip(docs, groups) if gg == g]
        model = fit(train)
        pred = [p for d in test for p in model.predict(d)]
        truth = [l for d in test for l in d['y']]
        acc, acc_t = score(pred, truth)
        print(f'  held out {g}: {len(test)} files, words {acc:.1%} right, row-field words {acc_t:.1%} right')
        y_true += [t for t in truth if t != '?']
        y_pred += [p for p, t in zip(pred, truth) if t != '?']
    print(f'\n{title}')
    print(classification_report(y_true, y_pred, digits=3, zero_division=0))


def score(pred, truth):
    pred, truth = np.array(pred), np.array(truth)
    sure = truth != '?'
    pred, truth = pred[sure], truth[sure]
    tagged = truth != 'O'
    return (pred == truth).mean(), (pred[tagged] == truth[tagged]).mean() if tagged.any() else 0


def learning_curve(docs):
    """A new layout: how many labeled files of it are needed? Train on the other layouts plus k files of it, test on its other files."""
    fams = Counter(d['family'] for d in docs)
    for fam in sorted(f for f, n in fams.items() if n >= 2):
        mine = [d for d in docs if d['family'] == fam]
        others = [d for d in docs if d['family'] != fam]
        out = []
        for k in (0, 1, 2, 3):
            if k >= len(mine):
                break
            accs = []
            # Each of the first few files in turn as the labeled one(s).
            for start in range(min(len(mine), 3)):
                seen = [mine[(start + j) % len(mine)] for j in range(k)]
                test = [d for d in mine if d not in seen]
                train = others + seen
                model = fit(train)
                accs.append(score([p for d in test for p in model.predict(d)], [l for d in test for l in d['y']]))
                if k == 0:
                    break
            out.append(f'{k} file(s): {np.mean([a for a, _ in accs]):.1%} / {np.mean([b for _, b in accs]):.1%}')
        print(f'  {fam} ({len(mine)} files): ' + ', '.join(out))


def predict(docs, split, out_dir):
    """
    Tags of every file from a model that never saw it, written like exports/pdf-tokens
    (field = predicted) for scripts/eval-pdf-assembler.mjs --pred. split:
      file   - 5 folds by file (its layout was seen in other files)
      layout - its whole layout left out (a format never seen)
      one    - its layout left out except its first file (a new format after labeling one file)
    """
    os.makedirs(out_dir, exist_ok=True)
    if split == 'file':
        groups = [[d for i, d in enumerate(docs) if i % 5 == k] for k in range(5)]
        plans = [(g, [d for d in docs if d not in g]) for g in groups]
    elif split == 'layout':
        fams = sorted({d['family'] for d in docs})
        plans = [([d for d in docs if d['family'] == f], [d for d in docs if d['family'] != f]) for f in fams]
    else:
        # Per layout with 2+ files: its first file labeled, the others tagged (layouts of one file can't be tested so).
        plans = []
        for fam in sorted({d['family'] for d in docs}):
            mine = [d for d in docs if d['family'] == fam]
            if len(mine) >= 2:
                plans.append((mine[1:], [d for d in docs if d['family'] != fam] + mine[:1]))
    for test, train in plans:
        model = fit(train)
        for d in test:
            pred = model.predict(d)
            doc = json.loads(json.dumps(d['doc']))
            k = 0
            for page in doc['pages']:
                for t in page['tokens']:
                    t['field'] = pred[k]
                    t.pop('section', None)
                    t.pop('row', None)
                    k += 1
            json.dump(doc, open(os.path.join(out_dir, d['file'] + '.json'), 'w', encoding='utf-8'))
        print(f'  {split}: {len(test)} file(s) tagged', flush=True)


def main():
    if '--conventions' in sys.argv:  # header words learned from the labels (scripts/train-pdf-model.mjs)
        use_learned_header_words(sys.argv[sys.argv.index('--conventions') + 1])
    docs = load()
    if '--predict' in sys.argv:
        split = sys.argv[sys.argv.index('--predict') + 1]
        predict(docs, split, os.path.join('exports', 'pdf-tokens-pred', split + ('-pdfonly' if '--pdf-only' in sys.argv else '')))
        return
    if '--curve' in sys.argv:
        print('New layout, k labeled files of it in training (words right / row-field words right):')
        learning_curve(docs)
        return
    fams = Counter(d['family'] for d in docs)
    if '--no-eval' in sys.argv:
        print(f'{len(docs)} files, {sum(len(d["y"]) for d in docs)} words', flush=True)
    else:
        print(f'{len(docs)} files, {sum(len(d["y"]) for d in docs)} words; layouts: {dict(fams)}\n')
        # 1. Known layouts: 5 folds by file (a file is never in its own training set).
        folds = [i % 5 for i in range(len(docs))]
        print('By file (5 folds):')
        evaluate(docs, folds, 'Known layouts (other files of the same layout were seen in training):')
        # 2. Unseen layout: train without one layout family, test on it.
        print('Leave one layout out:')
        evaluate(docs, [d['family'] for d in docs], 'Unseen layouts (that layout never seen in training):')
    if '--save' in sys.argv:
        import joblib
        at = sys.argv.index('--save') + 1
        out = sys.argv[at] if at < len(sys.argv) and not sys.argv[at].startswith('--') else 'models/pdf-tagger'
        model = fit(docs)
        os.makedirs(out, exist_ok=True)
        joblib.dump(model, os.path.join(out, 'tagger.joblib'))
        print(f'saved {os.path.join(out, "tagger.joblib")}')


if __name__ == '__main__':
    main()
