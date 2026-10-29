"""
The learned roster-PDF word tagger: features and the two-stage model. Used by
scripts/train_pdf_tagger.py (training, evaluation) and scripts/pdf_tagger_predict.py
(the app). The saved model (models/pdf-tagger/tagger.joblib) refers to this module.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

import numpy as np
from scipy import sparse

from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction import DictVectorizer
from sklearn.svm import LinearSVC

# Words seen in column headers of crew rosters (any airline / system), shared with
# services/pdf-row-assembler.js. A line holding several of them is a header line.
HEADER_WORDS = set(json.load(open(os.path.join(os.path.dirname(__file__), '..', 'services', 'pdf-header-words.json'), encoding='utf-8')))


def use_learned_header_words(conventions_file):
    """Add the column-header words a model learned from labeled layouts (conventions.json headerWords)."""
    try:
        with open(conventions_file, encoding='utf-8') as f:
            HEADER_WORDS.update(json.load(f).get('headerWords', []))
    except (OSError, ValueError):
        pass


def tagger_words_file(model_dir):
    """The file with the header words a version's tagger was trained with: tagger-words.json when its conventions were
    learned again after the tagger (scripts/model-train.mjs --conventions-only), else its conventions.json."""
    own = os.path.join(model_dir, 'tagger-words.json')
    return own if os.path.exists(own) else os.path.join(model_dir, 'conventions.json')

TIME = re.compile(r'^!?\d{4}([+-]\d)?$')
HHMM = re.compile(r'^\d{1,3}:\d{2}\]?$')
AIRPORT = re.compile(r'^[A-Z]{3}$')
DATEISH = re.compile(r'^(\d{2}[A-Z][a-z]{2}\d{2}|(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{2}|\d{2}\.|\d{2}\.\d{2}\.|\d{2}/\d{2}/\d{4})$')
WEEKDAY = re.compile(r'^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Lunes|Martes|Mi[ée]rcoles|Jueves|Viernes|S[áa]bado|Domingo)\.?$')
HOTEL = re.compile(r'^H(\d+\*?|\?)$')


def shape(t):
    s = re.sub(r'[A-Z]', 'A', t)
    s = re.sub(r'[a-z]', 'a', s)
    s = re.sub(r'\d', '9', s)
    return re.sub(r'(.)\1+', r'\1\1', s)[:8]


def wtype(t):
    """Coarse kind of word, for crossing with its column and neighbours."""
    for name, rx in (('time', TIME), ('hhmm', HHMM), ('date', DATEISH), ('wday', WEEKDAY), ('hotel', HOTEL), ('apt', AIRPORT)):
        if rx.match(t):
            return name
    if t[:1] in '[(':
        return 'brk'
    if t.isdigit():
        return 'num'
    if re.fullmatch(r'[A-Z0-9/-]+', t):
        return 'code'
    return 'word'


def word_feats(t, prefix=''):
    return {
        f'{prefix}type=' + wtype(t): 1,
        f'{prefix}time': bool(TIME.match(t)),
        f'{prefix}local': t.startswith('!'),
        f'{prefix}hhmm': bool(HHMM.match(t)),
        f'{prefix}airport': bool(AIRPORT.match(t)),
        f'{prefix}dateish': bool(DATEISH.match(t)),
        f'{prefix}weekday': bool(WEEKDAY.match(t)),
        f'{prefix}hotel': bool(HOTEL.match(t)),
        f'{prefix}bracket': t[:1] in '[(' or t[-1:] in '])',
        f'{prefix}digits': sum(c.isdigit() for c in t) / max(len(t), 1),
        f'{prefix}upper': sum(c.isupper() for c in t) / max(len(t), 1),
        f'{prefix}lower': sum(c.islower() for c in t) / max(len(t), 1),
        f'{prefix}len': min(len(t), 20),
        f'{prefix}shape=' + shape(t): 1,
    }


def lines_of(tokens, tol=1.5):
    lines = []
    for i in sorted(range(len(tokens)), key=lambda k: (tokens[k]['y'], tokens[k]['x'])):
        if lines and abs(tokens[i]['y'] - lines[-1]['y']) <= tol:
            lines[-1]['ids'].append(i)
        else:
            lines.append({'y': tokens[i]['y'], 'ids': [i]})
    for ln in lines:
        ln['ids'].sort(key=lambda k: tokens[k]['x'])
    return lines


# ---- ACARS pictures (services/acars.js): a key/value screen, not a table ----
# Their fields are the tagger's own; a word of an ACARS picture is only ever one of them (or O),
# a word of a roster never one of them (see predict_masked).
ACARS_FIELDS = {'flt', 'adate', 'dept', 'dest', 'out', 'off', 'on', 'in', 'block', 'flight'}
_AS_LETTER = str.maketrans('012568', 'OIZSBG')
ACARS_TIME = re.compile(r'^[0-9OQDILTZSBG|]{1,2}[:.+]?[0-9OQDILTZSBG|]{2}([:.][0-9]{2})?Z?$|^[0-9]{6}Z?$')
ICAO = re.compile(r'^[A-Z]{4}$')
FLTNO = re.compile(r'^[A-Z0-9]{2,3}[0-9]{1,5}[A-Z]{0,2}$')
# a date as these screens print it: 02SEP22, 27OCT, 27/11/22, 28/MAY (OCR slips in the digits); a bare day: 14, /21
ACARS_DATE = re.compile(r'^[0-9OIZS]{1,2}([A-Z0-9]{3}[0-9OIZS]{0,2}|/[0-9OIZS]{1,2}/[0-9OIZS]{2,4}|/[A-Z]{3})$')
ACARS_DAY = re.compile(r'^[/-]?[0-3]?[0-9]$')


def label_text(t):
    """Letters of a label word, digits OCR read for letters back as letters ("0UT" -> "OUT")."""
    return re.sub(r'[^A-Z]', '', t.upper().translate(_AS_LETTER))[:14]


def labelish(t):
    return bool(re.search(r'[A-Za-z]', t)) and sum(c.isdigit() for c in t) <= 1 and len(t) >= 2 and not re.search(r':.', t)


def acars_feats(toks, lines, li, pos):
    """What an ACARS value is known by: the label word over it (one or two lines up) and left of it."""
    ids = lines[li]['ids']
    i = ids[pos]
    t = toks[i]
    f = {'kind=acars': 1, 'kind=acars&type=' + wtype(t['t']): 1}
    tt = t['t']
    f['ac_time'] = bool(ACARS_TIME.match(tt.upper()))
    f['ac_icao'] = bool(ICAO.match(tt))
    f['ac_flt'] = bool(FLTNO.match(tt))
    f['ac_date'] = bool(ACARS_DATE.match(tt.upper())) and bool(re.search(r'[A-Z/]', tt.upper()))
    f['ac_day'] = bool(ACARS_DAY.match(tt))
    f['ac_x_right'] = t['x'] > 0.5 * max(toks[k]['x'] + toks[k]['w'] for k in ids)
    if labelish(tt):
        f['ac_self=' + label_text(tt)] = 1
    # left: the nearest word that is not a "/" or "-"
    names = []
    for j in range(pos - 1, -1, -1):
        w = toks[ids[j]]['t']
        if w in ('/', '-'):
            continue
        names.append(label_text(w) if labelish(w) else '#val')
        if len(names) == 2:
            break
    for k, n in enumerate(names):
        f[f'ac_left{k}=' + n] = 1
        f[f'ac_left{k}={n}&time={f["ac_time"]}'] = 1
    # up: the word over it on the line above, and the one above that
    cx = t['x'] + t['w'] / 2
    for k, lj in enumerate((li - 1, li - 2)):
        if lj < 0:
            f[f'ac_up{k}=^'] = 1
            continue
        cand = [c for c in lines[lj]['ids'] if toks[c]['t'] not in ('/', '-')]
        if not cand:
            continue
        over = [c for c in cand if toks[c]['x'] < t['x'] + t['w'] and t['x'] < toks[c]['x'] + toks[c]['w']]
        c = min(over or cand, key=lambda c: abs(toks[c]['x'] + toks[c]['w'] / 2 - cx))
        w = toks[c]['t']
        n = label_text(w) if labelish(w) else '#val'
        f[f'ac_up{k}=' + n] = 1
        f[f'ac_up{k}={n}&time={f["ac_time"]}'] = 1
        f[f'ac_up{k}_over'] = bool(over)
    return f


def page_features(page):
    toks = page['tokens']
    W, H = page['width'] or 1, page['height'] or 1
    lines = lines_of(toks)
    # Header lines: several known header words. Two header lines close together (Spanish) count as one.
    headers = []
    for ln in lines:
        words = [toks[i] for i in ln['ids']]
        hits = sum(w['t'].lower() in HEADER_WORDS for w in words)
        if hits >= 3 and hits >= 0.5 * len(words):
            headers.append(ln)
    feats = [None] * len(toks)
    # Context for the second stage: line, left/right neighbours, the word above/below (closest x on the next lines).
    ctx = [None] * len(toks)
    for li, ln in enumerate(lines):
        ids = ln['ids']
        for pos, i in enumerate(ids):
            near = []
            for lj in (li - 1, li + 1):
                if 0 <= lj < len(lines) and abs(lines[lj]['y'] - ln['y']) < 25:
                    cand = min(lines[lj]['ids'], key=lambda k: abs(toks[k]['x'] - toks[i]['x']))
                    near.append(cand if abs(toks[cand]['x'] - toks[i]['x']) < 20 else None)
                else:
                    near.append(None)
            ctx[i] = {'line': li, 'L': ids[pos - 1] if pos else None, 'R': ids[pos + 1] if pos + 1 < len(ids) else None, 'U': near[0], 'D': near[1]}
    for li, ln in enumerate(lines):
        ids = ln['ids']
        line_has_time = any(TIME.match(toks[i]['t']) for i in ids)
        line_has_date = any(DATEISH.match(toks[i]['t']) for i in ids)
        line_has_stat = any(toks[i]['t'].startswith('[') for i in ids)
        line_lower = sum(any(c.islower() for c in toks[i]['t']) for i in ids) / len(ids)
        line_apt = sum(bool(AIRPORT.match(toks[i]['t'])) for i in ids)
        hdr = [h for h in headers if h['y'] < ln['y'] - 1]
        hdr = hdr[-1] if hdr else None
        hx = sorted(((toks[k]['x'], toks[k]['t'].lower()) for k in hdr['ids']), key=lambda p: p[0]) if hdr else []
        prev_gap = ln['y'] - lines[li - 1]['y'] if li else 99
        for pos, i in enumerate(ids):
            t = toks[i]
            f = word_feats(t['t'])
            f.update({
                'x': t['x'] / W, 'y': t['y'] / H, 'pos': pos, 'pos_from_end': len(ids) - 1 - pos, 'line_len': len(ids),
                'line_time': line_has_time, 'line_date': line_has_date, 'line_stat': line_has_stat,
                'line_lower': line_lower, 'line_apt': min(line_apt, 4),
                'prev_gap': min(prev_gap, 50), 'has_header': hdr is not None,
                'below_header': min((ln['y'] - hdr['y']) / H, 1) if hdr else 1,
            })
            if hx:
                # Header word at or left of the word (columns are left-aligned), and the next one.
                left = [k for k, (x, _) in enumerate(hx) if x <= t['x'] + 4]
                k = left[-1] if left else 0
                x0, name = hx[k]
                x1 = hx[k + 1][0] if k + 1 < len(hx) else x0 + 80
                f['hdr=' + name] = 1
                f['hdr_prev=' + (hx[k - 1][1] if k else '^')] = 1
                f['hdr_next=' + (hx[k + 1][1] if k + 1 < len(hx) else '$')] = 1
                f['hdr_rel'] = (t['x'] - x0) / max(x1 - x0, 1)
                f['hdr_dx'] = (t['x'] - x0) / W
                # Nearest header word by centre too (right-aligned numbers).
                kc = min(range(len(hx)), key=lambda j: abs(hx[j][0] - t['x']))
                f['hdrc=' + hx[kc][1]] = 1
                ty = wtype(t['t'])
                f[f'hdr={name}&type={ty}'] = 1
                f[f'hdrc={hx[kc][1]}&type={ty}'] = 1
                f[f'hdr={name}&pos={min(len(left) and pos, 3)}'] = 1
            for d, name in ((-1, 'L'), (1, 'R')):
                j = pos + d
                if 0 <= j < len(ids):
                    n = toks[ids[j]]
                    f.update(word_feats(n['t'], prefix=name + '_'))
                    f[name + '_dx'] = abs(n['x'] - t['x']) / W
                    f[f'{name}_type={wtype(n["t"])}&type={wtype(t["t"])}'] = 1
                else:
                    f[name + '_none'] = 1
                    f[f'{name}_none&type={wtype(t["t"])}'] = 1
            f[f'pos={min(pos, 4)}&type={wtype(t["t"])}'] = 1
            f[f'line_time={line_has_time}&type={wtype(t["t"])}'] = 1
            if page.get('kind') == 'acars':
                f.update(acars_feats(toks, lines, li, pos))
            feats[i] = f
    return feats, ctx


def doc_features(pages):
    """Features and context of every word of a document (pages of {width, height, tokens})."""
    X, ctxs = [], []
    for pi, page in enumerate(pages):
        f, c = page_features(page)
        off = len(X)
        X += f
        # Context indices doc-wide; the line id made unique per page.
        ctxs += [{k: (v + off if v is not None and k != 'line' else v) for k, v in cc.items()} | {'line': (pi, cc['line'])} for cc in c]
    return X, ctxs


MODEL = 'hgb' if '--hgb' in sys.argv else 'svc'
# LinearSVC regularization; PDF_TAGGER_C overrides it (more layouts may need a larger C)
SVC_C = float(os.environ.get('PDF_TAGGER_C') or 0.5)


class Dense:
    """A dense wrapper for models that need a numpy array."""
    def __init__(self, clf):
        self.clf = clf

    def fit(self, X, y):
        self.clf.fit(X.toarray(), y)
        return self

    def predict(self, X):
        return self.clf.predict(X.toarray())


def allowed_fields(kind, classes):
    """Fields a word of this kind of document can have: ACARS fields only on an ACARS picture."""
    if kind == 'acars':
        return np.array([c in ACARS_FIELDS or c == 'O' for c in classes])
    return np.array([c not in ACARS_FIELDS for c in classes])


def predict_masked(vec, clf, X, kind=None):
    """clf.predict, choosing only among the fields this kind of document has."""
    return predict_matrix(clf, vec.transform(X), kind)


def predict_matrix(clf, Xv, kind=None):
    """predict_masked on words already made a matrix."""
    if not hasattr(clf, 'decision_function') or not hasattr(clf, 'classes_'):
        return list(clf.predict(Xv))
    classes = clf.classes_
    scores = clf.decision_function(Xv)
    if scores.ndim == 1:
        return list(clf.predict(Xv))
    mask = allowed_fields(kind, classes)
    if not mask.any():
        return ['O'] * Xv.shape[0]
    scores[:, ~mask] = -np.inf
    return [str(c) for c in classes[scores.argmax(axis=1)]]


# A field's weight is "balanced" (rare fields count as much as common ones) but at most this much:
# the ACARS fields have ~20 words each against ~240k roster words, and uncapped weights of 400-700
# made LinearSVC converge very slowly. Every roster field stays under it (the rarest, co_info, ~80).
CLASS_WEIGHT_CAP = float(os.environ.get('PDF_TAGGER_WEIGHT_CAP') or 100)
# Fields trained at once (one binary classifier each). Each LinearSVC copies the training words into
# liblinear's own format (~0.45 GB each for the full data, 2026-10-22: ~0.46 GB words + 0.45 GB per field
# being trained), so this is kept low: 6 at once ran the machine out of memory. Threads, not processes
# (liblinear releases the GIL): no copy of the data per process. PDF_TAGGER_JOBS overrides it.
# Solver iterations per field. The fields with many words converge in 50-240 (2026-10-22, ~530k words); the
# rare ones (ACARS fields, landing: a few dozen words weighed up to CLASS_WEIGHT_CAP) never do and ran all 3000,
# in one training's fold an hour each. PDF_TAGGER_MAX_ITER overrides it.
MAX_ITER = int(os.environ.get('PDF_TAGGER_MAX_ITER') or 300)
JOBS = int(os.environ.get('PDF_TAGGER_JOBS') or min(4, max(1, (os.cpu_count() or 2) - 1)))
# liblinear's solver: 'auto' (default: scikit-learn picks primal, more words than features), or 'dual'
# (PDF_TAGGER_SOLVER=dual). On the PDF words (534k, 7k features, stage 1, 2026-10-28) dual took 563 s against
# primal's 367 s and tagged 73.0% of held-out words right against 71.1% (row-field words 72.3% against 72.8%).
DUAL = {'dual': True, 'primal': False}.get(os.environ.get('PDF_TAGGER_SOLVER', ''), 'auto')


class OvRLinear:
    """
    LinearSVC one-vs-rest, its binary problems trained in parallel. Same objective as
    LinearSVC(class_weight=...) with multi_class='ovr': in the problem of field c, its own words weigh
    sample_weight * class_weight[c], the other words sample_weight (liblinear weights the positive class only).
    An ACARS field (acars: the words of ACARS pictures) learns from those words alone: it is only ever
    chosen on an ACARS picture (allowed_fields), and the ~720k roster words made each of the ten take
    ~30 s per fit (2026-10-28) for nothing. Its weight is balanced among the ACARS words.
    """

    def fit(self, X, y, sample_weight=None, class_weight=None, acars=None):
        from joblib import Parallel, delayed
        y = np.asarray(y)
        sw = np.ones(len(y)) if sample_weight is None else np.asarray(sample_weight, dtype=float)
        self.classes_ = np.unique(y)
        cw = class_weight or {}
        acars = None if acars is None or not np.any(acars) else np.asarray(acars, dtype=bool)
        if acars is not None:
            Xa, ya, swa = X[acars], y[acars], sw[acars]
            cwa = balanced_weights(list(ya))

        import threading
        import time
        done, lock = [0], threading.Lock()

        def one(c):
            t = time.time()
            # (both kinds of word among the ACARS words, else LinearSVC has one class: all of them)
            if acars is not None and c in ACARS_FIELDS and 0 < np.sum(ya == c) < len(ya):
                Xc, yc, swc, wc = Xa, ya, swa, cwa.get(c, 1.0)
            else:
                Xc, yc, swc, wc = X, y, sw, cw.get(c, 1.0)
            pos = yc == c
            m = LinearSVC(C=SVC_C, max_iter=MAX_ITER, dual=DUAL)
            m.fit(Xc, pos.astype(int), sample_weight=np.where(pos, swc * wc, swc))
            with lock:  # (progress for the /models page: "[fields 3/24] dep 12s")
                done[0] += 1
                print(f'    [fields {done[0]}/{len(self.classes_)}] {c} {time.time() - t:.0f}s', flush=True)
            return m.coef_.ravel(), m.intercept_[0]

        # the fields with most words first (the slowest, "O" ~5 min): not left running alone at the end
        count = Counter(y.tolist())
        order = sorted(self.classes_, key=lambda c: -count[c])
        parts = dict(zip(order, Parallel(n_jobs=min(JOBS, len(self.classes_)), prefer='threads')(delayed(one)(c) for c in order)))
        self.coef_ = np.vstack([parts[c][0] for c in self.classes_])
        self.intercept_ = np.array([parts[c][1] for c in self.classes_])
        return self

    def decision_function(self, X):
        return np.asarray(X @ self.coef_.T) + self.intercept_

    def predict(self, X):
        return self.classes_[self.decision_function(X).argmax(axis=1)]


def balanced_weights(y):
    """class_weight='balanced' (n / (classes * count)), capped at CLASS_WEIGHT_CAP."""
    counts = Counter(y)
    n, k = len(y), len(counts)
    return {c: min(n / (k * m), CLASS_WEIGHT_CAP) for c, m in counts.items()}


def fit1(X, y, w=None):
    # svc: seconds per fit (default). hgb: slower (minutes), a little better on some fields.
    vec = DictVectorizer()
    Xv = vec.fit_transform(X)
    if MODEL == 'hgb':
        clf = Dense(HistGradientBoostingClassifier(max_iter=300, learning_rate=0.1, max_leaf_nodes=63, class_weight=balanced_weights(y), random_state=0))
        clf.fit(Xv, y, sample_weight=w)
    else:
        clf = OvRLinear().fit(Xv, y, sample_weight=w, class_weight=balanced_weights(y))
    return vec, clf


def weights(docs, keep):
    """
    A layout counts by the square root of its words in training: a format with one labeled file is
    still learned, and one with thirty (or a 200-page activity list) is not drowned by the many small
    ones. A word's weight = sqrt(words of its layout) / (words of its layout), scaled so the mean is 1.
    (Every layout the same, PDF_TAGGER_WEIGHT=family, left the big layouts at 56-85% of their own
    training words once there were ~80 layouts: 2026-10-24.) Layout = d['family'] (the parser's
    format), or the file itself for a format only its label describes.
    """
    fam = lambda d: d.get('family') or d['file']
    size = Counter()
    for d in docs:
        size[fam(d)] += len(keep(d))
    power = 0 if os.environ.get('PDF_TAGGER_WEIGHT') == 'family' else 0.5
    raw = [size[fam(d)] ** power / size[fam(d)] for d in docs for _ in keep(d)]
    mean = sum(raw) / len(raw)
    return [r / mean for r in raw]


NEIGHBOURS = ('L', 'R', 'U', 'D')


def stage2_extras(s1, near, lines):
    """What stage 1 said about a word, its neighbours (near[i]: L, R, U, D word or None), the words above/below and its line."""
    by_line = defaultdict(Counter)
    for ln, lab in zip(lines, s1):
        by_line[ln][lab] += 1
    out = []
    for i, me in enumerate(s1):
        g = {'s1=' + me: 1}
        for k, j in zip(NEIGHBOURS, near[i]):
            other = s1[j] if j is not None and j >= 0 else '^'
            g[f'{k}_s1={other}'] = 1
            g[f'{k}_s1={other}&s1={me}'] = 1
        line = by_line[lines[i]]
        n = sum(line.values())
        for lab, k in line.items():
            g['line_s1=' + lab] = k / n
        g['line_info_share&s1=' + me] = line['info'] / n
        out.append(g)
    return out


def stage2_feats(d, s1):
    """A word's own features plus what stage 1 said about it, its neighbours, the words above/below and its line."""
    near = [tuple(c[k] for k in NEIGHBOURS) for c in d['ctx']]
    return [dict(f) | g for f, g in zip(d['X'], stage2_extras(s1, near, [c['line'] for c in d['ctx']]))]


