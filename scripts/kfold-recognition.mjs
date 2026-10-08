#!/usr/bin/env node
/**
 * K-fold evaluation of a recognition TRAINING RECIPE.
 *
 * Why: fake-data/ holds 75 unique images but only ~40 distinct rosters
 * (consecutive weekly screenshots share ~3/4 of their rows), so a single
 * 80/20 split leaves ~9 val images, 4 of which have a near-twin in train
 * (2026-09-29). Here every image is scored exactly once by a model that never
 * saw its roster: folds come from utils/content-groups.js rosterClusters +
 * assignFolds, and each fold's model is scored with the REAL pipeline
 * (services/benchmark.js, split='val' of the same fold) on a temporary OCR
 * server — VLM fallback disabled so Gemini can't stand in for OCR.
 *
 * Per fold k:
 *   1. build  exports/recognition-groundtruth/<id>-f<k>   (val = fold k)
 *   2. train  models/kfold/<id>-f<k>/                      (from --config template)
 *   3. export models/kfold/<id>-f<k>-infer/
 *   4. score  held-out fold with that model (+ --baseline-rec models, if given)
 * Results: exports/kfold/<id>/results.json (resumable: finished steps are skipped).
 *
 * The split is computed ONCE and saved as exports/kfold/<id>/folds.json
 * (image name -> fold); the dataset builder and the scoring benchmark both
 * read that file. Before 2026-10-01 each recomputed it and they disagreed
 * (different duplicate-copy choice), so about half of each scored fold had
 * been in that fold's training set. --fold-map=<file> reuses a saved split,
 * e.g. to compare a new recipe on exactly the folds of an older run.
 * --fold-baselines=label=models/kfold/old-f{k}-infer scores an older run's
 * fold-k model on fold k (a real held-out baseline for a recipe change).
 *
 * Usage:
 *   node --env-file=.env scripts/kfold-recognition.mjs --id=tight --folds=5 --epochs=25 \
 *     --config=models/rec/train-template.yml --lines-dir=cache/ocr-det1920-stock \
 *     --build-args="--general=table --tight-crops" \
 *     --baseline-rec=models/rec/v2/infer,models/rec/v3/infer
 * Note: a baseline trained on the old 80/20 split has seen ~80% of each fold,
 * so beating it here is a conservative result, not a like-for-like one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { groupByContent, pickCanonicalLabels, rosterClusters, assignFolds } from '../utils/content-groups.js';

const ROOT = process.cwd();
const IS_WIN = process.platform === 'win32';
const PY = path.join(ROOT, '.venv', IS_WIN ? 'Scripts/python.exe' : 'bin/python');
const PADDLEOCR_PKG = path.join(ROOT, '.venv', IS_WIN ? 'Lib/site-packages/paddleocr' : 'lib/python3.11/site-packages/paddleocr');
const PORT = Number(process.env.KFOLD_OCR_PORT || 8503);

function parseArgs(argv) {
	const args = { folds: 5, epochs: 25, detLimit: 1920, config: 'models/rec/train-template.yml', buildArgs: '', baselineRec: [], foldBaselines: [], only: null };
	for (const a of argv) {
		const m = /^--([^=]+)=(.*)$/.exec(a);
		if (!m) continue;
		if (m[1] === 'id') args.id = m[2];
		else if (m[1] === 'folds') args.folds = Number(m[2]);
		else if (m[1] === 'epochs') args.epochs = Number(m[2]);
		else if (m[1] === 'det-limit') args.detLimit = Number(m[2]);
		else if (m[1] === 'config') args.config = m[2];
		else if (m[1] === 'lines-dir') args.linesDir = m[2];
		else if (m[1] === 'build-args') args.buildArgs = m[2];
		else if (m[1] === 'baseline-rec') args.baselineRec = m[2].split(',').filter(Boolean);
		else if (m[1] === 'only') args.only = m[2].split(',').map(Number);
		else if (m[1] === 'fold-map') args.foldMap = m[2];
		else if (m[1] === 'fold-baselines') args.foldBaselines = m[2].split(',').filter(Boolean).map(x => x.split('='));
	}
	if (!args.id) throw new Error('--id is required');
	return args;
}

function gpuLibPath() {
	const nvRoot = path.join(ROOT, '.venv', IS_WIN ? 'Lib/site-packages/nvidia' : 'lib/python3.11/site-packages/nvidia');
	if (!fs.existsSync(nvRoot)) return '';
	return fs.readdirSync(nvRoot, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => path.join(nvRoot, d.name, 'bin'))
		.filter(fs.existsSync)
		.join(path.delimiter);
}

function withGpuPath(env = {}) {
	const lib = gpuLibPath();
	return { ...process.env, ...env, PATH: lib ? `${lib}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH };
}

function run(cmd, args, env) {
	return new Promise((resolve, reject) => {
		console.log(`\n$ ${cmd} ${args.join(' ')}`);
		const child = spawn(cmd, args, { stdio: 'inherit', env: env || process.env });
		child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
		child.on('error', reject);
	});
}

/** Training yml for one fold: the template with data/save paths and epochs swapped. */
function writeFoldConfig(template, datasetDir, saveDir, epochs, outPath) {
	const rel = (p) => `./${path.relative(ROOT, p).replace(/\\/g, '/')}`;
	let y = fs.readFileSync(template, 'utf8');
	y = y.replace(/^(\s*epoch_num:\s*).*$/m, `$1${epochs}`)
		.replace(/^(\s*save_model_dir:\s*).*$/m, `$1${rel(saveDir)}`)
		.replace(/^(\s*save_res_path:\s*).*$/m, `$1${rel(saveDir)}/predicts.txt`)
		.replace(/^(\s*data_dir:\s*).*$/gm, `$1${rel(datasetDir)}`)
		.replace(/^(\s*-\s*)\S*train_list\.txt\s*$/m, `$1${rel(datasetDir)}/train_list.txt`)
		.replace(/^(\s*-\s*)\S*val_list\.txt\s*$/m, `$1${rel(datasetDir)}/val_list.txt`);
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, y, 'utf8');
}

