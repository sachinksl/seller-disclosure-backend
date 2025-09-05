// backend/server.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const form2Router = require('./routes/form2');
const serveRouter = require('./routes/serve');
const compression = require('compression');            
const rateLimit = require('express-rate-limit');


const authRoutes = require('./auth');                    // your Auth0 routes
const  ensureDbUser  = require('./mw.ensureDbUser');       // creates/updates user/org

const propertiesRouter = require('./routes/properties'); // /api/properties
const dashboardRouter = require('./routes/dashboard');
const uploadsRouter = require('./routes/uploads');

const invitesRouter = require('./routes/invites');


// --- catch hidden crashes ---
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection]', err);
});

const nodemailer = require('nodemailer');
(async () => {
  if (process.env.SMTP_HOST) {
    try {
      const port = Number(process.env.SMTP_PORT || 587);
      const secure = port === 465;
      const ok = await nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port, secure,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      }).verify();
      console.log('[smtp] verify ok:', ok);
    } catch (e) {
      console.warn('[smtp] verify failed:', e.message);
    }
  }
})();



const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 8000;


if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}



// middleware
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));

// session BEFORE routes
app.use(session({
  name: 'sid',
  secret: process.env.SESSION_SECRET || 'dev-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // set true in prod behind HTTPS
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

// auth
app.use('/auth', authRoutes);

// guards
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}
const requireRole = (...roles) => (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: 'unauthenticated' });
  const ok = (req.session.user.roles || []).some(r => roles.includes(r));
  if (!ok) return res.status(403).json({ error: 'forbidden' });
  next();
};

// health & whoami
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

// db smoke test (optional)
try {
  const prisma = require('./db');
  app.get('/api/db-check', async (_req, res) => {
    const row = await prisma.$queryRaw`select now() as now`;
    res.json({ ok: true, now: row[0].now });
  });
} catch (e) {
  console.warn('Prisma not loaded yet:', e.message);
}

// protect your existing app routes
app.post('/api/disclosure/ai', requireAuth, (req, res) => {
  const { prompt } = req.body || {};
  res.json({ reply: `Got it. You said: "${prompt ?? ''}"` });
});
app.get('/api/disclosure/progress', requireAuth, (_req, res) => {
  res.json({ completed: 2, total: 3 });
});

// properties endpoints (login + db user required)
app.use('/api/properties', requireAuth, ensureDbUser, propertiesRouter);

// optional: backend root redirects to frontend
app.get('/', (_req, res) => res.redirect(FRONTEND_URL));

// start
app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
});

app.use('/api/dashboard', requireAuth, ensureDbUser, dashboardRouter);

//app.use('/api/properties', requireAuth, ensureDbUser, require('./routes/properties'));

app.use('/api/properties', requireAuth, ensureDbUser, propertiesRouter);
app.use('/api', requireAuth, ensureDbUser, uploadsRouter, form2Router);
app.use('/api', requireAuth, ensureDbUser, uploadsRouter, serveRouter);
app.use('/api', requireAuth, ensureDbUser, invitesRouter);
app.use('/api', requireAuth, ensureDbUser, dashboardRouter);

// ---- Security baseline ----
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0)); // needed if secure cookies behind proxy

// Helmet (relaxed for dev so React dev server works)
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: false,          // keep false in dev; tighten later
}));

app.use(compression());


// Strict CORS
const allowlist = (process.env.CORS_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, cb) {
    // allow no-origin (curl/postman) and explicit allowlist
    if (!origin || allowlist.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked'));
  },
  credentials: true
}));

// Request body size limits
app.use(express.json({ limit: process.env.JSON_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: false, limit: process.env.JSON_LIMIT || '1mb' }));

// Auth endpoints burst-protection + general API limiter
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });  // 60 req / 10 min
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 600 });       // 600 req / min

// ---- Sessions ----
const secure = process.env.NODE_ENV === 'production';
app.use(session({
  name: process.env.SESSION_NAME || 'sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure,                              // true in prod (https)
    maxAge: 1000 * 60 * 60 * 8           // 8h
  }
}));

// Health (no auth)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- Routes ----
app.use('/auth', authLimiter, authRoutes);

// Ensure the user exists in DB middleware (you already have this in your codebase)
// Example:
// const { requireAuth, ensureDbUser } = require('./middleware/authz');
// app.use('/api', requireAuth, ensureDbUser, apiLimiter);

//const { requireAuth, ensureDbUser } = require('./middleware'); // if you bundled helpers
app.use('/api', requireAuth, ensureDbUser, apiLimiter, [
  dashboardRouter,
  propertiesRouter,
  uploadsRouter,
  invitesRouter,
  serveRouter,
]);

// ---- Global error handler ----
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const msg = err.message || 'server_error';
  if (process.env.NODE_ENV !== 'production') {
    console.error('[error]', status, msg, err.stack);
  }
  res.status(status).json({ error: msg });
});


app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));