# ---- Training with little memory ----
# The features of ~500k words as dicts (a string key per feature, each word its own) took several GB, and
# stage 2 copied them all again. For training a document's features are made a sparse matrix as soon as
# they are read (Vocab, the columns DictVectorizer would give them) and the dicts dropped; stage 2 only adds
# its own columns. The saved model is the same: DictVectorizer + classifier per stage (Vocab.vectorizer).

class Vocab:
    """Feature name -> column, growing as words are read; rows made as DictVectorizer.transform makes them."""

    def __init__(self, names=()):
        self.index = {}
        for n in names:
            self.index.setdefault(n, len(self.index))

    def __len__(self):
        return len(self.index)

    def matrix(self, dicts, grow=True):
        index = self.index
        indptr, cols, vals = [0], [], []
        for x in dicts:
            for f, v in x.items():
                if isinstance(v, str):
                    f, v = f'{f}={v}', 1
                elif not (v is None or isinstance(v, (int, float))):
                    raise TypeError(f'feature {f}: {type(v)} value')
                j = index.get(f)
                if j is None:
                    if not grow:
                        continue
                    j = index[f] = len(index)
                if v:  # (a zero is no entry: the same to the model, less memory)
                    cols.append(j)
                    vals.append(float(v))
            indptr.append(len(cols))
        return sparse.csr_matrix((np.array(vals, dtype=np.float64), np.array(cols, dtype=np.int32), np.array(indptr, dtype=np.int64)),
                                 shape=(len(indptr) - 1, len(index)))

    def vectorizer(self):
        """A fitted DictVectorizer with these columns (what the app's pdf_tagger_predict.py uses)."""
        vec = DictVectorizer()
        vec.vocabulary_ = dict(self.index)
        vec.feature_names_ = sorted(self.index, key=self.index.get)
        return vec


