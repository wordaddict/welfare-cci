require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { initDb, getDb, getSessionPool, logActivity, withAdvisoryLock } = require('./src/db');
const { createCloseoutWorkflow } = require('./src/closeout-workflow');
const { getAppConfig } = require('./src/config');
const { money, escapeCsv, requireRole } = require('./src/helpers');
const { createFinancePacketService } = require('./src/finance-packet');
const { mountInternalJobRoutes } = require('./src/internal-jobs');
const { sendNotification } = require('./src/notifications');
const { applicantStatusInfo, buildSystemAssessment, isApprovalDecision, reviewScoreSummary, reviewScoreTotal } = require('./src/request-assessment');
const { mountAdminRoutes } = require('./src/routes/admin-routes');
const { mountAuthRoutes } = require('./src/routes/auth-routes');
const { mountPublicRoutes } = require('./src/routes/public-routes');
const { createReviewerWorkflow } = require('./src/reviewer-workflow');
const { appendStoredFileToArchive, getStoredFileByKey, saveUploadedFile, sendStoredFile } = require('./src/storage');

const app = express();
const appConfig = getAppConfig();
const PORT = appConfig.port;

function baseUrl(req) {
  if (appConfig.appBaseUrl) return appConfig.appBaseUrl.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (req && req.protocol && req.get) return `${req.protocol}://${req.get('host')}`;
  return `http://localhost:${PORT}`;
}

const reviewerWorkflow = createReviewerWorkflow({
  appConfig,
  baseUrl,
  getDb,
  logActivity,
  sendNotification,
  withAdvisoryLock
});

const closeoutWorkflow = createCloseoutWorkflow({
  appConfig,
  baseUrl,
  getDb,
  logActivity,
  money,
  sendNotification,
  withAdvisoryLock
});

const {
  ensureTwoReviewerInvites,
  notifyAssignedReviewers,
  runReviewerInvitationSweep,
  startReviewerScheduler
} = reviewerWorkflow;

const {
  sendApplicantPaymentNotice,
  sendApplicantCloseoutRequest,
  runApplicantCloseoutSweep,
  startApplicantCloseoutScheduler
} = closeoutWorkflow;

const financePacketService = createFinancePacketService({
  baseUrl,
  getDb,
  logActivity,
  sendNotification,
  appendStoredFileToArchive,
  getStoredFileByKey
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (appConfig.nodeEnv === 'production') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

function renderBlockedRequest(res, message) {
  return res.status(403).render('error', {
    title: 'Request blocked',
    message,
    user: null,
    publicPage: true,
    publicLabel: 'Secure request'
  });
}

function normalizeHost(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase();
}

function headerUrlHost(value) {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function trustedRequestHosts(req) {
  const hosts = new Set();
  const requestHost = normalizeHost(req.get('host'));
  if (requestHost) hosts.add(requestHost);
  if (appConfig.appBaseUrl) {
    const appBaseHost = headerUrlHost(appConfig.appBaseUrl);
    if (appBaseHost) hosts.add(appBaseHost);
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    const renderHost = headerUrlHost(process.env.RENDER_EXTERNAL_URL);
    if (renderHost) hosts.add(renderHost);
  }
  return hosts;
}

app.use((req, res, next) => {
  if (appConfig.nodeEnv !== 'production' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const referer = req.get('referer');
  const fetchSite = String(req.get('sec-fetch-site') || '').trim().toLowerCase();
  const trustedHosts = trustedRequestHosts(req);

  if (!origin) {
    const refererHost = headerUrlHost(referer);
    if (referer && !refererHost) return renderBlockedRequest(res, 'Invalid request referer.');
    if (refererHost && !trustedHosts.has(refererHost)) {
      return renderBlockedRequest(res, 'This form submission did not originate from the CCI Welfare application.');
    }
    return next();
  }

  if (origin === 'null') {
    const refererHost = headerUrlHost(referer);
    if (refererHost && trustedHosts.has(refererHost)) return next();
    if (fetchSite === 'same-origin') return next();
    return renderBlockedRequest(res, 'Invalid request origin.');
  }

  const originHost = headerUrlHost(origin);
  if (!originHost) return renderBlockedRequest(res, 'Invalid request origin.');
  if (!trustedHosts.has(originHost)) {
    return renderBlockedRequest(res, 'This form submission did not originate from the CCI Welfare application.');
  }
  next();
});
app.use(session({
  store: new PgSession({
    pool: getSessionPool(),
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: appConfig.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: appConfig.nodeEnv === 'production', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.money = money;
  next();
});

app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'cci-welfare-app' }));
mountInternalJobRoutes(app, { baseUrl, runReviewerInvitationSweep, runApplicantCloseoutSweep });
app.get('/', (req, res) => res.render('home', { title: 'CCI America Financial Assistance', landingPage: true }));

mountAuthRoutes(app, { getDb });
mountPublicRoutes(app, {
  applicantStatusInfo,
  baseUrl,
  buildSystemAssessment,
  ensureTwoReviewerInvites,
  getDb,
  getStoredFileByKey,
  logActivity,
  notifyAssignedReviewers,
  requireRole,
  reviewScoreTotal,
  saveUploadedFile,
  sendApplicantPaymentNotice,
  sendNotification,
  sendStoredFile,
  upload
});
mountAdminRoutes(app, {
  baseUrl,
  buildFinancePacketZipBuffer: financePacketService.buildFinancePacketZipBuffer,
  buildFinanceSummaryPdfBuffer: financePacketService.buildFinanceSummaryPdfBuffer,
  buildSystemAssessment,
  emailFinanceDecisionPacket: financePacketService.emailFinanceDecisionPacket,
  ensureTwoReviewerInvites,
  escapeCsv,
  getDb,
  getDecisionArtifacts: financePacketService.getDecisionArtifacts,
  getStoredFileByKey,
  isApprovalDecision,
  logActivity,
  money,
  notifyAssignedReviewers,
  requireRole,
  reviewScoreSummary,
  reviewScoreTotal,
  sendApplicantCloseoutRequest,
  sendNotification,
  sendStoredFile
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: err.message || 'Something went wrong.' });
});

async function bootstrapAdminIfConfigured() {
  const db = await getDb();
  const existingAdmin = await db.get("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1");
  if (existingAdmin) return;
  const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');
  const name = String(process.env.ADMIN_BOOTSTRAP_NAME || 'CCI Welfare Admin').trim();
  if (!email || password.length < 12) {
    console.warn('[bootstrap] No active Admin account exists. Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD (12+ characters), or run npm run seed for local testing.');
    return;
  }
  const collision = await db.get('SELECT id FROM users WHERE lower(email)=lower(?)', email);
  if (collision) {
    await db.run("UPDATE users SET role='admin', active=1, name=? WHERE id=?", [name, collision.id]);
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await db.run('INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,?,1)', [name, email, hash, 'admin']);
  console.log(`[bootstrap] Created initial Admin account for ${email}.`);
}

initDb().then(async () => {
  await bootstrapAdminIfConfigured();
  app.listen(PORT, () => {
    console.log(`CCI America Financial Assistance app running on port ${PORT}`);
    startReviewerScheduler();
    startApplicantCloseoutScheduler();
  });
}).catch(err => {
  console.error('Application startup failed:', err);
  process.exit(1);
});
