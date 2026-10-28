// Deploy the app: the image to Cloud Run (built by Cloud Build from the Dockerfile), then Firebase Hosting in front of it.
//   npm run deploy                  both
//   npm run deploy -- --only run    / --only hosting
// Settings of the deployed app: .env.cloudrun (KEY=VALUE like .env, never committed; see .env.example "Deploy").
// Needs the gcloud and firebase CLIs, both signed in (gcloud auth login, firebase login) to the project.
// The OCR server and MinIO stay on this machine, reached through tunnels (OCR_SERVER_URL, MINIO_ENDPOINT).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SERVICE = 'rosterparser'; // also in firebase.json
const REGION = 'asia-southeast1';
const ENV_FILE = '.env.cloudrun';
const REQUIRED = ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'ADMIN_EMAILS', 'OCR_SERVER_URL', 'OCR_SERVER_TOKEN',
  'MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MONGODB_URI'];
// set by Cloud Run itself, or by this script
const RESERVED = ['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION'];

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

function readEnv(file) {
  if (!fs.existsSync(file)) {
    console.error(`${file} is missing: copy the "Deploy" part of .env.example into it and fill it in.`);
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function run(cmd, cmdArgs) {
  console.log(`\n> ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(r.error?.code === 'ENOENT' ? `${cmd} is not installed.` : `${cmd} failed (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
}

const env = readEnv(ENV_FILE);
const missing = REQUIRED.filter(k => !env[k]);
if (missing.length) {
  console.error(`${ENV_FILE} needs: ${missing.join(', ')}`);
  process.exit(1);
}
const project = env.FIREBASE_PROJECT_ID;

if (!only || only === 'run') {
  // the app on Cloud Run reaches the OCR server through a tunnel: files go as bytes (services/paddle-ocr.js)
  // TRUST_PROXY 2: Firebase Hosting, then Google's front end, each add a hop to X-Forwarded-For (check the IP a
  // visitor gets after the first deploy; per-IP limits of visitors without an account use it)
  const appEnv = { MINIO_PORT: '443', MINIO_USE_SSL: 'true', TRUST_PROXY: '2', ...env, OCR_SEND_FILES: '1', NODE_ENV: 'production', ROSTER_WORK_DIR: '/work' };
  for (const k of RESERVED) delete appEnv[k];
  // gcloud --env-vars-file takes YAML; JSON strings are valid YAML. Kept outside the project and removed after.
  const yaml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rosterparser-deploy-')), 'env.yaml');
  fs.writeFileSync(yaml, Object.entries(appEnv).map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`).join('\n') + '\n');
  try {
    run('gcloud', ['run', 'deploy', SERVICE, '--source', '.', '--project', project, '--region', REGION,
      '--env-vars-file', yaml, '--port', '3000', '--memory', '2Gi', '--cpu', '2',
      // one instance: the media mirror, benchmark and training jobs live in its memory and /work
      '--min-instances', '0', '--max-instances', '1', '--concurrency', '40',
      // benchmarks and training go on after their request: keep the CPU on; 60 min per request (streams)
      '--no-cpu-throttling', '--timeout', '3600', '--allow-unauthenticated', '--quiet']);
  } finally {
    fs.rmSync(path.dirname(yaml), { recursive: true, force: true });
  }
}

if (!only || only === 'hosting') {
  run('firebase', ['deploy', '--only', 'hosting', '--project', project]);
  console.log(`\nDone: https://${project}.web.app`);
  console.log('Requests through Firebase Hosting stop after 60 s: for a benchmark or training run open the Cloud Run URL');
  console.log(`(gcloud run services describe ${SERVICE} --region ${REGION} --project ${project} --format "value(status.url)"),`);
  console.log('after adding its domain to Firebase Authentication > Settings > Authorized domains.');
}