def sort_columns(vocab, mats):
    """The columns renumbered in name order, each row's entries sorted: the matrices DictVectorizer makes. liblinear's
    result depends on the order of a row's entries, so this is what makes the model the same as before."""
    names = sorted(vocab.index)
    perm = np.empty(len(names), dtype=np.int32)
    for j, n in enumerate(names):
        perm[vocab.index[n]] = j
    vocab.index = {n: j for j, n in enumerate(names)}
    out = []
    for m in mats:
        m = widen(m, len(names))
        m = sparse.csr_matrix((m.data, perm[m.indices], m.indptr), shape=m.shape)
        m.sort_indices()
        out.append(m)
    return out


def widen(m, ncols):
    """m with ncols columns (a document read before the vocabulary grew), sharing its data."""
    return m if m.shape[1] == ncols else sparse.csr_matrix((m.data, m.indices, m.indptr), shape=(m.shape[0], ncols))


def compact_doc(d, vocab):
    """A document of train_pdf_tagger.load for training: features -> d['M'] (sparse, vocab's columns), context -> arrays."""
    ctx = d.pop('ctx')
    d['M'] = vocab.matrix(d.pop('X'))
    d['near'] = np.array([[-1 if c[k] is None else c[k] for k in NEIGHBOURS] for c in ctx], dtype=np.int32).reshape(-1, 4)
    ids = {}
    d['lines'] = np.array([ids.setdefault(c['line'], len(ids)) for c in ctx], dtype=np.int32)
    return d


