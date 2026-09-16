async function getRequestById(db, requestId) {
  return db.get('SELECT * FROM requests WHERE id=?', requestId);
}

async function hasLeaderVerification(db, requestId) {
  return db.get('SELECT id FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC LIMIT 1', requestId);
}

async function countReviewsForRequest(db, requestId) {
  return db.get('SELECT COUNT(*) as count FROM reviews WHERE request_id=?', requestId);
}

async function listPendingActiveReviewerAssignments(db, requestId) {
  return db.all(`
    SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
    FROM request_reviewers rr
    JOIN users u ON u.id=rr.reviewer_id
    WHERE rr.request_id=? AND rr.accepted_at IS NULL AND rr.declined_at IS NULL AND rr.expired_at IS NULL AND rr.notified_at IS NOT NULL
  `, requestId);
}

async function expireReviewerAssignment(db, assignmentId) {
  return db.run('UPDATE request_reviewers SET expired_at=CURRENT_TIMESTAMP WHERE id=?', assignmentId);
}

async function markReviewerReminderSent(db, assignmentId) {
  return db.run('UPDATE request_reviewers SET reminder_sent_at=CURRENT_TIMESTAMP WHERE id=?', assignmentId);
}

async function listActiveReviewerAssignments(db, requestId) {
  return db.all('SELECT * FROM request_reviewers WHERE request_id=? AND declined_at IS NULL AND expired_at IS NULL', requestId);
}

async function listReviewerAutoAssignCandidates(db, requestId, needed) {
  return db.all(`
    SELECT u.id, u.name, COALESCE(u.reviewer_contact_email,u.email) as email,
      (SELECT COUNT(*) FROM request_reviewers rr WHERE rr.reviewer_id=u.id AND rr.declined_at IS NULL AND rr.expired_at IS NULL) AS assignment_count,
      (SELECT COUNT(*) FROM reviews rv WHERE rv.reviewer_id=u.id) AS completed_count
    FROM users u
    WHERE u.active=1 AND u.role='reviewer'
      AND u.id NOT IN (SELECT reviewer_id FROM request_reviewers WHERE request_id=?)
    ORDER BY assignment_count ASC, completed_count ASC, RANDOM()
    LIMIT ?
  `, [requestId, needed]);
}

async function insertReviewerAssignmentIgnore(db, { requestId, reviewerId, assignedBy, inviteToken }) {
  return db.run(
    'INSERT INTO request_reviewers (request_id, reviewer_id, assigned_by, invite_token) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
    [requestId, reviewerId, assignedBy, inviteToken]
  );
}

async function listPendingReviewerNotifications(db, requestId) {
  return db.all(`
    SELECT rr.id as assignment_id, rr.notified_at, rr.invite_token, u.id, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
    FROM request_reviewers rr
    JOIN users u ON u.id = rr.reviewer_id
    WHERE rr.request_id=? AND rr.notified_at IS NULL AND rr.declined_at IS NULL AND rr.expired_at IS NULL
    ORDER BY rr.assigned_at ASC
  `, requestId);
}

async function updateReviewerInviteToken(db, assignmentId, inviteToken) {
  return db.run('UPDATE request_reviewers SET invite_token=? WHERE id=?', [inviteToken, assignmentId]);
}

async function markReviewerNotified(db, assignmentId) {
  return db.run('UPDATE request_reviewers SET notified_at=CURRENT_TIMESTAMP WHERE id=?', assignmentId);
}

async function countActiveReviewerAssignments(db, requestId) {
  return db.get('SELECT COUNT(*) as count FROM request_reviewers WHERE request_id=? AND declined_at IS NULL AND expired_at IS NULL', requestId);
}

async function updateRequestStatus(db, requestId, status) {
  return db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, requestId]);
}

async function listRequestsForReviewerSweep(db) {
  return db.all(`
    SELECT r.id, r.case_id
    FROM requests r
    WHERE r.status IN ('Pastoral Verification Complete','Leader Verification Complete','Assigned to Reviewers','Committee Review','Under Review')
      AND EXISTS (SELECT 1 FROM leader_verifications lv WHERE lv.request_id = r.id)
      AND (SELECT COUNT(*) FROM reviews rv WHERE rv.request_id = r.id) < 2
  `);
}

module.exports = {
  countActiveReviewerAssignments,
  countReviewsForRequest,
  expireReviewerAssignment,
  getRequestById,
  hasLeaderVerification,
  insertReviewerAssignmentIgnore,
  listActiveReviewerAssignments,
  listPendingActiveReviewerAssignments,
  listPendingReviewerNotifications,
  listRequestsForReviewerSweep,
  listReviewerAutoAssignCandidates,
  markReviewerNotified,
  markReviewerReminderSent,
  updateRequestStatus,
  updateReviewerInviteToken
};
