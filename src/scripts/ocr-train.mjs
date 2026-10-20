#!/usr/bin/env node
/**
 * Train the next recognition model version and compare it with the deployed one.
 *
 *   npm run ocr:train                 # train v(N+1) if enough new rosters, then compare
 *   npm run ocr:train -- --status     # only report how many new rosters are waiting
 *   npm run ocr:train -- --min-new=3 --epochs=15 --keep-checkpoint
 *   npm run ocr:train -- --restart    # drop an unfinished run instead of resuming it
 *   npm run ocr:train -- --force      # train again even if this exact run was already done
 *   npm run ocr:train -- --acars-repeat=5   # how many times each ACARS training crop is listed (default 5)
 *   npm run ocr:train -- --fine-tune  # start from the deployed version's weights instead of the stock
 *                                     # ones: 4 epochs, lower learning rate, ACARS crops listed twice
 *                                     # (--epochs= / --acars-repeat= / --lr= still win)
 *
 * Fair comparison, rolling: the test set is every labeled roster the deployed
 * model has NOT seen (neither trained on nor tested on, per its model.json).
 * The new version is trained on everything else, with the deployed model's
 * recipe (models/rec/train-template.yml), so both models are scored on
 * rosters neither of them learned from. Next round those test rosters become
 * training data and the rosters labeled after this run become the test set.
 *
 * Scoring = the real pipeline offline: OCR server (det 1920, fast mode) per
 * model -> current services/roster-parser.js -> rows exactly right vs labels.
 * Nothing is deployed: the result is written to models/rec/vN/model.json and
 * printed; switch with `npm run ocr:use-model -- vN` if you agree.
 *
 * ACARS pictures (bucket acars-ocr) are learned too: their OCR lines with a known true text
 * (scripts/ocr-acars-crops.mjs) join the training crops. About a quarter of the ACARS pictures the
 * deployed model has not seen are kept out of training and score both models: label values found
 * among their OCR words. A run also starts when only new ACARS pictures wait (no new roster): the
 * rosters are then all trained on, and scored on all of them as a check that they are not read worse.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { groupByContent, pickCanonicalLabels } from '../utils/content-groups.js';
import { parseRoster, cleanExtractionResult } from '../services/roster-parser.js';
import { compareSection } from '../services/benchmark.js';
import { listData, listLabels, dataFile, labelFile, DATA_ROOT, LABELS_ROOT, ACARS_DATA_ROOT, ACARS_LABELS_ROOT } from '../utils/data-files.js';
import { syncForScript, acars, syncPrefix } from '../services/media-client.js';
import { acarsWordPages, alignAcars } from '../services/acars.js';
import sharp from 'sharp';
import { CACHE_DIR, EXPORTS_DIR, PRETRAINED_DIR, TRAIN_DIR, WORK_DIR, ymlPath } from '../utils/paths.js';
import { REC_DIR, syncRecModels, activeRecId, publishRec } from '../services/rec-models.js';

// The roster data and the OCR models live in MinIO: bring their local mirrors up to date.
await syncForScript();
await acars.syncForScript();
await syncRecModels({ force: true });

const ROOT = process.cwd();
const IS_WIN = process.platform === 'win32';
const PY = path.join(ROOT, '.venv', IS_WIN ? 'Scripts/python.exe' : 'bin/python');
const PADDLEOCR_PKG = path.join(ROOT, '.venv', IS_WIN ? 'Lib/site-packages/paddleocr' : 'lib/python3.11/site-packages/paddleocr');
// The versions are in MinIO; REC_DIR is their mirror in the work folder. A run works in PENDING (same
// drive as REC_DIR, so it can be renamed to vN) and the finished version is uploaded to MinIO.
const PENDING = path.join(TRAIN_DIR, 'rec-pending');
const TEMPLATE = path.join(ROOT, 'models', 'rec', 'train-template.yml');
const FAKE_DATA = DATA_ROOT;
const LABELS = LABELS_ROOT;
const STOCK_LINES = path.join(CACHE_DIR, 'ocr-det1920-stock'); // dataset builder input (stock recognizer)
const STOCK_ACARS_LINES = path.join(CACHE_DIR, 'ocr-det1920-stock-acars'); // the same for the ACARS pictures
const acarsFile = (n) => dataFile(ACARS_DATA_ROOT, n);
const PORT = Number(process.env.RETRAIN_OCR_PORT || 8506);
const DET_LIMIT = Number(process.env.OCR_TEXT_DET_LIMIT_SIDE_LEN || 1920);

function parseArgs(argv) {
	const a = { minNew: 5, minNewAcars: 4, epochs: 15, keepCheckpoint: false, status: false, acarsRepeat: 5, fineTune: false, lr: null };
	if (argv.includes('--fine-tune')) Object.assign(a, { fineTune: true, epochs: 4, acarsRepeat: 2, lr: 0.00002 });
	for (const x of argv) {
		if (x === '--status') a.status = true;
		else if (x === '--keep-checkpoint') a.keepCheckpoint = true;
		else if (x === '--restart') a.restart = true;
		else if (x === '--force') a.force = true;
		const m = /^--([^=]+)=(.*)$/.exec(x);
		if (m?.[1] === 'min-new') a.minNew = Number(m[2]);
		if (m?.[1] === 'epochs') a.epochs = Number(m[2]);
		if (m?.[1] === 'min-new-acars') a.minNewAcars = Number(m[2]);
		if (m?.[1] === 'acars-repeat') a.acarsRepeat = Number(m[2]);
		if (m?.[1] === 'lr') a.lr = Number(m[2]);
	}
	return a;
}

// a path for messages and model.json: relative inside the project, '<work>/...' in the work folder
const rel = (p) => {
	const inWork = path.relative(WORK_DIR, p);
	if (!inWork.startsWith('..') && !path.isAbsolute(inWork)) return `<work>/${inWork.replace(/\\/g, '/')}`;
	return path.relative(ROOT, p).replace(/\\/g, '/');
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
const md5File = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

function listVersions() {
	return fs.readdirSync(REC_DIR).filter(d => /^v\d+$/.test(d)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The version the OCR server uses (models/rec/active.json in MinIO, or OCR_REC_VERSION). */