def rows_of(docs, ncols, keep, mats=None):
    """The kept words of docs, one matrix."""
    parts = [widen((mats[k] if mats else d['M']), ncols)[keep(d)] for k, d in enumerate(docs)]
    return sparse.vstack(parts, format='csr') if parts else sparse.csr_matrix((0, ncols))


class Tagger:
    """Two stages: word features -> field; then again with the stage-1 fields of the context."""

    def fit(self, docs, prior=None):
        """
        docs from train_pdf_tagger.load: features as matrices (compact_doc, with docs[0]['vocab']).
        prior (an incremental run, train_pdf_tagger.incremental_base): {'oof': {doc key: stage-1 fields}, 'seen': the
        keys the last version was trained on, 's1': its stage 1}. The stage-1 fields of a file the last version saw
        unchanged are its saved ones; of a file it never saw, its stage 1's (it did not see that file); only files it saw
        whose words changed need a stage 1 trained without them. Saves the 3 stage-1 fits by parts of a full run.
        self.oof_: the stage-1 fields used, by doc key (train_pdf_tagger.py saves them for the next run and drops them).
        """
        vocab = docs[0]['vocab']
        n1 = len(vocab)
        # Words marked "?" (the label could not be matched there) are context only, never a training target.
        keep = lambda d: np.flatnonzero(np.asarray(d['y']) != '?')
        y = [d['y'][i] for d in docs for i in keep(d)]
        w = weights(docs, keep)
        # which kept words are an ACARS picture's (OvRLinear: the ACARS fields learn from those alone)
        acars = lambda ds: np.concatenate([np.full(len(keep(d)), d.get('kind') == 'acars') for d in ds]) if ds else None
        oof = {}  # by the document's place: a name can be a PDF's words and its picture's too
        if prior is None:
            k = 3 if len(docs) >= 3 else 1
            fits = k + 2
        else:
            for d in docs:
                if doc_key(d) in prior['oof']:
                    oof[id(d)] = prior['oof'][doc_key(d)]
            new = [d for d in docs if id(d) not in oof and doc_key(d) not in prior['seen']]
            changed = [d for d in docs if id(d) not in oof and doc_key(d) in prior['seen']]
            fits = 2 + bool(new) + bool(changed)
        # (progress for the /models page: "[fit 2/5] ...")
        n = iter(range(1, fits + 1))
        step = lambda what: print(f'  [fit {next(n)}/{fits}] {what}: {len(y)} words', flush=True)
        step('stage 1, every file')
        self.s1 = (vocab.vectorizer(), fit1m(rows_of(docs, n1, keep), y, w, acars(docs)))
        # Stage-1 fields of the training files as they would be on new files: from models that did not see them.
        # (Columns of features a part's training files lack weigh 0 in its model: as if its own vectorizer left them out.)
        if prior is None:
            for g in range(k):
                test = [d for i, d in enumerate(docs) if i % k == g]
                train = [d for i, d in enumerate(docs) if i % k != g] or docs
                step(f'stage 1 without part {g + 1} of {k} (what it says on the files it did not see)')
                clf = fit1m(rows_of(train, n1, keep), [d['y'][i] for d in train for i in keep(d)], weights(train, keep), acars(train))
                for d in test:
                    oof[id(d)] = predict_matrix(clf, widen(d['M'], n1), d.get('kind'))
                del clf
        else:
            print(f'  stage 1 of the last version: {len(oof)} files saved, {len(new)} new, {len(changed)} with changed words', flush=True)
            if new:
                step(f'stage 1 of the last version on the {len(new)} new files')
                vec, clf = prior['s1']
                for d in new:
                    oof[id(d)] = predict_matrix(clf, vec_rows(vec, d['M'], d['vocab']), d.get('kind'))
            if changed:
                redo = {id(d) for d in changed}
                train = [d for d in docs if id(d) not in redo] or docs
                step(f'stage 1 without the {len(changed)} files whose words changed')
                clf = fit1m(rows_of(train, n1, keep), [d['y'][i] for d in train for i in keep(d)], weights(train, keep), acars(train))
                for d in changed:
                    oof[id(d)] = predict_matrix(clf, widen(d['M'], n1), d.get('kind'))
                del clf
        self.oof_ = {doc_key(d): oof[id(d)] for d in docs}
        step('stage 2, every file')
        # stage 2's columns: stage 1's, then its own
        vocab2 = Vocab(vocab.index)
        extra = [vocab2.matrix(stage2_extras(oof[id(d)], d['near'], d['lines'])) for d in docs]
        n2 = len(vocab2)
        mats = sort_columns(vocab2, [widen(d['M'], n2) + widen(e, n2) for d, e in zip(docs, extra)])
        del extra
        X2 = rows_of(docs, n2, keep, mats)
        del mats
        self.s2 = (vocab2.vectorizer(), fit1m(X2, y, w, acars(docs)))
        return self

    def predict(self, d):
        if 'M' in d:  # a training document (compact_doc)
            vec, clf = self.s1
            s1 = predict_matrix(clf, vec_rows(vec, d['M'], d['vocab']), d.get('kind'))
            vec, clf = self.s2
            v2 = Vocab(d['vocab'].index)
            e = v2.matrix(stage2_extras(s1, d['near'], d['lines']))
            n = len(v2)
            return predict_matrix(clf, vec_rows(vec, widen(d['M'], n) + widen(e, n), v2), d.get('kind'))
        vec, clf = self.s1
        s1 = predict_masked(vec, clf, d['X'], d.get('kind'))
        vec, clf = self.s2
        return predict_masked(vec, clf, stage2_feats(d, s1), d.get('kind'))


