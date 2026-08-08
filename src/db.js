const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

let db;

async function getDb() {
  if (!db) {
    const defaultPath = path.join(__dirname, '..', 'db', 'financial_support.sqlite');
    const databasePath = process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : defaultPath;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    db = await open({
      filename: databasePath,
      driver: sqlite3.Database
    });
    await db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

async function addColumnIfMissing(database, table, column, definition) {
  const cols = await database.all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) {
    await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initDb() {
  const database = await getDb();
  await database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      reviewer_contact_email TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin','committee','reviewer','applicant')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT UNIQUE,
      applicant_user_id INTEGER,
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
      leader_verification_sent_at TEXT,
      tracking_token TEXT,
      applicant_last_viewed_at TEXT,
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
      unit_leader_verification_sent_at TEXT,
      unit_leader_verified TEXT NOT NULL DEFAULT 'Not Required',
      pastor_informed TEXT,
      request_category TEXT NOT NULL,
      amount_requested REAL NOT NULL,
      total_amount_needed REAL,
      due_date TEXT,
      situation TEXT NOT NULL,
      consequence TEXT NOT NULL,
      one_time_or_ongoing TEXT NOT NULL,
      prior_assistance TEXT NOT NULL,
      prior_assistance_details TEXT,
      applicant_effort TEXT,
      applicant_contribution REAL NOT NULL DEFAULT 0,
      other_confirmed_support REAL NOT NULL DEFAULT 0,
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
      urgency_override_by INTEGER,
      urgency_override_at TEXT,
      assigned_reviewer_1 INTEGER,
      assigned_reviewer_2 INTEGER,
      reviewer_1_notified_at TEXT,
      reviewer_2_notified_at TEXT,
      leader_verified TEXT NOT NULL DEFAULT 'Pending',
      documents_complete TEXT NOT NULL DEFAULT 'Pending',
      decision TEXT,
      amount_approved REAL,
      decision_notes TEXT,
      pastorate_required TEXT NOT NULL DEFAULT 'No',
      pastorate_decision TEXT,
      follow_up_needed TEXT NOT NULL DEFAULT 'No',
      finance_confirm_token TEXT,
      finance_packet_sent_at TEXT,
      payment_confirmed_at TEXT,
      payment_confirmed_by TEXT,
      payment_confirmation_amount REAL,
      payment_confirmation_method TEXT,
      payment_confirmation_reference TEXT,
      payment_confirmation_notes TEXT,
      payment_confirmation_file TEXT,
      applicant_outcome_notified_at TEXT,
      applicant_outcome_notified_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(assigned_reviewer_1) REFERENCES users(id),
      FOREIGN KEY(assigned_reviewer_2) REFERENCES users(id),
      FOREIGN KEY(applicant_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      document_type TEXT NOT NULL DEFAULT 'Supporting document',
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS leadership_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      verifier_name TEXT NOT NULL,
      verifier_email TEXT NOT NULL,
      verifier_phone TEXT NOT NULL,
      unit_name TEXT,
      worker_confirmed TEXT NOT NULL,
      unit_confirmed TEXT NOT NULL,
      service_duration_value INTEGER NOT NULL,
      service_duration_unit TEXT NOT NULL,
      comments TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS leader_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      verified_by INTEGER,
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE,
      FOREIGN KEY(verified_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      reviewer_id INTEGER NOT NULL,
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
      actual_gap REAL,
      recommended_decision TEXT NOT NULL,
      recommended_amount REAL,
      notes TEXT,
      submitted_by_applicant INTEGER DEFAULT 0,
      receipt_file TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(request_id, reviewer_id),
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE,
      FOREIGN KEY(reviewer_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS request_reviewers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      reviewer_id INTEGER NOT NULL,
      assigned_by INTEGER,
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      notified_at TEXT,
      invite_token TEXT UNIQUE,
      accepted_at TEXT,
      declined_at TEXT,
      review_token TEXT UNIQUE,
      review_token_sent_at TEXT,
      review_submitted_at TEXT,
      reminder_sent_at TEXT,
      expired_at TEXT,
      UNIQUE(request_id, reviewer_id),
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE,
      FOREIGN KEY(reviewer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(assigned_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL UNIQUE,
      payment_method TEXT NOT NULL,
      payee_name TEXT NOT NULL,
      payee_contact TEXT,
      amount_paid REAL NOT NULL,
      payment_date TEXT NOT NULL,
      confirmation_note TEXT,
      confirmation_file TEXT,
      processed_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE,
      FOREIGN KEY(processed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      completed_by INTEGER NOT NULL,
      funds_used_as_intended TEXT,
      issue_resolved TEXT,
      receipt_received TEXT,
      pastoral_followup_needed TEXT,
      notes TEXT,
      submitted_by_applicant INTEGER DEFAULT 0,
      receipt_file TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE,
      FOREIGN KEY(completed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      recipient_name TEXT,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Queued',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE SET NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  await addColumnIfMissing(database, 'users', 'reviewer_contact_email', 'TEXT');

  await addColumnIfMissing(database, 'requests', 'applicant_user_id', 'INTEGER');
  await addColumnIfMissing(database, 'requests', 'applicant_effort', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'applicant_contribution', 'REAL DEFAULT 0');
  await addColumnIfMissing(database, 'requests', 'other_confirmed_support', 'REAL DEFAULT 0');
  await addColumnIfMissing(database, 'requests', 'dependents_affected', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'effort_actions', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'leader_email', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'leader_phone', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'leader_verification_token', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'leader_verification_sent_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'tracking_token', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'applicant_last_viewed_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'reviewer_1_notified_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'reviewer_2_notified_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'urgency_reason', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'urgency_override_by', 'INTEGER');
  await addColumnIfMissing(database, 'requests', 'urgency_override_at', 'TEXT');

  await addColumnIfMissing(database, 'requests', 'map_group_status', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'map_group_name', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'worker_status', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'worker_duration_value', 'INTEGER');
  await addColumnIfMissing(database, 'requests', 'worker_duration_unit', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'unit_name', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'unit_leader_name', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'unit_leader_email', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'unit_leader_phone', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'unit_leader_verification_token', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'unit_leader_verification_sent_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'unit_leader_verified', "TEXT DEFAULT 'Not Required'");
  await addColumnIfMissing(database, 'requests', 'pastor_informed', 'TEXT');
  await addColumnIfMissing(database, 'documents', 'document_type', "TEXT DEFAULT 'Supporting document'");

  await addColumnIfMissing(database, 'requests', 'finance_confirm_token', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'finance_packet_sent_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'payment_confirmed_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'payment_confirmed_by', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'payment_confirmation_amount', 'REAL');
  await addColumnIfMissing(database, 'requests', 'payment_confirmation_method', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'payment_confirmation_reference', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'payment_confirmation_notes', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'payment_confirmation_file', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'zelle_name', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'zelle_email', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'zelle_phone', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'applicant_outcome_notified_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'applicant_outcome_notified_by', 'INTEGER');

  await addColumnIfMissing(database, 'requests', 'applicant_payment_notified_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'applicant_followup_requested_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'applicant_followup_reminder_sent_at', 'TEXT');
  await addColumnIfMissing(database, 'requests', 'applicant_followup_reminder_count', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(database, 'leader_verifications', 'verifier_name', 'TEXT');
  await addColumnIfMissing(database, 'leader_verifications', 'verifier_email', 'TEXT');
  await addColumnIfMissing(database, 'leader_verifications', 'verifier_phone', 'TEXT');
  await addColumnIfMissing(database, 'leader_verifications', 'support_letter_file', 'TEXT');
  await addColumnIfMissing(database, 'leader_verifications', 'member_confirmed', 'TEXT');
  await addColumnIfMissing(database, 'leader_verifications', 'worker_confirmed', 'TEXT');
  await addColumnIfMissing(database, 'leader_verifications', 'known_duration_value', 'INTEGER');
  await addColumnIfMissing(database, 'leader_verifications', 'known_duration_unit', 'TEXT');
  await addColumnIfMissing(database, 'leader_verifications', 'decision_comments', 'TEXT');
  await addColumnIfMissing(database, 'reviews', 'score_total', 'INTEGER');
  await addColumnIfMissing(database, 'reviews', 'system_score_total', 'INTEGER');
  await addColumnIfMissing(database, 'reviews', 'system_assessment_json', 'TEXT');
  await addColumnIfMissing(database, 'reviews', 'system_assessment_agreement', 'TEXT');
  await addColumnIfMissing(database, 'reviews', 'override_reason', 'TEXT');
  await addColumnIfMissing(database, 'request_reviewers', 'invite_token', 'TEXT');
  await addColumnIfMissing(database, 'request_reviewers', 'accepted_at', 'TEXT');
  await addColumnIfMissing(database, 'request_reviewers', 'declined_at', 'TEXT');
  await addColumnIfMissing(database, 'request_reviewers', 'review_token', 'TEXT');
  await addColumnIfMissing(database, 'request_reviewers', 'review_token_sent_at', 'TEXT');
  await addColumnIfMissing(database, 'request_reviewers', 'review_submitted_at', 'TEXT');

  await addColumnIfMissing(database, 'request_reviewers', 'reminder_sent_at', 'TEXT');
  await addColumnIfMissing(database, 'request_reviewers', 'expired_at', 'TEXT');
  await addColumnIfMissing(database, 'followups', 'submitted_by_applicant', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(database, 'followups', 'receipt_file', 'TEXT');

  await database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_request_reviewers_review_token ON request_reviewers(review_token) WHERE review_token IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviewer_contact_email ON users(lower(reviewer_contact_email)) WHERE role='reviewer' AND reviewer_contact_email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_applicant_user ON requests(applicant_user_id);
    CREATE INDEX IF NOT EXISTS idx_request_reviewers_request ON request_reviewers(request_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_request ON reviews(request_id);
  `);
}

async function logActivity(requestId, userId, action, details = '') {
  const database = await getDb();
  await database.run(
    'INSERT INTO activity_logs (request_id, user_id, action, details) VALUES (?,?,?,?)',
    [requestId || null, userId || null, action, details]
  );
}

module.exports = { getDb, initDb, logActivity };
