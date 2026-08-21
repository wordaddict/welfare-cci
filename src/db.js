const { Pool } = require('pg');

let pool;
let initialized = false;

function getSslConfig() {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.NODE_ENV === 'production') return { rejectUnauthorized: false };
  return false;
}

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set. This build now uses PostgreSQL for Heroku-compatible persistence.');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: getSslConfig()
    });
  }
  return pool;
}

function getSessionPool() {
  return getPool();
}

async function withAdvisoryLock(lockKey, work) {
  const client = await getPool().connect();
  try {
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!lockResult.rows[0] || !lockResult.rows[0].locked) {
      return { locked: false };
    }

    try {
      const result = await work();
      return { locked: true, result };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    client.release();
  }
}

function normalizeParams(params) {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params;
  return [params];
}

function replaceQuestionPlaceholders(sql) {
  let result = '';
  let index = 1;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const prev = i > 0 ? sql[i - 1] : '';

    if (char === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      result += char;
      continue;
    }
    if (char === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      result += char;
      continue;
    }
    if (char === '?' && !inSingle && !inDouble) {
      result += `$${index}`;
      index += 1;
      continue;
    }
    result += char;
  }

  return result;
}

function normalizeSql(sql, { forRun = false } = {}) {
  let text = String(sql || '').trim();
  text = text.replace(/\bdatetime\(([^)]+)\)/gi, '($1)');

  if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(text)) {
    text = text.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ');
    if (!/\bON\s+CONFLICT\b/i.test(text)) text += ' ON CONFLICT DO NOTHING';
  }

  text = replaceQuestionPlaceholders(text);

  if (forRun && /^INSERT\s+INTO\s+/i.test(text) && !/\bRETURNING\b/i.test(text)) {
    text += ' RETURNING id';
  }

  return text;
}

async function query(sql, params, options = {}) {
  const database = getPool();
  const text = normalizeSql(sql, options);
  return database.query(text, normalizeParams(params));
}

function createCompatDb() {
  return {
    async get(sql, params) {
      const result = await query(sql, params);
      return result.rows[0] || undefined;
    },
    async all(sql, params) {
      const result = await query(sql, params);
      return result.rows;
    },
    async run(sql, params) {
      const result = await query(sql, params, { forRun: true });
      return {
        lastID: result.rows[0] ? result.rows[0].id : undefined,
        changes: result.rowCount
      };
    },
    async exec(sql) {
      await getPool().query(String(sql));
    }
  };
}

const db = createCompatDb();