/** Guard against exporting the pretrained model instead of the checkpoint
 * (what the double -o bug did silently): compare with the stock export. */
function assertNotStockExport(inferDir) {
	const stock = path.join(ROOT, 'models', 'rec', 'stock', 'infer', 'inference.pdiparams');
	if (!fs.existsSync(stock)) return;
	const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
	if (md5(stock) === md5(path.join(inferDir, 'inference.pdiparams'))) {
		throw new Error(`${inferDir} is byte-identical to the stock pretrained model — the export ignored the checkpoint`);
	}
}

async function waitHealthy(url, ms = 240000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* not up yet */ }
		await new Promise(r => setTimeout(r, 2000));
	}
	throw new Error(`OCR server at ${url} did not come up`);
}

/** Score one rec model on one held-out fold through the real pipeline. */
async function scoreFold({ recDir, fold, folds, foldMap, detLimit, runBenchmark }) {
	const url = `http://127.0.0.1:${PORT}`;
	const server = spawn(PY, ['-u', path.join(ROOT, 'scripts', 'ocr_server.py')], {
		env: withGpuPath({ OCR_SERVER_PORT: String(PORT), OCR_CUSTOM_REC: recDir, OCR_TEXT_DET_LIMIT_SIDE_LEN: String(detLimit), OCR_FAST_MODE: '1' }),
		stdio: 'ignore',
	});
	try {
		await waitHealthy(url);
		const res = await runBenchmark({
			strategy: 'paddleocr',
			folderPath: path.join(ROOT, 'fake-data'),
			labelsPath: path.join(ROOT, 'labels'),
			dedupe: true, split: 'val', folds, fold, foldMap,
		});
		const a = res.aggregate;
		return {
			images: res.processedCount,
			rowMatches: a.rowMatches, rowTotal: a.rowTotal,
			perSection: a.perSection,
			perField: Object.fromEntries(Object.entries(a.perField).map(([f, v]) => [f, { matches: v.matches, total: v.total }])),
			errors: res.files.filter(f => f.error).length,
		};
	} finally {
		server.kill();
		await new Promise(r => setTimeout(r, 3000));
	}
}

function sumResults(list) {
	const s = { images: 0, rowMatches: 0, rowTotal: 0, perSection: {}, perField: {} };
	for (const r of list) {
		s.images += r.images; s.rowMatches += r.rowMatches; s.rowTotal += r.rowTotal;
		for (const [sec, v] of Object.entries(r.perSection)) {
			s.perSection[sec] ??= { rowMatches: 0, rowTotal: 0, predRows: 0, expRows: 0 };
			for (const k of ['rowMatches', 'rowTotal', 'predRows', 'expRows']) s.perSection[sec][k] += v[k];
		}
		for (const [f, v] of Object.entries(r.perField)) {
			s.perField[f] ??= { matches: 0, total: 0 };
			s.perField[f].matches += v.matches; s.perField[f].total += v.total;
		}
	}
	const pct = (m, t) => (t ? +(100 * m / t).toFixed(1) : 0);
	return {
		...s,
		rowExact: pct(s.rowMatches, s.rowTotal),
		published: pct(s.perSection.published?.rowMatches, s.perSection.published?.rowTotal),
		planned: pct(s.perSection.planned?.rowMatches, s.perSection.planned?.rowTotal),
		fields: Object.fromEntries(Object.entries(s.perField).map(([f, v]) => [f, pct(v.matches, v.total)])),
	};
}

/** image name -> fold for every labeled image (all byte-identical copies of an
 * image share its fold), clustered exactly as the dataset builder does. */