function deployedVersion() {
	const id = activeRecId();
	if (!id || !/^v\d+$/.test(id)) throw new Error(`The OCR model in use (${id || 'none'}) is not a vN version: activate one on /models (or npm run ocr:use-model -- vN)`);
	return id;
}

/** Labeled images, one per distinct content: Map hash -> file name. */
function labeledRosters() {
	const names = listData(FAKE_DATA, 'image').filter(n => fs.existsSync(labelFile(LABELS, n)));
	const groups = groupByContent(FAKE_DATA, names);
	const { canonical } = pickCanonicalLabels(groups, LABELS);
	return { names, canonical };
}

/** Labeled ACARS pictures, one per distinct content: Map hash -> name (the first name). */
function labeledAcars() {
	const out = new Map();
	for (const n of listLabels(ACARS_LABELS_ROOT, 'image')) {
		if (!fs.existsSync(acarsFile(n))) continue;
		const h = md5File(acarsFile(n));
		if (!out.has(h)) out.set(h, n);
	}
	return out;
}

/** ACARS OCR quality: how many label values are among the OCR words of each picture (services/acars.js alignAcars). */
async function scoreAcars(linesDir, names, suffix) {
	const tot = { found: 0, total: 0 };
	const perImage = {};
	for (const n of names) {
		const lines = readJson(path.join(linesDir, `${n}${suffix}`));
		const { width, height } = await sharp(acarsFile(n)).metadata();
		const label = readJson(labelFile(ACARS_LABELS_ROOT, n));
		const st = alignAcars(acarsWordPages(lines, width, height), label);
		const total = st.found + st.missing.length;
		perImage[n] = { found: st.found, total };
		tot.found += st.found; tot.total += total;
	}
	return { ...tot, perImage };
}

/**
 * The PaddleOCR base model the training starts from (<work>/pretrained): mirrored from MinIO
 * (models/pretrained/, put there with npm run models:archive -- push), as the work folder can be cleared.
 */
async function ensurePretrained() {
	const need = path.join(PRETRAINED_DIR, 'en_PP-OCRv3_rec_train', 'best_accuracy.pdparams');
	if (fs.existsSync(need)) return;
	console.log('Getting the pretrained base model from MinIO (models/pretrained/) ...');
	try { await syncPrefix('models/pretrained/', PRETRAINED_DIR, { force: true }); } catch (e) { console.log('  ' + e.message); }
	if (!fs.existsSync(need)) throw new Error('The pretrained model is missing (' + rel(need) + '): see README, Recognition model versions, to download it, then npm run models:archive -- push <folder> models/pretrained/en_PP-OCRv3_rec_train/');
}

function gpuEnv(extra = {}) {
	const nvRoot = path.join(ROOT, '.venv', IS_WIN ? 'Lib/site-packages/nvidia' : 'lib/python3.11/site-packages/nvidia');
	const bins = fs.existsSync(nvRoot)
		? fs.readdirSync(nvRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(nvRoot, d.name, 'bin')).filter(fs.existsSync)
		: [];
	return { ...process.env, PATH: [...bins, process.env.PATH || ''].join(path.delimiter), PYTHONIOENCODING: 'utf-8', ...extra };
}

