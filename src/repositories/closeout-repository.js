async function markApplicantPaymentNotified(db, requestId) {
  return db.run(
    'UPDATE requests SET applicant_payment_notified_at=CURRENT_TIMESTAMP, applicant_outcome_notified_at=CURRENT_TIMESTAMP, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    ['Payment Confirmed', requestId]
  );
}

async function markApplicantFollowupRequested(db, requestId) {
  return db.run(
    'UPDATE requests SET applicant_followup_requested_at=CURRENT_TIMESTAMP, applicant_followup_reminder_sent_at=CURRENT_TIMESTAMP, applicant_followup_reminder_count=0, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    ['Follow-Up Requested', requestId]
  );
}

async function markApplicantFollowupReminderSent(db, requestId, count) {
  return db.run(
    'UPDATE requests SET applicant_followup_reminder_sent_at=CURRENT_TIMESTAMP, applicant_followup_reminder_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    [count, requestId]
  );
}

async function listRequestsForCloseoutSweep(db) {
  return db.all(`
    SELECT r.*,
      (SELECT COUNT(*) FROM followups f WHERE f.request_id = r.id AND f.submitted_by_applicant = 1) AS applicant_followup_count
    FROM requests r
    WHERE r.payment_confirmed_at IS NOT NULL
      AND r.applicant_payment_notified_at IS NOT NULL
      AND r.status NOT IN ('Closed','Declined')
  `);
}

module.exports = {
  listRequestsForCloseoutSweep,
  markApplicantFollowupReminderSent,
  markApplicantFollowupRequested,
  markApplicantPaymentNotified
};