function computeFoldMap(k) {
	const folder = path.join(ROOT, 'fake-data');
	const labels = path.join(ROOT, 'labels');
	const names = fs.readdirSync(folder).filter(n => fs.existsSync(path.join(labels, `${n}.json`)));
	const groups = groupByContent(folder, names);
	const { canonical } = pickCanonicalLabels(groups, labels);
	const foldOf = assignFolds(rosterClusters(canonical, labels), k);
	const map = {};
	for (const [id, members] of groups) for (const m of members) map[m] = foldOf.get(id);
	return map;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	// Before importing the pipeline: point it at the temp server and make sure
	// low-confidence images can't fall back to Gemini (would score the VLM).
	process.env.OCR_SERVER_URL = `http://127.0.0.1:${PORT}`;
	delete process.env.VLM_API_KEY;
	const { runBenchmark } = await import('../services/benchmark.js');

	const outDir = path.join(ROOT, 'exports', 'kfold', args.id);
	fs.mkdirSync(outDir, { recursive: true });
	const resultsPath = path.join(outDir, 'results.json');
	const results = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : { args, folds: {} };
	const save = () => fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf8');

	// One split for building AND scoring (see header).
	const foldMapPath = path.join(outDir, 'folds.json');
	if (args.foldMap) fs.copyFileSync(path.resolve(ROOT, args.foldMap), foldMapPath);
	else if (!fs.existsSync(foldMapPath)) fs.writeFileSync(foldMapPath, JSON.stringify(computeFoldMap(args.folds), null, 2), 'utf8');
	const foldMap = JSON.parse(fs.readFileSync(foldMapPath, 'utf8'));
	for (let k = 0; k < args.folds; k++) {
		if (!Object.values(foldMap).includes(k)) throw new Error(`fold map ${foldMapPath} has no image in fold ${k}`);
	}

	const folds = args.only || [...Array(args.folds).keys()];
	for (const k of folds) {
		const name = `${args.id}-f${k}`;
		const datasetDir = path.join(ROOT, 'exports', 'recognition-groundtruth', name);
		const saveDir = path.join(ROOT, 'models', 'kfold', name);
		const inferDir = `${saveDir}-infer`;
		const cfg = path.join(ROOT, 'models', 'kfold', `${name}.yml`);
		results.folds[k] ??= {};
		console.log(`\n========== fold ${k + 1}/${args.folds} (${name}) ==========`);

		if (!fs.existsSync(path.join(datasetDir, 'manifest.json'))) {
			const extra = args.buildArgs.split(/\s+/).filter(Boolean);
			if (args.linesDir) extra.push(`--lines-dir=${args.linesDir}`);
			await run('node', [path.join(ROOT, 'scripts', 'build-recognition-groundtruth.mjs'), `--id=${name}`, `--folds=${args.folds}`, `--fold=${k}`, `--fold-map=${foldMapPath}`, ...extra]);
		}
		if (!fs.existsSync(path.join(inferDir, 'inference.pdiparams'))) {
			writeFoldConfig(path.resolve(ROOT, args.config), datasetDir, saveDir, args.epochs, cfg);
			await run(PY, ['-u', path.join(PADDLEOCR_PKG, 'tools', 'train.py'), '-c', cfg], withGpuPath());
			await run(PY, ['-u', path.join(PADDLEOCR_PKG, 'tools', 'export_model.py'), '-c', cfg,
				// ONE -o with all overrides: tools/program.py declares -o with nargs='+',
				// so a second -o flag silently REPLACES the first — the checkpoint override
				// was dropped and the stock pretrained model got exported (found 2026-09-30).
				'-o', `Global.pretrained_model=${path.join(saveDir, 'best_accuracy')}`, `Global.save_inference_dir=${inferDir}`], withGpuPath());
			assertNotStockExport(inferDir);
		}
		for (const [label, recDir] of [
			['candidate', inferDir],
			...args.baselineRec.map(r => [path.basename(r), path.resolve(ROOT, r)]),
			...args.foldBaselines.map(([l, tpl]) => [l, path.resolve(ROOT, tpl.replace('{k}', String(k)))]),
		]) {
			if (results.folds[k][label]) continue;
			console.log(`\n--- scoring fold ${k} with ${label} ---`);
			results.folds[k][label] = await scoreFold({ recDir, fold: k, folds: args.folds, foldMap, detLimit: args.detLimit, runBenchmark });
			save();
		}
	}

	const labels = new Set(Object.values(results.folds).flatMap(f => Object.keys(f)));
	results.summary = {};
	for (const label of labels) {
		const done = Object.values(results.folds).map(f => f[label]).filter(Boolean);
		results.summary[label] = { foldsScored: done.length, ...sumResults(done) };
	}
	save();
	console.log('\n========== k-fold summary (each image scored by a model that never saw its roster) ==========');
	for (const [label, s] of Object.entries(results.summary)) {
		console.log(`${label.padEnd(40)} folds ${s.foldsScored}  images ${s.images}  rowExact ${s.rowExact}%  published ${s.published}%  planned ${s.planned}%  ${JSON.stringify(s.fields)}`);
	}
	console.log(`\nSaved: ${resultsPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