function run(cmd, args, { env, logFile } = {}) {
	return new Promise((resolve, reject) => {
		const out = logFile ? fs.openSync(logFile, 'a') : 'inherit';
		// Close our handle on the log when the child is done: an open train.log kept
		// Windows from renaming _pending -> vN at the end (EPERM, 2026-10-07).
		const closeLog = () => { if (typeof out === 'number') try { fs.closeSync(out); } catch { /* already closed */ } };
		const p = spawn(cmd, args, { cwd: ROOT, env: env || process.env, stdio: ['ignore', out, out] });
		p.on('error', (e) => { closeLog(); reject(e); });
		p.on('exit', (code) => {
			closeLog();
			if (code === 0) resolve();
			else reject(new Error(`${path.basename(cmd)} exited with ${code}${logFile ? ` (see ${rel(logFile)})` : ''}`));
		});
	});
}

/** OCR every image in `names` with the model in `inferDir`, caching each
 * result as <outDir>/<name><suffix>; a temporary OCR server is started only
 * if something is missing. */
async function ocrMissing(inferDir, names, outDir, suffix, fileOf = (n) => dataFile(FAKE_DATA, n)) {
	fs.mkdirSync(outDir, { recursive: true });
	const todo = names.filter(n => !fs.existsSync(path.join(outDir, `${n}${suffix}`)));
	if (!todo.length) return;
	console.log(`      OCR ${todo.length} image(s) with ${rel(inferDir)} ...`);
	const prog = { done: 0, serverUp: false };
	await withStatus(ocrImages(inferDir, todo, outDir, suffix, prog, fileOf), (ms) => (prog.serverUp
		? { fraction: prog.done / todo.length, text: `OCR ${prog.done}/${todo.length} images  (${fmtDur(ms)})` }
		: { text: `starting OCR server ... (${fmtDur(ms)})` }));
}

async function ocrImages(inferDir, todo, outDir, suffix, prog, fileOf) {
	const server = spawn(PY, ['-u', path.join(ROOT, 'src', 'scripts', 'ocr_server.py')], {
		cwd: ROOT,
		env: gpuEnv({ OCR_SERVER_PORT: String(PORT), OCR_CUSTOM_REC: inferDir, OCR_TEXT_DET_LIMIT_SIDE_LEN: String(DET_LIMIT), OCR_FAST_MODE: '1', OCR_WORKERS: '1' }),
		stdio: 'ignore',
	});
	try {
		const url = `http://127.0.0.1:${PORT}`;
		const t0 = Date.now();
		for (;;) {
			try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* starting */ }
			if (Date.now() - t0 > 300000) throw new Error(`OCR server on :${PORT} did not start`);
			await new Promise(r => setTimeout(r, 2000));
		}
		prog.serverUp = true;
		for (const n of todo) {
			const res = await fetch(`${url}/ocr`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: fileOf(n) }), signal: AbortSignal.timeout(300000),
			});
			const data = await res.json();
			if (!data?.ok) throw new Error(`OCR failed for ${n}: ${data?.error}`);
			fs.writeFileSync(path.join(outDir, `${n}${suffix}`), JSON.stringify(data.lines), 'utf8');
			prog.done++;
		}
	} finally {
		server.kill();
		await new Promise(r => setTimeout(r, 3000));
	}
}

