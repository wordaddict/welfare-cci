const bcrypt = require('bcryptjs');

function mountAuthRoutes(app, { getDb }) {
  const loginAttemptBuckets = new Map();

  function loginRateLimit(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxAttempts = 10;
    let bucket = loginAttemptBuckets.get(key);
    if (!bucket || now - bucket.startedAt > windowMs) bucket = { startedAt: now, count: 0 };
    if (bucket.count >= maxAttempts) {
      return res.status(429).render('login', { title: 'Login', error: 'Too many login attempts. Please wait about 15 minutes and try again.', selectedRole: req.body.expectedRole || '' });
    }
    bucket.count += 1;
    loginAttemptBuckets.set(key, bucket);
    req.loginRateLimitKey = key;
    next();
  }

  app.get('/register', (req, res) => res.render('register', { title: 'Create Applicant Account', error: null }));
  app.post('/register', async (req, res) => {
    const db = await getDb();
    try {
      const name = String(req.body.name || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      if (!name || !email || password.length < 8) throw new Error('Please provide your full name, email, and a password with at least 8 characters.');
      const existing = await db.get('SELECT id FROM users WHERE email=?', email);
      if (existing) throw new Error('An account already exists with this email. Please log in instead.');
      const hash = await bcrypt.hash(password, 12);
      const result = await db.run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', [name, email, hash, 'applicant']);
      const authUser = { id: result.lastID, name, email, role: 'applicant' };
      req.session.user = authUser;
      req.session.save(() => res.redirect('/apply'));
    } catch (err) {
      res.status(400).render('register', { title: 'Create Applicant Account', error: err.message || 'Could not create account.' });
    }
  });

  app.get('/login', (req, res) => res.render('login', { title: 'Login', error: null, selectedRole: req.query.role || '' }));
  app.post('/login', loginRateLimit, async (req, res) => {
    const db = await getDb();
    const expectedRole = String(req.body.expectedRole || '').trim();
    const loginEmail = String(req.body.email || '').trim().toLowerCase();
    const loginPassword = String(req.body.password || '');
    const user = await db.get('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1', loginEmail);
    if (!user || !loginPassword || !(await bcrypt.compare(loginPassword, user.password_hash))) {
      return res.status(401).render('login', { title: 'Login', error: 'Invalid email or password.', selectedRole: expectedRole });
    }

    if (!['admin', 'applicant'].includes(user.role)) {
      return res.status(403).render('login', { title: 'Login', error: 'This role does not use a password login. Reviewers and verifiers access cases only through secure email links.', selectedRole: expectedRole });
    }

    if (expectedRole && user.role !== expectedRole) {
      return res.status(403).render('login', {
        title: 'Login',
        error: `This account is registered as ${user.role}, not ${expectedRole}. Please choose the correct portal.`,
        selectedRole: expectedRole
      });
    }

    if (req.loginRateLimitKey) loginAttemptBuckets.delete(req.loginRateLimitKey);
    const authUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    req.session.user = authUser;
    req.session.save(() => {
      if (authUser.role === 'applicant') return res.redirect('/apply');
      return res.redirect('/dashboard');
    });
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });
}

module.exports = {
  mountAuthRoutes
};
