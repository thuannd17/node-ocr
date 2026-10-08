#!/usr/bin/env node
/**
 * Train the next recognition model version and compare it with the deployed one.
 *
 *   npm run retrain-check                 # train v(N+1) if enough new rosters, then compare
 *   npm run retrain-check -- --status     # only report how many new rosters are waiting
 *   npm run retrain-check -- --min-new=3 --epochs=15 --keep-checkpoint
 *   npm run retrain-check -- --restart    # drop an unfinished run instead of resuming it
 *   npm run retrain-check -- --force      # train again even if this exact run was already done
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
 * printed; switch with `npm run use-model -- vN` if you agree.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { groupByContent, pickCanonicalLabels } from '../utils/content-groups.js';
import { parseRoster, cleanExtractionResult } from '../services/roster-parser.js';
import { compareSection } from '../services/benchmark.js';

const ROOT = process.cwd();
const IS_WIN = process.platform === 'win32';
const PY = path.join(ROOT, '.venv', IS_WIN ? 'Scripts/python.exe' : 'bin/python');
const PADDLEOCR_PKG = path.join(ROOT, '.venv', IS_WIN ? 'Lib/site-packages/paddleocr' : 'lib/python3.11/site-packages/paddleocr');
const REC_DIR = path.join(ROOT, 'models', 'rec');
const FAKE_DATA = path.join(ROOT, 'fake-data');
const LABELS = path.join(ROOT, 'labels');
const STOCK_LINES = path.join(ROOT, 'cache', 'ocr-det1920-stock'); // dataset builder input (stock recognizer)
const PORT = Number(process.env.RETRAIN_OCR_PORT || 8506);
const DET_LIMIT = Number(process.env.OCR_TEXT_DET_LIMIT_SIDE_LEN || 1920);

function parseArgs(argv) {
	const a = { minNew: 5, epochs: 15, keepCheckpoint: false, status: false };
	for (const x of argv) {
		if (x === '--status') a.status = true;
		else if (x === '--keep-checkpoint') a.keepCheckpoint = true;
		else if (x === '--restart') a.restart = true;
		else if (x === '--force') a.force = true;
		const m = /^--([^=]+)=(.*)$/.exec(x);
		if (m?.[1] === 'min-new') a.minNew = Number(m[2]);
		if (m?.[1] === 'epochs') a.epochs = Number(m[2]);
	}
	return a;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
const md5File = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

function listVersions() {
	return fs.readdirSync(REC_DIR).filter(d => /^v\d+$/.test(d)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The version the OCR server is configured to use (OCR_CUSTOM_REC=models/rec/vN/infer). */
function deployedVersion() {
	const m = /models[\\/]rec[\\/](v\d+)[\\/]infer/.exec(process.env.OCR_CUSTOM_REC || '');
	if (!m) throw new Error(`OCR_CUSTOM_REC (${process.env.OCR_CUSTOM_REC || 'unset'}) is not a models/rec/vN/infer version; run with --env-file=.env`);
	return m[1];
}

