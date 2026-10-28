"""
Word tagger for roster PDFs: which field (date, duty, dep, arr, begin, end, ac,
registration, hotel, dc, info, ci, co, co_info) each word is, or O (not in a row).
The model itself is in scripts/pdf_tagger.py.

Trained on <ROSTER_WORK_DIR>/exports/pdf-tokens/ (scripts/build-pdf-token-data.mjs; utils/paths.js). Features are
generic: the shape of the word, the column header above it (found on the page,
not hard-coded per layout), its place between that header and the next one,
and its line and neighbours.

  .venv/Scripts/python scripts/train_pdf_tagger.py            # evaluate (by file, and leaving one layout out)
  .venv/Scripts/python scripts/train_pdf_tagger.py --save     # also train on everything -> <ROSTER_WORK_DIR>/models/pdf-tagger/
  .venv/Scripts/python scripts/train_pdf_tagger.py --no-eval --save DIR   # only train and save (the app's retrain)
  .venv/Scripts/python scripts/train_pdf_tagger.py --predict file|layout|one   # tags from models that never saw the file
  .venv/Scripts/python scripts/train_pdf_tagger.py --curve    # how many labeled files a new layout needs
"""
import json
import os
import sys
import tempfile
from collections import Counter

import numpy as np
from sklearn.metrics import classification_report

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_tagger import HEADER_WORDS, Vocab, compact_doc, doc_features, fit, sort_columns, use_learned_header_words  # noqa: E402

# Training words: PDFs (build-pdf-token-data.mjs), roster images (build-image-token-data.mjs) and
# ACARS pictures (build-acars-token-data.mjs). --pdf-only: the PDFs alone.
# Where the app keeps its work files (utils/paths.js): the Node callers pass ROSTER_WORK_DIR down.
WORK = os.environ.get('ROSTER_WORK_DIR') or os.path.join(tempfile.gettempdir(), 'roster-ocr-work')
EXPORTS = os.path.join(WORK, 'exports')
DATA = [os.path.join(EXPORTS, 'pdf-tokens')] + ([] if '--pdf-only' in sys.argv else [os.path.join(EXPORTS, 'image-tokens'), os.path.join(EXPORTS, 'acars-tokens')])


def family(doc):
    """Layout family, for leaving one out and for weighting layouts the same."""
    words = {t['t'] for p in doc['pages'] for t in p['tokens']}
    if doc.get('kind') == 'image':
        return 'image-roster'
    if doc.get('kind') == 'acars':
        return 'acars'
    if doc.get('format') in (None, 'unknown'):
        return 'file:' + doc['file']  # a format the parser does not read: known only from its label
    if doc['format'] != 'netline-duty-plan':
        return doc['format']
    if 'stops' in words and 'req' in words:
        return 'netline-ryr'
    head = max((sum(1 for t in p['tokens'] if t['t'] == 'date') for p in doc['pages']), default=0)
    return 'netline-2block' if head == 2 else 'netline-3block'


# Words a file brings to training at most (sample_pages: from all over it).
# Every layout weighs the same however many words it has (pdf_tagger.weights), so the pages past it of a
# 243-page activity list teach little, but their features (a dict per word) took gigabytes and ran the
# training out of memory. PDF_TAGGER_MAX_WORDS=0: no limit.
MAX_WORDS = int(os.environ.get('PDF_TAGGER_MAX_WORDS') or 8000)


def sample_pages(doc):
    """
    doc with up to MAX_WORDS words of it, taken from all over it (its first pages alone missed what only later
    rows have: a 73k-word duty export's other duty types); the number of words left out. Pages are kept whole,
    evenly spaced from the first; one long page (a spreadsheet's rows) keeps evenly spaced runs of its lines,
    each run whole so that a word's neighbours above and below stay its own.
    """
    total = sum(len(p['tokens']) for p in doc['pages'])
    if not MAX_WORDS or total <= MAX_WORDS:
        return 0
    pages = doc['pages']
    if len(pages) > 1:
        per = total / len(pages)
        want = max(1, int(MAX_WORDS // max(per, 1)))
        step = len(pages) / want
        kept = [pages[int(k * step)] for k in range(want)]
        kept = [p if len(p['tokens']) <= MAX_WORDS else long_page(p) for p in kept]
    else:
        kept = [long_page(pages[0])]
    doc['pages'] = kept
    return total - sum(len(p['tokens']) for p in kept)


RUN_LINES = 40  # lines of a long page kept together


def long_page(page):
    """A page of more than MAX_WORDS words: evenly spaced runs of RUN_LINES lines, MAX_WORDS words in all."""
    ys = sorted({round(t['y']) for t in page['tokens']})
    per_line = len(page['tokens']) / max(len(ys), 1)
    runs = max(1, int(MAX_WORDS / (per_line * RUN_LINES)))
    step = len(ys) / runs
    keep = {y for k in range(runs) for y in ys[int(k * step):int(k * step) + RUN_LINES]}
    return {**page, 'tokens': [t for t in page['tokens'] if round(t['y']) in keep]}


def load():
    # Each document's features made a matrix at once (pdf_tagger.compact_doc): dicts for every word took GBs.
    # The document itself is kept only for --predict (it writes the tags into it).
    vocab = Vocab()
    keep_doc = '--predict' in sys.argv
    docs = []
    cut_words, cut_files = 0, 0
    for data in DATA:
        if not os.path.isdir(data):
            continue
        for name in sorted(os.listdir(data)):
            if name == 'summary.json':
                continue
            doc = json.load(open(os.path.join(data, name), encoding='utf-8'))
            cut = sample_pages(doc)
            if cut:
                cut_words += cut
                cut_files += 1
            X, ctxs = doc_features(doc['pages'])
            y = [t['field'] for page in doc['pages'] for t in page['tokens']]
            docs.append(compact_doc({'file': doc['file'], 'kind': doc.get('kind', 'pdf'), 'family': family(doc), 'X': X, 'y': y, 'ctx': ctxs,
                                     'doc': doc if keep_doc else None, 'vocab': vocab}, vocab))
            del X, ctxs, doc
    for d, m in zip(docs, sort_columns(vocab, [d['M'] for d in docs])):
        d['M'] = m
    if cut_words:
        print(f'{cut_words} words of {cut_files} long files left out ({MAX_WORDS} words of each, from all over it: PDF_TAGGER_MAX_WORDS)', flush=True)
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
    (field = predicted) for scripts/model-eval-assembler.mjs --pred. split:
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
    if '--conventions' in sys.argv:  # header words learned from the labels (scripts/model-train.mjs)
        use_learned_header_words(sys.argv[sys.argv.index('--conventions') + 1])
    docs = load()
    if '--predict' in sys.argv:
        split = sys.argv[sys.argv.index('--predict') + 1]
        predict(docs, split, os.path.join(EXPORTS, 'pdf-tokens-pred', split + ('-pdfonly' if '--pdf-only' in sys.argv else '')))
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
        out = sys.argv[at] if at < len(sys.argv) and not sys.argv[at].startswith('--') else os.path.join(WORK, 'models', 'pdf-tagger')
        model = fit(docs)
        os.makedirs(out, exist_ok=True)
        joblib.dump(model, os.path.join(out, 'tagger.joblib'))
        print(f'saved {os.path.join(out, "tagger.joblib")}')


if __name__ == '__main__':
    main()