def doc_key(d):
    """A training document's name across runs: its kind and file (a PDF's words and its picture's are two)."""
    return f"{d.get('kind', 'pdf')}:{d['file']}"


def fit(docs, prior=None):
    return Tagger().fit(docs, prior)


def fit1m(Xv, y, w=None, acars=None):
    """fit1 on words already made a matrix: the classifier only. acars: which words are an ACARS picture's."""
    # (liblinear's result depends on the order of a row's entries: sorted, as DictVectorizer gives them)
    Xv = Xv.tocsr()
    Xv.sort_indices()
    if MODEL == 'hgb':
        clf = Dense(HistGradientBoostingClassifier(max_iter=300, learning_rate=0.1, max_leaf_nodes=63, class_weight=balanced_weights(y), random_state=0))
        clf.fit(Xv, y, sample_weight=w)
        return clf
    return OvRLinear().fit(Xv, y, sample_weight=w, class_weight=balanced_weights(y), acars=acars)


def vec_rows(vec, m, vocab):
    """m (vocab's columns) in the columns of vec (a model trained on other documents, whose columns may be fewer or ordered otherwise)."""
    names = sorted(vocab.index, key=vocab.index.get)[:m.shape[1]]
    to = np.array([vec.vocabulary_.get(n, -1) for n in names], dtype=np.int64)
    m = m.tocoo()
    ok = to[m.col] >= 0
    return sparse.csr_matrix((m.data[ok], (m.row[ok], to[m.col[ok]])), shape=(m.shape[0], len(vec.vocabulary_)))

