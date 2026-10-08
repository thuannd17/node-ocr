/**
 * Content-based image grouping for dataset hygiene.
 *
 * fake-data/ holds many byte-identical copies of the same screenshot under
 * different names ("1 (10).jpeg" / "roster_46.jpeg", ...) — 144 files, 75 unique
 * images as of 2026-09-24. Treating each file as an independent sample:
 *   - leaks: the filename-hash train/val split put copies of one image on both
 *     sides (14 of 15 val files had an identical twin in train), and
 *   - double counts: benchmarks weigh duplicated images more, and
 *   - hides label noise: the copies were labeled separately and disagree
 *     (e.g. duty "C19" vs "CI9").
 * So every consumer that splits or scores by image should go through here:
 * group by content hash, pick one representative label per group, and split
 * by GROUP so copies always land on the same side.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FIELDS = ['duty', 'dep', 'arr'];

export function hashFileContent(filePath) {
	return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/** @returns {Map<string, string[]>} content-hash -> file names (sorted) */
export function groupByContent(dir, names) {
	const groups = new Map();
	for (const name of [...names].sort()) {
		const id = hashFileContent(path.join(dir, name));
		if (!groups.has(id)) groups.set(id, []);
		groups.get(id).push(name);
	}
	return groups;
}

function fnv1a(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
	return h >>> 0;
}

/** Deterministic train/val side for a whole group of identical images. */
export function splitByGroup(groupId, trainRatio = 0.9) {
	return fnv1a(groupId) % 1000 < Math.round(trainRatio * 1000) ? 'train' : 'val';
}

/**
 * Near-duplicate rosters: content hashing only catches byte-identical copies,
 * but consecutive weekly screenshots of the same crew roster share ~3 of 4
 * weeks of rows (2026-09-29: 75 unique images -> 40 rosters; the held-out
 * "1 (25).jpg" matched train "roster_67.jpg" on 96% of rows). Treat two
 * content groups as one cluster when at least `threshold` of the smaller
 * one's labeled rows (date|duty|dep|begin) also appear in the other, merged
 * transitively.
 *
 * @param {Map<string,string>} canonical content-group id -> representative file name
 * @returns {Map<string,string>} content-group id -> cluster id (a member group id)
 */
export function rosterClusters(canonical, labelsDir, threshold = 0.5) {
	const ids = [...canonical.keys()].sort();
	const keys = new Map(ids.map(id => [id, new Set((readRows(labelsDir, canonical.get(id)) || [])
		.map(r => ['date', 'duty', 'dep', 'begin'].map(f => String(r[f] || '').trim().toUpperCase()).join('|')))]));
	const parent = new Map(ids.map(id => [id, id]));
	const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
	for (let i = 0; i < ids.length; i += 1) {
		for (let j = i + 1; j < ids.length; j += 1) {
			const a = keys.get(ids[i]), b = keys.get(ids[j]);
			const small = a.size <= b.size ? a : b, big = small === a ? b : a;
			if (!small.size) continue;
			let hit = 0;
			for (const k of small) if (big.has(k)) hit += 1;
			if (hit / small.size >= threshold) {
				const ra = find(ids[i]), rb = find(ids[j]);
				if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
			}
		}
	}
	return new Map(ids.map(id => [id, find(id)]));
}

/**
 * K-fold assignment by cluster, balanced by image count: clusters largest
 * first (ties by hash), each to the fold with the fewest images so far.
 * Deterministic for a given label set.
 * @param {Map<string,string>} clusterOf content-group id -> cluster id
 * @returns {Map<string,number>} content-group id -> fold index 0..k-1
 */
export function assignFolds(clusterOf, k) {
	const members = new Map();
	for (const [gid, cid] of clusterOf) {
		if (!members.has(cid)) members.set(cid, []);
		members.get(cid).push(gid);
	}
	const clusters = [...members.entries()]
		.sort((a, b) => b[1].length - a[1].length || fnv1a(a[0]) - fnv1a(b[0]));
	const load = new Array(k).fill(0);
	const foldOf = new Map();
	for (const [, gids] of clusters) {
		let f = 0;
		for (let i = 1; i < k; i += 1) if (load[i] < load[f]) f = i;
		for (const gid of gids) foldOf.set(gid, f);
		load[f] += gids.length;
	}
	return foldOf;
}

function readRows(labelsDir, name) {
	try {
		const j = JSON.parse(fs.readFileSync(path.join(labelsDir, `${name}.json`), 'utf8'));
		return [...(j.published || []), ...(j.planned || [])];
	} catch {
		return null;
	}
}

/**
 * One representative per group. Copies of the same image were labeled
 * separately and can disagree, and nothing in the files says which pass was
 * reviewed. Heuristic: a cell value seen often across the whole label set is
 * more likely correct than a rare variant ("C19" appears hundreds of times,
 * "CI9" is an OCR slip), so score each copy by how common its duty/dep/arr
 * values are dataset-wide and take the highest; ties go to the first name.
 * Groups whose copies disagree are reported so a human can adjudicate.
 *
 * @returns {{ canonical: Map<string,string>, conflicts: Array<{groupId:string, members:string[], chosen:string, differingRows:number}> }}
 */
export function pickCanonicalLabels(groups, labelsDir) {
	const freq = Object.fromEntries(FIELDS.map(f => [f, new Map()]));
	for (const members of groups.values()) {
		for (const name of members) {
			for (const row of readRows(labelsDir, name) || []) {
				for (const f of FIELDS) {
					const v = String(row[f] || '').trim().toUpperCase();
					if (v) freq[f].set(v, (freq[f].get(v) || 0) + 1);
				}
			}
		}
	}
	// Mean over non-empty cells so a copy with more rows doesn't win by length.
	const score = (rows) => {
		let sum = 0, n = 0;
		for (const row of rows) {
			for (const f of FIELDS) {
				const v = String(row[f] || '').trim().toUpperCase();
				if (!v) continue;
				sum += Math.log(1 + (freq[f].get(v) || 0));
				n += 1;
			}
		}
		return n ? sum / n : 0;
	};
	const norm = (row) => ['date', 'day', 'duty', 'dep', 'begin', 'end', 'arr']
		.map(f => String(row[f] || '').trim().toUpperCase().replace(/\s+/g, ' ')).join('|');

	const canonical = new Map();
	const conflicts = [];
	for (const [groupId, members] of groups) {
		const labeled = members.map(name => ({ name, rows: readRows(labelsDir, name) })).filter(m => m.rows);
		if (!labeled.length) continue;
		let best = labeled[0];
		for (const m of labeled.slice(1)) if (score(m.rows) > score(best.rows)) best = m;
		canonical.set(groupId, best.name);

		let differing = 0;
		for (const m of labeled) {
			if (m === best) continue;
			const n = Math.max(m.rows.length, best.rows.length);
			for (let i = 0; i < n; i += 1) {
				if (!m.rows[i] || !best.rows[i] || norm(m.rows[i]) !== norm(best.rows[i])) differing += 1;
			}
		}
		if (differing > 0) conflicts.push({ groupId, members: labeled.map(m => m.name), chosen: best.name, differingRows: differing });
	}
	return { canonical, conflicts };
}
