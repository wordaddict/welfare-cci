const bcrypt = require('bcryptjs');
const { initDb, getDb } = require('./db');

async function ensureUser(db, name, email, password, role) {
  const existing = await db.get('SELECT id FROM users WHERE email=?', email);
  if (existing) return;
  const hash = await bcrypt.hash(password, 12);
  await db.run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', [name, email, hash, role]);
  console.log(`Created ${role}: ${email} / ${password}`);
}

async function seed() {
  await initDb();
  const db = await getDb();
  await ensureUser(db, 'Admin User', 'admin@cci.local', 'admin123', 'admin');
  await ensureUser(db, 'Applicant Demo', 'applicant@cci.local', 'applicant123', 'applicant');
  console.log('Reviewer accounts are no longer seeded. Add reviewer names/emails from Admin > Reviewers.');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