async function initDb() {
  if (initialized) return;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      reviewer_contact_email TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin','committee','reviewer','applicant')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS requests (
      id BIGSERIAL PRIMARY KEY,
      case_id TEXT UNIQUE,
      applicant_user_id BIGINT REFERENCES users(id),
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      city_state TEXT NOT NULL,
      cci_connection_type TEXT NOT NULL,
      cci_community_name TEXT NOT NULL,
      leader_name TEXT NOT NULL,
      leader_role TEXT NOT NULL,
      leader_contact TEXT,
      leader_email TEXT,
      leader_phone TEXT,
      leader_verification_token TEXT,
      leader_verification_sent_at TIMESTAMPTZ,
      tracking_token TEXT,
      applicant_last_viewed_at TIMESTAMPTZ,
      connection_duration TEXT NOT NULL,
      membership_status TEXT NOT NULL,
      map_group_status TEXT,
      map_group_name TEXT,
      worker_status TEXT,
      worker_duration_value INTEGER,
      worker_duration_unit TEXT,
      unit_name TEXT,
      unit_leader_name TEXT,
      unit_leader_email TEXT,
      unit_leader_phone TEXT,
      unit_leader_verification_token TEXT,
      unit_leader_verification_sent_at TIMESTAMPTZ,
      unit_leader_verified TEXT NOT NULL DEFAULT 'Not Required',
      pastor_informed TEXT,
      request_category TEXT NOT NULL,
      amount_requested DOUBLE PRECISION NOT NULL,
      total_amount_needed DOUBLE PRECISION,
      due_date DATE,
      situation TEXT NOT NULL,
      consequence TEXT NOT NULL,
      one_time_or_ongoing TEXT NOT NULL,
      prior_assistance TEXT NOT NULL,
      prior_assistance_details TEXT,
      applicant_effort TEXT,
      applicant_contribution DOUBLE PRECISION NOT NULL DEFAULT 0,
      other_confirmed_support DOUBLE PRECISION NOT NULL DEFAULT 0,
      dependents_affected TEXT,
      effort_actions TEXT,
      direct_payment_possible TEXT NOT NULL,
      payment_details TEXT,
      direct_payment_explanation TEXT,
      zelle_name TEXT,
      zelle_email TEXT,
      zelle_phone TEXT,
      category_details TEXT,
      applicant_declaration INTEGER NOT NULL DEFAULT 0,
      consent_leader_contact INTEGER NOT NULL DEFAULT 0,
      consent_proof_of_use INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'New Request',
      urgency TEXT NOT NULL DEFAULT 'Standard',
      urgency_reason TEXT,
      urgency_override_by BIGINT,
      urgency_override_at TIMESTAMPTZ,
      assigned_reviewer_1 BIGINT REFERENCES users(id),
      assigned_reviewer_2 BIGINT REFERENCES users(id),
      reviewer_1_notified_at TIMESTAMPTZ,
      reviewer_2_notified_at TIMESTAMPTZ,
      leader_verified TEXT NOT NULL DEFAULT 'Pending',
      documents_complete TEXT NOT NULL DEFAULT 'Pending',
      decision TEXT,
      amount_approved DOUBLE PRECISION,
      decision_notes TEXT,
      pastorate_required TEXT NOT NULL DEFAULT 'No',
      pastorate_decision TEXT,
      follow_up_needed TEXT NOT NULL DEFAULT 'No',
      finance_confirm_token TEXT,
      finance_packet_sent_at TIMESTAMPTZ,
      payment_confirmed_at TIMESTAMPTZ,
      payment_confirmed_by TEXT,
      payment_confirmation_amount DOUBLE PRECISION,
      payment_confirmation_method TEXT,
      payment_confirmation_reference TEXT,
      payment_confirmation_notes TEXT,
      payment_confirmation_file TEXT,
      applicant_outcome_notified_at TIMESTAMPTZ,
      applicant_outcome_notified_by BIGINT,
      applicant_payment_notified_at TIMESTAMPTZ,
      applicant_followup_requested_at TIMESTAMPTZ,
      applicant_followup_reminder_sent_at TIMESTAMPTZ,
      applicant_followup_reminder_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stored_files (
      id BIGSERIAL PRIMARY KEY,
      storage_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'database',
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data BYTEA,
      cloud_public_id TEXT,
      cloud_resource_type TEXT,
      cloud_version INTEGER,
      secure_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      document_type TEXT NOT NULL DEFAULT 'Supporting document',
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leadership_verifications (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      verifier_name TEXT NOT NULL,
      verifier_email TEXT NOT NULL,
      verifier_phone TEXT NOT NULL,
      unit_name TEXT,
      worker_confirmed TEXT NOT NULL,
      unit_confirmed TEXT NOT NULL,
      service_duration_value INTEGER NOT NULL,
      service_duration_unit TEXT NOT NULL,
      comments TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leader_verifications (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      verified_by BIGINT REFERENCES users(id),
      verifier_name TEXT,
      verifier_email TEXT,
      verifier_phone TEXT,
      knows_applicant TEXT NOT NULL,
      active_connection TEXT NOT NULL,
      aware_of_need TEXT NOT NULL,
      pastoral_context TEXT,
      recommendation TEXT,
      support_letter_file TEXT,
      member_confirmed TEXT,
      worker_confirmed TEXT,
      known_duration_value INTEGER,
      known_duration_unit TEXT,
      decision_comments TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      reviewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conflict_of_interest TEXT NOT NULL,
      eligibility_rating INTEGER,
      urgency_rating INTEGER,
      severity_rating INTEGER,
      gap_rating INTEGER,
      effort_rating INTEGER,
      history_rating INTEGER,
      policy_rating INTEGER,
      documentation_rating INTEGER,
      score_total INTEGER,
      system_score_total INTEGER,
      system_assessment_json TEXT,
      system_assessment_agreement TEXT,
      override_reason TEXT,
      actual_gap DOUBLE PRECISION,
      recommended_decision TEXT NOT NULL,
      recommended_amount DOUBLE PRECISION,
      notes TEXT,
      submitted_by_applicant INTEGER DEFAULT 0,
      receipt_file TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(request_id, reviewer_id)
    );

    CREATE TABLE IF NOT EXISTS request_reviewers (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      reviewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      notified_at TIMESTAMPTZ,
      invite_token TEXT UNIQUE,
      accepted_at TIMESTAMPTZ,
      declined_at TIMESTAMPTZ,
      review_token TEXT UNIQUE,
      review_token_sent_at TIMESTAMPTZ,
      review_submitted_at TIMESTAMPTZ,
      reminder_sent_at TIMESTAMPTZ,
      expired_at TIMESTAMPTZ,
      UNIQUE(request_id, reviewer_id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
      payment_method TEXT NOT NULL,
      payee_name TEXT NOT NULL,
      payee_contact TEXT,
      amount_paid DOUBLE PRECISION NOT NULL,
      payment_date TEXT NOT NULL,
      confirmation_note TEXT,
      confirmation_file TEXT,
      processed_by BIGINT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS followups (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      completed_by BIGINT NOT NULL REFERENCES users(id),
      funds_used_as_intended TEXT,
      issue_resolved TEXT,
      receipt_received TEXT,
      pastoral_followup_needed TEXT,
      notes TEXT,
      submitted_by_applicant INTEGER DEFAULT 0,
      receipt_file TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT REFERENCES requests(id) ON DELETE SET NULL,
      recipient_name TEXT,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Queued',
      provider TEXT,
      provider_message_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT REFERENCES requests(id) ON DELETE SET NULL,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_request_reviewers_review_token ON request_reviewers(review_token);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviewer_contact_email ON users ((lower(reviewer_contact_email))) WHERE role='reviewer' AND reviewer_contact_email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_applicant_user ON requests(applicant_user_id);
    CREATE INDEX IF NOT EXISTS idx_request_reviewers_request ON request_reviewers(request_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_request ON reviews(request_id);
    CREATE INDEX IF NOT EXISTS idx_documents_stored_name ON documents(stored_name);
    CREATE INDEX IF NOT EXISTS idx_stored_files_storage_key ON stored_files(storage_key);

    ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'database';
    ALTER TABLE stored_files ALTER COLUMN data DROP NOT NULL;
    ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS cloud_public_id TEXT;
    ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS cloud_resource_type TEXT;
    ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS cloud_version INTEGER;
    ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS secure_url TEXT;

    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
  `);

  initialized = true;
}

async function getDb() {
  await initDb();
  return db;
}

async function logActivity(requestId, userId, action, details = '') {
  const database = await getDb();
  await database.run(
    'INSERT INTO activity_logs (request_id, user_id, action, details) VALUES (?,?,?,?)',
    [requestId || null, userId || null, action, details]
  );
}

module.exports = { getDb, getSessionPool, initDb, logActivity, withAdvisoryLock };
