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


def fit1(X, y, w=None):
    # svc: seconds per fit (default). hgb: slower (minutes), a little better on some fields.
    vec = DictVectorizer()
    Xv = vec.fit_transform(X)
    if MODEL == 'hgb':
        clf = Dense(HistGradientBoostingClassifier(max_iter=300, learning_rate=0.1, max_leaf_nodes=63, class_weight='balanced', random_state=0))
    else:
        clf = LinearSVC(C=SVC_C, class_weight='balanced', max_iter=3000)
    clf.fit(Xv, y, sample_weight=w)
    return vec, clf


def weights(docs, keep):
    """
    Every layout counts the same in training, however many files and words it has:
    a format with one labeled file is learned as well as one with thirty. A word's
    weight = 1 / (words of its layout), scaled so the mean is 1. Layout = d['family']
    (the parser's format), or the file itself for a format only its label describes.
    """
    fam = lambda d: d.get('family') or d['file']
    size = Counter()
    for d in docs:
        size[fam(d)] += len(keep(d))
    raw = [1 / size[fam(d)] for d in docs for _ in keep(d)]
    mean = sum(raw) / len(raw)
    return [r / mean for r in raw]


def stage2_feats(d, s1):
    """A word's own features plus what stage 1 said about it, its neighbours, the words above/below and its line."""
    by_line = defaultdict(Counter)
    for c, lab in zip(d['ctx'], s1):
        by_line[c['line']][lab] += 1
    out = []
    for i, (f, c) in enumerate(zip(d['X'], d['ctx'])):
        g = dict(f)
        me = s1[i]
        g['s1=' + me] = 1
        for k in ('L', 'R', 'U', 'D'):
            other = s1[c[k]] if c[k] is not None else '^'
            g[f'{k}_s1={other}'] = 1
            g[f'{k}_s1={other}&s1={me}'] = 1
        line = by_line[c['line']]
        n = sum(line.values())
        for lab, k in line.items():
            g['line_s1=' + lab] = k / n
        g['line_info_share&s1=' + me] = line['info'] / n
        out.append(g)
    return out


class Tagger:
    """Two stages: word features -> field; then again with the stage-1 fields of the context."""

    def fit(self, docs):
        # Words marked "?" (the label could not be matched there) are context only, never a training target.
        keep = lambda d: [i for i, l in enumerate(d['y']) if l != '?']
        X = [d['X'][i] for d in docs for i in keep(d)]
        y = [d['y'][i] for d in docs for i in keep(d)]
        w = weights(docs, keep)
        self.s1 = fit1(X, y, w)
        # Stage-1 fields of the training files as they would be on new files: from models that did not see them.
        oof = {}
        k = 3 if len(docs) >= 3 else 1
        for g in range(k):
            test = [d for i, d in enumerate(docs) if i % k == g]
            train = [d for i, d in enumerate(docs) if i % k != g] or docs
            vec, clf = fit1([d['X'][i] for d in train for i in keep(d)], [d['y'][i] for d in train for i in keep(d)], weights(train, keep))
            for d in test:
                oof[d['file']] = list(clf.predict(vec.transform(d['X'])))
        self.s2 = fit1([f for d in docs for i, f in enumerate(stage2_feats(d, oof[d['file']])) if d['y'][i] != '?'], y, w)
        return self

    def predict(self, d):
        vec, clf = self.s1
        s1 = list(clf.predict(vec.transform(d['X'])))
        vec, clf = self.s2
        return list(clf.predict(vec.transform(stage2_feats(d, s1))))


def fit(docs):
    return Tagger().fit(docs)