/** Rows exactly right per image + totals, through the current parser. */
function score(linesDir, names) {
	const tot = { ok: 0, total: 0, published: [0, 0], planned: [0, 0] };
	const perImage = {};
	for (const n of names) {
		const pred = cleanExtractionResult(parseRoster(readJson(path.join(linesDir, `${n}.lines.json`))));
		const label = readJson(labelFile(LABELS, n));
		let ok = 0, total = 0;
		for (const s of ['published', 'planned']) {
			const r = compareSection(pred[s] || [], label[s] || []);
			ok += r.rowMatches; total += r.rowTotal;
			tot[s][0] += r.rowMatches; tot[s][1] += r.rowTotal;
		}
		perImage[n] = { ok, total };
		tot.ok += ok; tot.total += total;
	}
	return { ...tot, perImage };
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');

const fmtDur = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
		: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A status line refreshed every few seconds while `promise` runs: redrawn in
 * place on a terminal, one line per ~10% (or per minute) when piped to a file. */
async function withStatus(promise, describe) {
	const t0 = Date.now();
	const tty = process.stdout.isTTY;
	let lastPrinted = '', lastBucket = -1, lastMinute = 0;
	const draw = () => {
		const { text, fraction } = describe(Date.now() - t0) || {};
		if (!text) return;
		if (tty) {
			const bar = Number.isFinite(fraction) ? `[${'#'.repeat(Math.round(fraction * 20)).padEnd(20, '.')}] ` : '';
			const line = `      ${bar}${text}`;
			process.stdout.write(`\r${line.padEnd(Math.max(lastPrinted.length, line.length))}`);
			lastPrinted = line;
		} else {
			const bucket = Number.isFinite(fraction) ? Math.floor(fraction * 10) : -1;
			const minute = Math.floor((Date.now() - t0) / 60000);
			if (bucket !== lastBucket || minute >= lastMinute + 5) { console.log(`      ${text}`); lastBucket = bucket; lastMinute = minute; }
		}
	};
	const timer = setInterval(draw, 3000);
	try {
		return await promise;
	} finally {
		clearInterval(timer);
		draw();
		if (tty) process.stdout.write('\n');
		console.log(`      done in ${fmtDur(Date.now() - t0)}`);
	}
}

/** Progress of a running tools/train.py from the lines it appends to `log`
 * after byte `from`: epoch, step, % and PaddleOCR's own ETA. */
const itersPerEpoch = new Map(); // `${log}@${from}` -> iterations per epoch, once logged
function trainProgress(log, from, epochs) {
	let text = '';
	try {
		const fd = fs.openSync(log, 'r');
		try {
			const size = fs.fstatSync(fd).size;
			const start = Math.max(from, size - 64 * 1024);
			const buf = Buffer.alloc(size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			text = buf.toString('utf8');
		} finally { fs.closeSync(fd); }
	} catch { return null; }
	const key = `${log}@${from}`;
	if (!itersPerEpoch.has(key)) {
		const m = /train dataloader has (\d+) iters/.exec(fs.readFileSync(log, 'utf8').slice(from));
		if (m) itersPerEpoch.set(key, Number(m[1]));
	}
	const iters = itersPerEpoch.get(key) || null;
	const steps = [...text.matchAll(/epoch: \[(\d+)\/(\d+)], global_step: (\d+),.*?avg_batch_cost: ([\d.]+) s/g)];
	if (!steps.length) return { text: 'starting (loading model and data) ...' };
	const [, e, t, gs, batchCost] = steps[steps.length - 1];
	const epoch = Number(e), total = Number(t || epochs), step = Number(gs);
	if (!iters) return { fraction: (epoch - 1) / total, text: `epoch ${epoch}/${total}` };
	// global_step restarts at 0 when training resumes from a checkpoint (it is only
	// stored with an evaluation), so place the step within its epoch instead; and
	// PaddleOCR's own eta is wrong after a resume, so estimate it from batch cost.
	const inEpoch = ((step - 1) % iters) + 1;
	const done = (epoch - 1) * iters + inEpoch, all = iters * total;
	const fraction = Math.min(1, done / all);
	const eta = fmtDur((all - done) * Number(batchCost) * 1000);
	return { fraction, text: `epoch ${epoch}/${total}  step ${inEpoch}/${iters}  ${(100 * fraction).toFixed(1)}%  ETA ~${eta}` };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const current = deployedVersion();
	const curDir = path.join(REC_DIR, current);
	const curMeta = readJson(path.join(curDir, 'model.json'));
	const seen = new Set([...(curMeta.trainedOn || []), ...(curMeta.testedOn || [])].map(x => x.hash));
	const { names: labeledNames, canonical } = labeledRosters();
	const fresh = [...canonical].filter(([h]) => !seen.has(h)).map(([hash, name]) => ({ hash, name }));

	// ACARS pictures: a quarter of the ones the deployed model never saw test both models, the rest train
	const acarsAll = labeledAcars();
	const acarsSeen = new Set([...(curMeta.acarsTrainedOn || []), ...(curMeta.acarsTestedOn || [])].map(x => x.hash));
	const acarsFresh = [...acarsAll.keys()].filter(h => !acarsSeen.has(h)).sort();
	let acarsTestHashes = acarsFresh.filter(h => parseInt(h.slice(0, 2), 16) % 4 === 0);
	if (!acarsTestHashes.length && acarsFresh.length >= args.minNewAcars) acarsTestHashes = acarsFresh.slice(0, Math.ceil(acarsFresh.length / 4));
	const acarsTest = new Set(acarsFresh.length >= args.minNewAcars ? acarsTestHashes : []);
	const acarsTrain = [...acarsAll].filter(([h]) => !acarsTest.has(h)).map(([hash, name]) => ({ hash, name }));
	const acarsTestList = [...acarsAll].filter(([h]) => acarsTest.has(h)).map(([hash, name]) => ({ hash, name }));

	console.log(`Deployed model: ${current} (${curMeta.name || ''}, ${curMeta.createdAt || '?'})`);
	console.log(`Labeled rosters: ${canonical.size} distinct, ${fresh.length} never seen by ${current}${fresh.length ? ': ' + fresh.map(f => f.name).join(', ') : ''}`);
	console.log(`Labeled ACARS pictures: ${acarsAll.size} distinct, ${acarsFresh.length} never seen by ${current}`);
	const unlabeled = listData(FAKE_DATA, 'image').filter(n => !fs.existsSync(labelFile(LABELS, n)));
	if (unlabeled.length) console.log(`(${unlabeled.length} image(s) in fake-data still have no label — label them in /label to use them)`);
	if (args.status) return;
	// rosters: test on the new ones; with too few, train on all and check them all for a regression
	const rosterMode = fresh.length >= args.minNew ? 'unseen' : 'seen';
	if (rosterMode === 'seen' && !acarsTest.size) {
		console.log(`\nNot enough new rosters (${fresh.length} < ${args.minNew}) or new ACARS pictures (${acarsFresh.length} < ${args.minNewAcars}) to test a new version fairly. Label more, or pass --min-new=N / --min-new-acars=N.`);
		return;
	}
	if (rosterMode === 'seen') console.log(`Few new rosters: training on all ${canonical.size}; they are all scored to check the new version reads them no worse.`);

	// Work happens in PENDING (<work>/train/rec-pending); the version number is only assigned
	// when every step has finished, so an interrupted run never creates a vN.
	// A rerun resumes the pending run if it is for the same deployed model, the
	// same test rosters and the same epochs (finished steps are skipped).
	const testHashes = new Set(rosterMode === 'unseen' ? fresh.map(f => f.hash) : []);
	const trainSet = [...canonical].filter(([h]) => !testHashes.has(h)).map(([hash, name]) => ({ hash, name }));
	const rosterTest = rosterMode === 'unseen' ? fresh : [...canonical].map(([hash, name]) => ({ hash, name }));

	// Same deployed model, same train and test rosters, same epochs as a finished
	// version: training again would only repeat it (~1 h): after a rejected vN
	// the same test rosters stay "unseen" (2026-10-07). Label more rosters or pass --force.
	const key = (list) => (list || []).map(x => x.hash).sort().join(',');
	const repeatOf = listVersions().map(v => ({ v, m: fs.existsSync(path.join(REC_DIR, v, 'model.json')) ? readJson(path.join(REC_DIR, v, 'model.json')) : null }))
		.find(({ m }) => m?.comparison?.against === current && m.recipe?.epochs === args.epochs
			&& (m.recipe?.fineTunedFrom || null) === (args.fineTune ? current : null)
			&& key(m.testedOn) === key(rosterMode === 'unseen' ? fresh : []) && key(m.trainedOn) === key(trainSet)
			&& key(m.acarsTestedOn) === key(acarsTestList) && key(m.acarsTrainedOn) === key(acarsTrain));
	if (repeatOf && !args.force && !fs.existsSync(PENDING)) {
		const c = repeatOf.m.comparison;
		console.log(`
This exact run was already done as ${repeatOf.v} (${repeatOf.m.createdAt}): ${c.verdict}, `
			+ `${c[repeatOf.v]?.rowsCorrect}/${c[repeatOf.v]?.rows} vs ${current} ${c[current]?.rowsCorrect}/${c[current]?.rows} rows correct.`);
		console.log('Nothing new to learn from: label more rosters first, or pass --force to train it again anyway.');
		return;
	}
	const pDir = PENDING;
	const datasetDir = path.join(EXPORTS_DIR, 'recognition-groundtruth', 'rec-pending');
	const newLines = path.join(CACHE_DIR, 'rec-lines', '_pending');
	const statePath = path.join(pDir, 'pending.json');
	const basis = { basedOn: current, testHashes: [...testHashes].sort(), acarsTestHashes: [...acarsTest].sort(), epochs: args.epochs, fineTune: args.fineTune };
	let state = fs.existsSync(statePath) ? readJson(statePath) : null;
	const sameBasis = state && state.basedOn === basis.basedOn && state.epochs === basis.epochs && !!state.fineTune === basis.fineTune
		&& JSON.stringify(state.testHashes) === JSON.stringify(basis.testHashes)
		&& JSON.stringify(state.acarsTestHashes || []) === JSON.stringify(basis.acarsTestHashes);
	if (fs.existsSync(pDir) && (!sameBasis || args.restart)) {
		console.log(`\nDiscarding unfinished run (${args.restart ? '--restart' : 'it was for a different model / rosters / epochs'}).`);
		for (const d of [pDir, datasetDir, newLines]) fs.rmSync(d, { recursive: true, force: true });
		state = null;
	}
	if (!state) {
		fs.mkdirSync(pDir, { recursive: true });
		state = { ...basis, startedAt: new Date().toISOString(), done: {} };
		writeJson(statePath, state);
	}
	const markDone = (step) => { state.done[step] = new Date().toISOString(); writeJson(statePath, state); };
	const log = path.join(pDir, 'train.log');
	const foldMapPath = path.join(pDir, 'split.json');
	const cfg = path.join(pDir, 'train.yml');
	const inferDir = path.join(pDir, 'infer');
	const recipe = { template: 'models/rec/train-template.yml', epochs: args.epochs, general: 'table', tightCrops: true, linesDir: rel(STOCK_LINES), exportedCheckpoint: 'latest', evalDuringTraining: false,
		acars: { linesDir: rel(STOCK_ACARS_LINES), repeat: args.acarsRepeat },
		...(args.fineTune ? { fineTunedFrom: current } : {}), ...(args.lr ? { learningRate: args.lr } : {}) };
	const resumed = Object.keys(state.done);
	console.log(`\n=== New version: train on ${trainSet.length} rosters + ${acarsTrain.length} ACARS pictures; `
		+ `test on ${rosterMode === 'unseen' ? `${fresh.length} new rosters` : `all ${rosterTest.length} rosters (regression check)`} + ${acarsTestList.length} new ACARS pictures (log: ${rel(log)}) ===`);
	if (resumed.length) console.log(`Resuming unfinished run from ${state.startedAt.slice(0, 16).replace('T', ' ')}; already done: ${resumed.join(', ')}`);

	// 1. Dataset (stock-recognizer OCR lines; test rosters go to the val split).
	if (!state.done.dataset) {
		console.log('[1/4] Building dataset ...');
		await ocrMissing(path.join(REC_DIR, 'stock', 'infer'), [...canonical.values()], STOCK_LINES, '.json');
		writeJson(foldMapPath, Object.fromEntries(labeledNames.map(n => [n, testHashes.has(md5File(dataFile(FAKE_DATA, n))) ? 1 : 0])));
		await withStatus(run('node', [path.join(ROOT, 'src', 'scripts', 'ocr-groundtruth.mjs'), `--id=${path.basename(datasetDir)}`, '--folds=2', '--fold=1',
			`--fold-map=${foldMapPath}`, `--general=${recipe.general}`, '--tight-crops', `--lines-dir=${STOCK_LINES}`], { logFile: log }),
		(ms) => ({ text: `cropping labeled rows into training images ... (${fmtDur(ms)})` }));
		// ACARS: OCR lines with the stock recognizer too, then crops of the lines whose true text is known
		await ocrMissing(path.join(REC_DIR, 'stock', 'infer'), [...acarsAll.values()], STOCK_ACARS_LINES, '.json', acarsFile);
		const acarsTestFile = path.join(pDir, 'acars-test.json');
		writeJson(acarsTestFile, [...acarsTest]);
		await withStatus(run('node', [path.join(ROOT, 'src', 'scripts', 'ocr-acars-crops.mjs'), `--dataset=${datasetDir}`, `--lines-dir=${STOCK_ACARS_LINES}`,
			`--test=${acarsTestFile}`, `--repeat=${args.acarsRepeat}`], { logFile: log }),
		(ms) => ({ text: `cropping ACARS lines into training images ... (${fmtDur(ms)})` }));
		markDone('dataset');
	} else console.log('[1/4] Dataset: done earlier');

	await ensurePretrained();
	// Fine-tune: the deployed version's weights are the start. Its training checkpoint is usually not kept,
	// so they are rebuilt from its exported model (scripts/rec_infer_to_train.py; the SAR head, which an
	// exported model has not, comes from the stock weights).
	const initWeights = path.join(pDir, 'init');
	if (args.fineTune && !state.done.init) {
		console.log(`[2/4] Weights of ${current} as the starting point ...`);
		await run(PY, ['-u', path.join(ROOT, 'src', 'scripts', 'rec_infer_to_train.py'), path.join(curDir, 'train.yml'), path.join(curDir, 'infer'),
			path.join(PRETRAINED_DIR, 'en_PP-OCRv3_rec_train', 'best_accuracy.pdparams'), `${initWeights}.pdparams`], { env: gpuEnv(), logFile: log });
		markDone('init');
	}
	// 2. Train with the deployed model's recipe.
	if (!state.done.train) {
		// No evaluation during training: its only output is best_accuracy, which is
		// never exported (the last epoch is), and it took ~17 of 78 min plus a
		// model save per improvement (v6, 2026-10-07). The trained weights are the same.
		fs.writeFileSync(cfg, fs.readFileSync(TEMPLATE, 'utf8')
			.replace(/__SAVE_DIR__/g, ymlPath(path.join(pDir, 'checkpoint')))
			.replace(/__DATASET_DIR__/g, ymlPath(datasetDir))
			.replace(/__PRETRAINED__/g, ymlPath(PRETRAINED_DIR))
			.replace(/^(\s*pretrained_model:\s*).*$/m, (l, k) => (args.fineTune ? `${k}${ymlPath(initWeights)}` : l))
			.replace(/^(\s*learning_rate:\s*).*$/m, (l, k) => (args.lr ? `${k}${args.lr}` : l))
			.replace(/^(\s*warmup_epoch:\s*).*$/m, (l, k) => (args.fineTune ? `${k}0` : l))
			.replace(/^(\s*epoch_num:\s*).*$/m, `$1${args.epochs}`)
			.replace(/^(\s*eval_batch_step:\s*).*$/m, '$1[0, 100000000]'), 'utf8');
		// An interrupted run continues from the last finished epoch instead of epoch 1.
		const latest = path.join(pDir, 'checkpoint', 'latest');
		const resumeFrom = fs.existsSync(`${latest}.pdparams`) && fs.existsSync(`${latest}.states`) ? latest : null;
		console.log(`[2/4] Training (${args.epochs} epochs${args.fineTune ? `, fine-tuning ${current}` : ''}, ~${Math.max(5, Math.round(args.epochs * 3))} min on this machine)${resumeFrom ? ', resuming from the last saved epoch' : ''} ...`);
		const logFrom = fs.existsSync(log) ? fs.statSync(log).size : 0;
		await withStatus(run(PY, ['-u', path.join(PADDLEOCR_PKG, 'tools', 'train.py'), '-c', cfg,
			...(resumeFrom ? ['-o', `Global.checkpoints=${resumeFrom}`] : [])], { env: gpuEnv(), logFile: log }),
		(ms) => { const p = trainProgress(log, logFrom, args.epochs); return p && { ...p, text: `${p.text}  (elapsed ${fmtDur(ms)})` }; });
		markDone('train');
	} else console.log('[2/4] Training: done earlier');

	// 3. Export the last epoch (best_accuracy would be picked on the test crops).
	if (!state.done.export) {
		console.log('[3/4] Exporting ...');
		fs.rmSync(inferDir, { recursive: true, force: true });
		await withStatus(run(PY, ['-u', path.join(PADDLEOCR_PKG, 'tools', 'export_model.py'), '-c', cfg,
			'-o', `Global.pretrained_model=${path.join(pDir, 'checkpoint', 'latest')}`, `Global.save_inference_dir=${inferDir}`], { env: gpuEnv(), logFile: log }),
		(ms) => ({ text: `exporting the last epoch ... (${fmtDur(ms)})` }));
		if (md5File(path.join(inferDir, 'inference.pdiparams')) === md5File(path.join(REC_DIR, 'stock', 'infer', 'inference.pdiparams'))) {
			throw new Error('export produced the stock weights (checkpoint override ignored)');
		}
		markDone('export');
	} else console.log('[3/4] Export: done earlier');

	// 4. Score both models on the new rosters.
	console.log(`[4/4] Scoring ${current} and the new model on ${rosterTest.length} rosters and ${acarsTestList.length} ACARS pictures ...`);
	const testNames = rosterTest.map(f => f.name);
	const curLines = path.join(CACHE_DIR, 'rec-lines', current);
	await ocrMissing(path.join(curDir, 'infer'), testNames, curLines, '.lines.json');
	await ocrMissing(inferDir, testNames, newLines, '.lines.json');
	const a = score(curLines, testNames);
	const b = score(newLines, testNames);
	const acarsNames = acarsTestList.map(f => f.name);
	await ocrMissing(path.join(curDir, 'infer'), acarsNames, curLines, '.acars.lines.json', acarsFile);
	await ocrMissing(inferDir, acarsNames, newLines, '.acars.lines.json', acarsFile);
	const ac = await scoreAcars(curLines, acarsNames, '.acars.lines.json');
	const bc = await scoreAcars(newLines, acarsNames, '.acars.lines.json');

	// Every step finished: only now does the run become the next version.
	const next = `v${Math.max(...listVersions().map(v => Number(v.slice(1)))) + 1}`;
	const vDir = path.join(REC_DIR, next);
	const finalDataset = path.join(EXPORTS_DIR, 'recognition-groundtruth', `rec-${next}`);
	const finalLines = path.join(CACHE_DIR, 'rec-lines', next);
	// Windows keeps a just-stopped OCR server's model files locked for a moment
	// (EPERM/EBUSY on rename), so retry; pending.json goes only after it moved.
	const renameRetry = async (from, to) => {
		for (let i = 0; ; i++) {
			try { fs.renameSync(from, to); return; } catch (e) {
				if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 20) throw e;
				await new Promise(r => setTimeout(r, 1500));
			}
		}
	};
	await renameRetry(pDir, vDir);
	fs.rmSync(path.join(vDir, 'pending.json'), { force: true });
	if (!args.keepCheckpoint) fs.rmSync(path.join(vDir, 'checkpoint'), { recursive: true, force: true }); // 750 MB, only needed to resume training
	for (const [from, to] of [[datasetDir, finalDataset], [newLines, finalLines]]) {
		fs.rmSync(to, { recursive: true, force: true });
		if (fs.existsSync(from)) await renameRetry(from, to);
	}
	const finalCfg = path.join(vDir, 'train.yml');
	if (fs.existsSync(finalCfg)) {
		fs.writeFileSync(finalCfg, fs.readFileSync(finalCfg, 'utf8').split(ymlPath(pDir)).join(ymlPath(vDir))
			.split('recognition-groundtruth/rec-pending').join(`recognition-groundtruth/rec-${next}`), 'utf8');
	}

	const diff = b.ok - a.ok;
	const margin = Math.max(3, Math.round(0.005 * a.total));
	const rosterVerdict = diff >= margin ? 'better' : diff <= -margin ? 'worse' : 'tie';
	const acarsDiff = bc.found - ac.found;
	// rosters first: never better if they are read worse; ACARS decide when the rosters tie (or were only a regression check)
	const verdict = rosterVerdict === 'worse' || acarsDiff < -1 ? 'worse'
		: rosterVerdict === 'better' || acarsDiff >= 2 ? 'better' : 'tie';
	const wins = testNames.filter(n => b.perImage[n].ok > a.perImage[n].ok).length;
	const losses = testNames.filter(n => b.perImage[n].ok < a.perImage[n].ok).length;
	const meta = {
		version: next, createdAt: new Date().toISOString().slice(0, 10), status: verdict === 'better' ? 'candidate' : 'rejected',
		recipe, dataset: rel(finalDataset), split: `models/rec/${next}/split.json`,
		trainedOn: trainSet.sort((x, y) => x.name.localeCompare(y.name)),
		testedOn: (rosterMode === 'unseen' ? fresh : []).sort((x, y) => x.name.localeCompare(y.name)),
		acarsTrainedOn: acarsTrain.sort((x, y) => x.name.localeCompare(y.name)),
		acarsTestedOn: acarsTestList.sort((x, y) => x.name.localeCompare(y.name)),
		comparison: {
			against: current, rosters: rosterTest.length, rosterMode, rosterVerdict, verdict, margin,
			acars: { pictures: acarsNames.length, [current]: { found: ac.found, total: ac.total }, [next]: { found: bc.found, total: bc.total },
				perImage: Object.fromEntries(acarsNames.map(n => [n, { [current]: ac.perImage[n].found, [next]: bc.perImage[n].found, total: ac.perImage[n].total }])) },
			[current]: { rowsCorrect: a.ok, rows: a.total, published: a.published, planned: a.planned },
			[next]: { rowsCorrect: b.ok, rows: b.total, published: b.published, planned: b.planned },
			perImage: Object.fromEntries(testNames.map(n => [n, { [current]: a.perImage[n].ok, [next]: b.perImage[n].ok, rows: a.perImage[n].total }])),
		},
	};
	writeJson(path.join(vDir, 'model.json'), meta);
	const uploaded = await publishRec(next, { withCheckpoint: args.keepCheckpoint }); // MinIO models/rec/<next>/
	console.log(`Uploaded ${next} to MinIO (${uploaded} files${args.keepCheckpoint ? ', with its checkpoint' : ''}).`);

	console.log(`\n=== Result on ${rosterTest.length} rosters ${rosterMode === 'unseen' ? 'neither model trained on' : '(both models trained on them: a regression check)'} ===`);
	console.log(`               ${current.padEnd(10)} ${next}`);
	console.log(`rows correct   ${`${a.ok}/${a.total}`.padEnd(10)} ${b.ok}/${b.total}   (${pct(a.ok, a.total)} -> ${pct(b.ok, b.total)})`);
	console.log(`published      ${pct(...a.published).padEnd(10)} ${pct(...b.published)}`);
	console.log(`planned        ${pct(...a.planned).padEnd(10)} ${pct(...b.planned)}`);
	console.log(`per roster: ${next} better on ${wins}, worse on ${losses}, same on ${testNames.length - wins - losses}`);
	console.log(`ACARS values read (${acarsNames.length} pictures neither model trained on): ${current} ${ac.found}/${ac.total} (${pct(ac.found, ac.total)}) -> ${next} ${bc.found}/${bc.total} (${pct(bc.found, bc.total)})`);
	console.log(`\nVerdict: ${next} is ${verdict.toUpperCase()} (rosters ${diff >= 0 ? '+' : ''}${diff} rows, needs >= ${margin} to count; ACARS ${acarsDiff >= 0 ? '+' : ''}${acarsDiff} values)`);
	if (verdict === 'better') console.log(`Switch with:  npm run ocr:use-model -- ${next}   (then restart npm run ocr:server)`);
	else console.log(`Keep ${current}. ${next} stays in MinIO (models/rec/${next}/) for the record.`);
	console.log(`Saved: models/rec/${next}/model.json in MinIO (mirror: ${rel(path.join(vDir, 'model.json'))})`);
}

main().catch(err => {
	console.error(`\nocr:train failed: ${err.message}`);
	console.error('No version was created. Run `npm run ocr:train` again to resume (finished steps are skipped), or add --restart to start over.');
	process.exit(1);
});
