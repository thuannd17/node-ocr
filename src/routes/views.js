// /routes/views.js
// Serve các trang HTML từ views/ (chỉ view, không có logic API)
import express, { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const viewsDir = path.resolve(__dirname, '..', 'views');

const router = Router();

// Shared stylesheet + nav used by every page.
router.use('/assets', express.static(path.join(viewsDir, 'assets')));
// Font Awesome Free (npm @fortawesome/fontawesome-free), served locally: /assets/fontawesome/css/all.min.css
router.use('/assets/fontawesome', express.static(path.resolve(__dirname, '..', '..', 'node_modules', '@fortawesome', 'fontawesome-free')));

// Leaflet (npm leaflet), served locally for the airport map: /assets/leaflet/leaflet.js
router.use('/assets/leaflet', express.static(path.resolve(__dirname, '..', '..', 'node_modules', 'leaflet', 'dist')));

// MapLibre GL (npm maplibre-gl), served locally for the globe view of /route-map: /assets/maplibre/maplibre-gl.js
router.use('/assets/maplibre', express.static(path.resolve(__dirname, '..', '..', 'node_modules', 'maplibre-gl', 'dist')));

// SunCalc (npm suncalc) for /night-time: /assets/suncalc/suncalc.js
router.use('/assets/suncalc', express.static(path.resolve(__dirname, '..', '..', 'node_modules', 'suncalc')));

// Swagger UI (npm swagger-ui-dist) for /api-docs
router.use('/assets/swagger-ui', express.static(path.resolve(__dirname, '..', '..', 'node_modules', 'swagger-ui-dist')));

router.get('/', (req, res) => {
	res.sendFile(path.join(viewsDir, 'home.html'));
});

// Read a roster with the AI model (was /upload until 2026-10-20: old links and bookmarks still lead here)
router.get('/upload', (req, res) => res.redirect(301, `/roster${req.originalUrl.slice('/upload'.length)}`));
router.get('/roster', (req, res) => {
	res.sendFile(path.join(viewsDir, 'roster.html'));
});

// Public: scan or upload a cockpit ACARS (OOOI) picture, read by the AI model
router.get('/acars', (req, res) => {
	res.sendFile(path.join(viewsDir, 'acars.html'));
});

// Sign-in for the admin pages (Firebase: routes/auth-api.js); ?next= the admin page to go back to
router.get('/login', (req, res) => {
	res.sendFile(path.join(viewsDir, 'login.html'));
});
// An account for the API (Google, GitHub or email + password), then its keys and usage on /account
router.get('/signup', (req, res) => {
	res.sendFile(path.join(viewsDir, 'signup.html'));
});
router.get('/account', (req, res) => {
	res.sendFile(path.join(viewsDir, 'account.html'));
});
// Admin: every account, its role, plan, limits, keys and today's calls (routes/account-api.js)
router.get('/users', (req, res) => {
	res.sendFile(path.join(viewsDir, 'users.html'));
});
// The plans and their prices, bought with PayPal (routes/billing-api.js); an invoice to print; admin: every payment
router.get('/pricing', (req, res) => {
	res.sendFile(path.join(viewsDir, 'pricing.html'));
});
router.get('/invoice', (req, res) => {
	res.sendFile(path.join(viewsDir, 'invoice.html'));
});
router.get('/billing', (req, res) => {
	res.sendFile(path.join(viewsDir, 'billing.html'));
});

router.get('/label', (req, res) => {
	res.sendFile(path.join(viewsDir, 'label.html'));
});

router.get('/benchmark', (req, res) => {
	res.sendFile(path.join(viewsDir, 'benchmark.html'));
});

router.get('/models', (req, res) => {
	res.sendFile(path.join(viewsDir, 'models.html'));
});

// Admin: the roster files and labels of MinIO (media/, services/media-client.js)
router.get('/media', (req, res) => {
	res.sendFile(path.join(viewsDir, 'media.html'));
});
router.get('/storage', (req, res) => res.redirect(301, '/media'));

// Admin: the correction suggestions sent from /roster, their state and the reply by email (routes/suggestions-api.js)
router.get('/helpdesk', (req, res) => {
	res.sendFile(path.join(viewsDir, 'helpdesk.html'));
});

// .ics files (exported from /roster, or any calendar) shown as a month calendar, read in the browser
router.get('/calendar', (req, res) => {
	res.sendFile(path.join(viewsDir, 'calendar.html'));
});

// The flights of the calendars opened on /calendar on a world map, one colour per roster (opened from /calendar)
router.get('/route-map', (req, res) => {
	res.sendFile(path.join(viewsDir, 'route-map.html'));
});

// Airport search + details, map and 7-day weather; /airport?code=VIE (linked from /calendar)
router.get('/airport', (req, res) => {
	res.sendFile(path.join(viewsDir, 'airport.html'));
});

// Night time of a flight along the great circle (sun altitude at the aircraft), map + chart; linked from /calendar flights
router.get('/night-time', (req, res) => {
	res.sendFile(path.join(viewsDir, 'night-time.html'));
});

// Public API reference (Swagger UI over docs/openapi.json, also served raw for other tools)
router.get('/api-docs', (req, res) => {
	res.sendFile(path.join(viewsDir, 'api-docs.html'));
});
router.get('/api/openapi.json', (req, res) => {
	res.sendFile(path.resolve(__dirname, '..', '..', 'docs', 'openapi.json'));
});

// /ops and /crop-label were archived to archive/views/ (2026-10-06): they drove
// the learned-correction replay and the old dataset export, both retired.

export default router;