/** Labeled images, one per distinct content: Map hash -> file name. */
function labeledRosters() {
	const names = fs.readdirSync(FAKE_DATA).filter(n => fs.existsSync(path.join(LABELS, `${n}.json`)));
	const groups = groupByContent(FAKE_DATA, names);
	const { canonical } = pickCanonicalLabels(groups, LABELS);
	return { names, canonical };
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
async function ocrMissing(inferDir, names, outDir, suffix) {
	fs.mkdirSync(outDir, { recursive: true });
	const todo = names.filter(n => !fs.existsSync(path.join(outDir, `${n}${suffix}`)));
	if (!todo.length) return;
	console.log(`      OCR ${todo.length} image(s) with ${rel(inferDir)} ...`);
	const prog = { done: 0, serverUp: false };
	await withStatus(ocrImages(inferDir, todo, outDir, suffix, prog), (ms) => (prog.serverUp
		? { fraction: prog.done / todo.length, text: `OCR ${prog.done}/${todo.length} images  (${fmtDur(ms)})` }
		: { text: `starting OCR server ... (${fmtDur(ms)})` }));
}

async function ocrImages(inferDir, todo, outDir, suffix, prog) {
	const server = spawn(PY, ['-u', path.join(ROOT, 'scripts', 'ocr_server.py')], {
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
				body: JSON.stringify({ path: path.join(FAKE_DATA, n) }), signal: AbortSignal.timeout(300000),
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
		const label = readJson(path.join(LABELS, `${n}.json`));
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
	const steps = [...text.matchAll(/epoch: \[(\d+)\/(\d+)\], global_step: (\d+),.*?avg_batch_cost: ([\d.]+) s/g)];
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

	console.log(`Deployed model: ${current} (${curMeta.name || ''}, ${curMeta.createdAt || '?'})`);
	console.log(`Labeled rosters: ${canonical.size} distinct, ${fresh.length} never seen by ${current}${fresh.length ? ': ' + fresh.map(f => f.name).join(', ') : ''}`);
	const unlabeled = fs.readdirSync(FAKE_DATA).filter(n => !fs.existsSync(path.join(LABELS, `${n}.json`)));
	if (unlabeled.length) console.log(`(${unlabeled.length} image(s) in fake-data still have no label — label them in /label to use them)`);
	if (args.status) return;
	if (fresh.length < args.minNew) {
		console.log(`\nNot enough new rosters to test a new version fairly (${fresh.length} < ${args.minNew}). Label more, or pass --min-new=N.`);
		return;
	}

	// Work happens in models/rec/_pending; the version number is only assigned
	// when every step has finished, so an interrupted run never creates a vN.
	// A rerun resumes the pending run if it is for the same deployed model, the
	// same test rosters and the same epochs (finished steps are skipped).
	const testHashes = new Set(fresh.map(f => f.hash));
	const trainSet = [...canonical].filter(([h]) => !testHashes.has(h)).map(([hash, name]) => ({ hash, name }));

	// Same deployed model, same train and test rosters, same epochs as a finished
	// version: training again would only repeat it (~1 h): after a rejected vN
	// the same test rosters stay "unseen" (2026-10-07). Label more rosters or pass --force.
	const key = (list) => (list || []).map(x => x.hash).sort().join(',');
	const repeatOf = listVersions().map(v => ({ v, m: fs.existsSync(path.join(REC_DIR, v, 'model.json')) ? readJson(path.join(REC_DIR, v, 'model.json')) : null }))
		.find(({ m }) => m?.comparison?.against === current && m.recipe?.epochs === args.epochs
			&& key(m.testedOn) === key(fresh) && key(m.trainedOn) === key(trainSet));
	if (repeatOf && !args.force && !fs.existsSync(path.join(REC_DIR, '_pending'))) {
		const c = repeatOf.m.comparison;
		console.log(`
This exact run was already done as ${repeatOf.v} (${repeatOf.m.createdAt}): ${c.verdict}, `
			+ `${c[repeatOf.v]?.rowsCorrect}/${c[repeatOf.v]?.rows} vs ${current} ${c[current]?.rowsCorrect}/${c[current]?.rows} rows correct.`);
		console.log('Nothing new to learn from: label more rosters first, or pass --force to train it again anyway.');
		return;
	}
	const pDir = path.join(REC_DIR, '_pending');
	const datasetDir = path.join(ROOT, 'exports', 'recognition-groundtruth', 'rec-pending');
	const newLines = path.join(ROOT, 'cache', 'rec-lines', '_pending');
	const statePath = path.join(pDir, 'pending.json');
	const basis = { basedOn: current, testHashes: [...testHashes].sort(), epochs: args.epochs };
	let state = fs.existsSync(statePath) ? readJson(statePath) : null;
	const sameBasis = state && state.basedOn === basis.basedOn && state.epochs === basis.epochs
		&& JSON.stringify(state.testHashes) === JSON.stringify(basis.testHashes);
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
	const recipe = { template: 'models/rec/train-template.yml', epochs: args.epochs, general: 'table', tightCrops: true, linesDir: rel(STOCK_LINES), exportedCheckpoint: 'latest', evalDuringTraining: false };
	const resumed = Object.keys(state.done);
	console.log(`\n=== New version: train on ${trainSet.length} rosters, test on ${fresh.length} new ones (log: ${rel(log)}) ===`);
	if (resumed.length) console.log(`Resuming unfinished run from ${state.startedAt.slice(0, 16).replace('T', ' ')}; already done: ${resumed.join(', ')}`);

	// 1. Dataset (stock-recognizer OCR lines; test rosters go to the val split).
	if (!state.done.dataset) {
		console.log('[1/4] Building dataset ...');
		await ocrMissing(path.join(REC_DIR, 'stock', 'infer'), [...canonical.values()], STOCK_LINES, '.json');
		writeJson(foldMapPath, Object.fromEntries(labeledNames.map(n => [n, testHashes.has(md5File(path.join(FAKE_DATA, n))) ? 1 : 0])));
		await withStatus(run('node', [path.join(ROOT, 'scripts', 'build-recognition-groundtruth.mjs'), `--id=${path.basename(datasetDir)}`, '--folds=2', '--fold=1',
			`--fold-map=${foldMapPath}`, `--general=${recipe.general}`, '--tight-crops', `--lines-dir=${recipe.linesDir}`], { logFile: log }),
		(ms) => ({ text: `cropping labeled rows into training images ... (${fmtDur(ms)})` }));
		markDone('dataset');
	} else console.log('[1/4] Dataset: done earlier');

	// 2. Train with the deployed model's recipe.
	if (!state.done.train) {
		// No evaluation during training: its only output is best_accuracy, which is
		// never exported (the last epoch is), and it took ~17 of 78 min plus a
		// model save per improvement (v6, 2026-10-07). The trained weights are the same.
		fs.writeFileSync(cfg, fs.readFileSync(path.join(REC_DIR, 'train-template.yml'), 'utf8')
			.replace(/__SAVE_DIR__/g, `./${rel(path.join(pDir, 'checkpoint'))}`)
			.replace(/__DATASET_DIR__/g, `./${rel(datasetDir)}`)
			.replace(/^(\s*epoch_num:\s*).*$/m, `$1${args.epochs}`)
			.replace(/^(\s*eval_batch_step:\s*).*$/m, '$1[0, 100000000]'), 'utf8');
		// An interrupted run continues from the last finished epoch instead of epoch 1.
		const latest = path.join(pDir, 'checkpoint', 'latest');
		const resumeFrom = fs.existsSync(`${latest}.pdparams`) && fs.existsSync(`${latest}.states`) ? latest : null;
		console.log(`[2/4] Training (${args.epochs} epochs, ~45 min on this machine)${resumeFrom ? ', resuming from the last saved epoch' : ''} ...`);
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
	console.log(`[4/4] Scoring ${current} and the new model on the ${fresh.length} new rosters ...`);
	const testNames = fresh.map(f => f.name);
	const curLines = path.join(ROOT, 'cache', 'rec-lines', current);
	await ocrMissing(path.join(curDir, 'infer'), testNames, curLines, '.lines.json');
	await ocrMissing(inferDir, testNames, newLines, '.lines.json');
	const a = score(curLines, testNames);
	const b = score(newLines, testNames);

	// Every step finished: only now does the run become the next version.
	const next = `v${Math.max(...listVersions().map(v => Number(v.slice(1)))) + 1}`;
	const vDir = path.join(REC_DIR, next);
	const finalDataset = path.join(ROOT, 'exports', 'recognition-groundtruth', `rec-${next}`);
	const finalLines = path.join(ROOT, 'cache', 'rec-lines', next);
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
		fs.writeFileSync(finalCfg, fs.readFileSync(finalCfg, 'utf8').split('models/rec/_pending').join(`models/rec/${next}`)
			.split('recognition-groundtruth/rec-pending').join(`recognition-groundtruth/rec-${next}`), 'utf8');
	}

	const diff = b.ok - a.ok;
	const margin = Math.max(3, Math.round(0.005 * a.total));
	const verdict = diff >= margin ? 'better' : diff <= -margin ? 'worse' : 'tie';
	const wins = testNames.filter(n => b.perImage[n].ok > a.perImage[n].ok).length;
	const losses = testNames.filter(n => b.perImage[n].ok < a.perImage[n].ok).length;
	const meta = {
		version: next, createdAt: new Date().toISOString().slice(0, 10), status: verdict === 'better' ? 'candidate' : 'rejected',
		recipe, dataset: rel(finalDataset), split: rel(path.join(vDir, 'split.json')),
		trainedOn: trainSet.sort((x, y) => x.name.localeCompare(y.name)),
		testedOn: fresh.sort((x, y) => x.name.localeCompare(y.name)),
		comparison: {
			against: current, rosters: fresh.length, verdict, margin,
			[current]: { rowsCorrect: a.ok, rows: a.total, published: a.published, planned: a.planned },
			[next]: { rowsCorrect: b.ok, rows: b.total, published: b.published, planned: b.planned },
			perImage: Object.fromEntries(testNames.map(n => [n, { [current]: a.perImage[n].ok, [next]: b.perImage[n].ok, rows: a.perImage[n].total }])),
		},
	};
	writeJson(path.join(vDir, 'model.json'), meta);

	console.log(`\n=== Result on ${fresh.length} rosters neither model trained on ===`);
	console.log(`               ${current.padEnd(10)} ${next}`);
	console.log(`rows correct   ${`${a.ok}/${a.total}`.padEnd(10)} ${b.ok}/${b.total}   (${pct(a.ok, a.total)} -> ${pct(b.ok, b.total)})`);
	console.log(`published      ${pct(...a.published).padEnd(10)} ${pct(...b.published)}`);
	console.log(`planned        ${pct(...a.planned).padEnd(10)} ${pct(...b.planned)}`);
	console.log(`per roster: ${next} better on ${wins}, worse on ${losses}, same on ${fresh.length - wins - losses}`);
	console.log(`\nVerdict: ${next} is ${verdict.toUpperCase()} (${diff >= 0 ? '+' : ''}${diff} rows; needs >= ${margin} to count)`);
	if (verdict === 'better') console.log(`Switch with:  npm run use-model -- ${next}   (then restart npm run ocr-server)`);
	else console.log(`Keep ${current}. ${next} stays in ${rel(vDir)} for the record.`);
	console.log(`Saved: ${rel(path.join(vDir, 'model.json'))}`);
}

main().catch(err => {
	console.error(`\nretrain-check failed: ${err.message}`);
	console.error('No version was created. Run `npm run retrain-check` again to resume (finished steps are skipped), or add --restart to start over.');
	process.exit(1);
});
