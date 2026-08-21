const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { validateReviewSubmission } = require('../validators/review-validator');

function mountAdminRoutes(app, {
  baseUrl,
  buildFinancePacketZipBuffer,
  buildFinanceSummaryPdfBuffer,
  buildSystemAssessment,
  emailFinanceDecisionPacket,
  ensureTwoReviewerInvites,
  escapeCsv,
  getDb,
  getDecisionArtifacts,
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
}) {
  app.get('/uploads/:filename', requireRole('admin'), async (req, res) => {
    const safeName = path.basename(req.params.filename);
    const db = await getDb();
    const fileRecord = await getStoredFileByKey(db, safeName);
    if (!fileRecord) return res.status(404).render('error', { title: 'File not found', message: 'The uploaded file could not be found.' });
    await sendStoredFile(res, fileRecord, fileRecord.original_name);
  });

  app.get('/dashboard', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const stats = await db.all('SELECT status, COUNT(*) as count FROM requests GROUP BY status');
    const recent = await db.all('SELECT * FROM requests ORDER BY created_at DESC LIMIT 8');
    const totals = await db.get('SELECT COUNT(*) as total, SUM(amount_requested) as requested, SUM(amount_approved) as approved FROM requests');
    res.render('dashboard', { title: 'Dashboard', stats, recent, totals });
  });

  app.get('/requests', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const status = req.query.status || '';
    const category = req.query.category || '';
    const params = [];
    let sql = 'SELECT * FROM requests WHERE 1=1';
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (category) { sql += ' AND request_category=?'; params.push(category); }
    sql += ' ORDER BY created_at DESC';
    const requests = await db.all(sql, params);
    res.render('requests', { title: 'Requests', requests, status, category });
  });

  app.get('/requests/:id/report', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const { request, docs, verifications, assignedReviewers, reviews, reviewSummary } = await getDecisionArtifacts(db, req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
    const categoryDetails = JSON.parse(request.category_details || '{}');
    res.render('request-report', { title: `Review Report ${request.case_id}`, request, docs, verifications, assignedReviewers, reviews, categoryDetails, reviewSummary });
  });

  app.get('/requests/:id/report/download', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const { request, docs, verifications, assignedReviewers, reviews, reviewSummary } = await getDecisionArtifacts(db, req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
    const pdfBuffer = await buildFinanceSummaryPdfBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary });
    const filename = `${request.case_id}-committee-approval-summary.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  });

  app.get('/requests/:id/report/package', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const { request, docs, verifications, assignedReviewers, reviews, reviewSummary } = await getDecisionArtifacts(db, req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
    const zipBuffer = await buildFinancePacketZipBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary });
    const filename = `${request.case_id}-finance-submission-package.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  });

  app.get('/requests/:id', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
    const docs = await db.all('SELECT * FROM documents WHERE request_id=?', req.params.id);
    const users = await db.all("SELECT id,name,COALESCE(reviewer_contact_email,email) as email,role FROM users WHERE active=1 AND role='reviewer' ORDER BY name");
    const assignedReviewers = await db.all(`
      SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
      FROM request_reviewers rr
      JOIN users u ON u.id = rr.reviewer_id
      WHERE rr.request_id=?
      ORDER BY rr.assigned_at ASC
    `, req.params.id);
    const reviews = await db.all('SELECT r.*, u.name as reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.request_id=? ORDER BY r.created_at DESC', req.params.id);
    const verifications = await db.all('SELECT v.*, COALESCE(u.name, v.verifier_name) as verifier_name FROM leader_verifications v LEFT JOIN users u ON u.id=v.verified_by WHERE v.request_id=? ORDER BY v.created_at DESC', req.params.id);
    const leadershipVerifications = await db.all('SELECT * FROM leadership_verifications WHERE request_id=? ORDER BY created_at DESC', req.params.id);
    const logs = await db.all('SELECT l.*, u.name as user_name FROM activity_logs l LEFT JOIN users u ON u.id=l.user_id WHERE l.request_id=? ORDER BY l.created_at DESC', req.params.id);
    const applicantFollowup = await db.get('SELECT * FROM followups WHERE request_id=? AND submitted_by_applicant=1 ORDER BY created_at DESC LIMIT 1', req.params.id);
    res.render('request-detail', {
      title: request.case_id,
      request,
      docs,
      users,
      assignedReviewers,
      reviews,
      verifications,
      leadershipVerifications,
      logs,
      applicantFollowup,
      reviewSummary: reviewScoreSummary(reviews),
      categoryDetails: JSON.parse(request.category_details || '{}')
    });
  });

  app.post('/requests/:id/status', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [req.body.status, req.params.id]);
    await logActivity(req.params.id, req.session.user.id, 'Status updated', req.body.status);
    res.redirect(`/requests/${req.params.id}`);
  });

  app.post('/requests/:id/urgency', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const allowed = ['Emergency', 'Urgent', 'Standard'];
    const urgency = allowed.includes(req.body.urgency) ? req.body.urgency : 'Standard';
    const reason = req.body.urgency_reason || '';
    await db.run(
      'UPDATE requests SET urgency=?, urgency_reason=?, urgency_override_by=?, urgency_override_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [urgency, reason, req.session.user.id, req.params.id]
    );
    await logActivity(req.params.id, req.session.user.id, 'Urgency triage updated', `${urgency}: ${reason}`);
    res.redirect(`/requests/${req.params.id}`);
  });

  app.post('/requests/:id/assign-reviewer', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
    const reviewer = await db.get("SELECT id,name,COALESCE(reviewer_contact_email,email) as email FROM users WHERE id=? AND role='reviewer' AND active=1", req.body.reviewer_id);
    if (!reviewer) return res.status(400).render('error', { title: 'Reviewer unavailable', message: 'Please choose an active reviewer from the Reviewer Directory.' });

    const activeCount = await db.get('SELECT COUNT(*) as count FROM request_reviewers WHERE request_id=? AND declined_at IS NULL AND expired_at IS NULL', req.params.id);
    if ((activeCount.count || 0) >= 2) return res.status(400).render('error', { title: 'Two reviewers already assigned', message: 'This case already has two active reviewer assignments. Remove or replace an assignment before adding another reviewer.' });

    const existing = await db.get('SELECT * FROM request_reviewers WHERE request_id=? AND reviewer_id=?', [req.params.id, reviewer.id]);
    if (existing && !existing.declined_at && !existing.expired_at) return res.redirect(`/requests/${req.params.id}?reviewerAlreadyAssigned=1`);

    const inviteToken = crypto.randomBytes(32).toString('hex');
    if (existing) {
      await db.run('UPDATE request_reviewers SET assigned_by=?, assigned_at=CURRENT_TIMESTAMP, notified_at=NULL, invite_token=?, accepted_at=NULL, declined_at=NULL, review_token=NULL, review_token_sent_at=NULL, review_submitted_at=NULL, reminder_sent_at=NULL, expired_at=NULL WHERE id=?', [req.session.user.id, inviteToken, existing.id]);
    } else {
      await db.run('INSERT INTO request_reviewers (request_id, reviewer_id, assigned_by, invite_token) VALUES (?,?,?,?)', [req.params.id, reviewer.id, req.session.user.id, inviteToken]);
    }
    await logActivity(req.params.id, req.session.user.id, 'Reviewer assigned', `${reviewer.name} <${reviewer.email}>`);

    const pastoralDone = await db.get('SELECT id FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC LIMIT 1', req.params.id);
    if (pastoralDone) await ensureTwoReviewerInvites(db, req, req.params.id);
    res.redirect(`/requests/${req.params.id}?reviewerAssigned=1`);
  });

  app.post('/requests/:id/reviewers/:assignmentId/remove', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const assignment = await db.get('SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email FROM request_reviewers rr JOIN users u ON u.id=rr.reviewer_id WHERE rr.id=? AND rr.request_id=?', [req.params.assignmentId, req.params.id]);
    if (!assignment) return res.redirect(`/requests/${req.params.id}`);
    const review = await db.get('SELECT id FROM reviews WHERE request_id=? AND reviewer_id=?', [req.params.id, assignment.reviewer_id]);
    if (review) return res.status(400).render('error', { title: 'Cannot remove completed review', message: 'This reviewer has already submitted an assessment. The review remains part of the audit record.' });
    await db.run('DELETE FROM request_reviewers WHERE id=?', assignment.id);
    await logActivity(req.params.id, req.session.user.id, 'Reviewer assignment removed', `${assignment.name} <${assignment.email}>`);
    res.redirect(`/requests/${req.params.id}?reviewerRemoved=1`);
  });

  app.post('/requests/:id/reviewers/:assignmentId/resend', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const assignment = await db.get('SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email, r.case_id FROM request_reviewers rr JOIN users u ON u.id=rr.reviewer_id JOIN requests r ON r.id=rr.request_id WHERE rr.id=? AND rr.request_id=?', [req.params.assignmentId, req.params.id]);
    if (!assignment) return res.redirect(`/requests/${req.params.id}`);
    if (assignment.review_submitted_at) return res.redirect(`/requests/${req.params.id}?reviewAlreadySubmitted=1`);
    if (assignment.accepted_at && assignment.review_token) {
      const link = `${baseUrl(req)}/review/${assignment.review_token}`;
      await sendNotification({ db, requestId: req.params.id, recipientName: assignment.name, recipientEmail: assignment.email, subject: `Secure review link: ${assignment.case_id}`, body: `Dear ${assignment.name},\n\nHere is your secure review link for ${assignment.case_id}:\n${link}\n\nPlease do not forward this link.\n\nCCI America Financial Assistance Committee` });
    } else {
      const token = assignment.invite_token || crypto.randomBytes(32).toString('hex');
      if (!assignment.invite_token) await db.run('UPDATE request_reviewers SET invite_token=? WHERE id=?', [token, assignment.id]);
      const link = `${baseUrl(req)}/review-invite/${token}`;
      await sendNotification({ db, requestId: req.params.id, recipientName: assignment.name, recipientEmail: assignment.email, subject: `Review availability requested: ${assignment.case_id}`, body: `Dear ${assignment.name},\n\nPlease accept or decline the confidential review invitation using this secure link:\n${link}\n\nCCI America Financial Assistance Committee` });
      await db.run('UPDATE request_reviewers SET notified_at=CURRENT_TIMESTAMP WHERE id=?', assignment.id);
    }
    await logActivity(req.params.id, req.session.user.id, 'Reviewer link resent', `${assignment.email}`);
    res.redirect(`/requests/${req.params.id}?reviewerLinkResent=1`);
  });

  app.post('/requests/:id/assign', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });

    const leaderResponse = await db.get('SELECT id FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC LIMIT 1', req.params.id);
    if (!leaderResponse) {
      const pendingStatus = request.worker_status === 'Yes' && request.unit_leader_verified !== 'Complete'
        ? 'Awaiting Leadership Verification'
        : 'Awaiting Pastoral Verification';
      await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [pendingStatus, req.params.id]);
      await logActivity(req.params.id, req.session.user.id, 'Reviewer assignment pending', 'Reviewer invitations will be sent automatically after the required verification steps are completed.');
      return res.redirect(`/requests/${req.params.id}`);
    }

    const notifiedCount = await ensureTwoReviewerInvites(db, req, req.params.id);
    await logActivity(req.params.id, req.session.user.id, 'Reviewer invitations prepared', `${notifiedCount} reviewer invitation(s) sent or queued. The system selects two reviewers using least-assigned/random rotation.`);
    res.redirect(`/requests/${req.params.id}`);
  });

  app.post('/requests/:id/verification', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    await db.run('INSERT INTO leader_verifications (request_id, verified_by, verifier_name, verifier_email, knows_applicant, active_connection, aware_of_need, pastoral_context, recommendation) VALUES (?,?,?,?,?,?,?,?,?)', [req.params.id, req.session.user.id, req.session.user.name, req.session.user.email, req.body.knows_applicant, req.body.active_connection, req.body.aware_of_need, req.body.pastoral_context || '', req.body.recommendation || '']);
    await db.run('UPDATE requests SET leader_verified=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [req.body.knows_applicant === 'Yes' ? 'Yes' : 'No/Unclear', 'Pastoral Verification Complete', req.params.id]);
    await logActivity(req.params.id, req.session.user.id, 'Pastoral verification recorded', req.body.knows_applicant);
    const notifiedCount = await notifyAssignedReviewers(db, req, req.params.id);
    if (notifiedCount > 0) {
      await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Assigned to Reviewers', req.params.id]);
      await logActivity(req.params.id, req.session.user.id, 'Assigned reviewers notified after pastoral verification', `${notifiedCount} reviewer(s) notified`);
    }
    res.redirect(`/requests/${req.params.id}`);
  });

  app.post('/requests/:id/review', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Request not found', message: 'The requested case could not be found.' });
    const docs = await db.all('SELECT * FROM documents WHERE request_id=? ORDER BY uploaded_at ASC', req.params.id);
    const verifications = await db.all('SELECT * FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC', req.params.id);
    const leadershipVerifications = await db.all('SELECT * FROM leadership_verifications WHERE request_id=? ORDER BY created_at DESC', req.params.id);
    const systemAssessment = await buildSystemAssessment(db, request, docs, verifications, leadershipVerifications);

    try {
      validateReviewSubmission(req.body, systemAssessment);
    } catch (err) {
      return res.status(400).render('error', {
        title: err.message === 'Please briefly explain any disagreement with, or change to, the system-generated assessment.' ? 'Reason required' : 'Incomplete review',
        message: err.message
      });
    }

    await db.run(`INSERT INTO reviews (
      request_id, reviewer_id, conflict_of_interest, eligibility_rating, urgency_rating, severity_rating, gap_rating, effort_rating, history_rating, policy_rating, documentation_rating,
      score_total, system_score_total, system_assessment_json, system_assessment_agreement, override_reason, actual_gap, recommended_decision, recommended_amount, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(request_id, reviewer_id) DO UPDATE SET
      conflict_of_interest=excluded.conflict_of_interest, eligibility_rating=excluded.eligibility_rating, urgency_rating=excluded.urgency_rating,
      severity_rating=excluded.severity_rating, gap_rating=excluded.gap_rating, effort_rating=excluded.effort_rating, history_rating=excluded.history_rating,
      policy_rating=excluded.policy_rating, documentation_rating=excluded.documentation_rating, score_total=excluded.score_total,
      system_score_total=excluded.system_score_total, system_assessment_json=excluded.system_assessment_json,
      system_assessment_agreement=excluded.system_assessment_agreement, override_reason=excluded.override_reason, actual_gap=excluded.actual_gap,
      recommended_decision=excluded.recommended_decision, recommended_amount=excluded.recommended_amount, notes=excluded.notes, updated_at=CURRENT_TIMESTAMP`, [
      req.params.id, req.session.user.id, req.body.conflict_of_interest, null, Number(req.body.urgency_rating), Number(req.body.severity_rating), Number(req.body.gap_rating), Number(req.body.effort_rating), Number(req.body.history_rating),
      Number(req.body.policy_rating), Number(req.body.documentation_rating), reviewScoreTotal(req.body), systemAssessment.total, JSON.stringify(systemAssessment), req.body.system_assessment_agreement,
      req.body.override_reason || '', Number(systemAssessment.actualGap || 0), req.body.recommended_decision, req.body.recommended_amount || null, req.body.notes || ''
    ]);
    await logActivity(req.params.id, req.session.user.id, 'Reviewer assessment saved', `${req.body.recommended_decision}; system ${systemAssessment.total}/21; reviewer ${reviewScoreTotal(req.body)}/21`);
    const reviewCount = await db.get('SELECT COUNT(*) as count FROM reviews WHERE request_id=?', req.params.id);
    if ((reviewCount.count || 0) >= 2) {
      await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Reviews Complete', req.params.id]);
    } else {
      await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Committee Review', req.params.id]);
    }
    res.redirect(`/requests/${req.params.id}`);
  });

  app.post('/requests/:id/decision', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const status = req.body.decision === 'Escalated to Pastorate' ? 'Escalated to Pastorate' : 'Decision Made';
    await db.run('UPDATE requests SET decision=?, amount_approved=?, decision_notes=?, pastorate_required=?, pastorate_decision=?, documents_complete=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [
      req.body.decision, req.body.amount_approved || null, req.body.decision_notes || '', req.body.pastorate_required || 'No', req.body.pastorate_decision || '', req.body.documents_complete || 'Pending', status, req.params.id
    ]);
    await logActivity(req.params.id, req.session.user.id, 'Decision recorded', req.body.decision);
    await emailFinanceDecisionPacket(db, req, req.params.id);

    const updatedRequest = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
    if (updatedRequest && !isApprovalDecision(updatedRequest.decision) && updatedRequest.decision !== 'Escalated to Pastorate') {
      const trackingLink = `${baseUrl(req)}/track/${updatedRequest.tracking_token}`;
      await sendNotification({
        db,
        requestId: updatedRequest.id,
        recipientName: updatedRequest.full_name,
        recipientEmail: updatedRequest.email,
        subject: `CCI America financial assistance decision: ${updatedRequest.case_id}`,
        body: `Dear ${updatedRequest.full_name},

Thank you for submitting your financial assistance request to CCI America. After confidential review, the committee decision has been recorded as: ${updatedRequest.decision}.

Case ID: ${updatedRequest.case_id}

You may continue to track the status of your request here:
${trackingLink}

CCI America Financial Assistance Committee`
      });
      await db.run('UPDATE requests SET applicant_outcome_notified_at=CURRENT_TIMESTAMP, applicant_outcome_notified_by=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [req.session.user.id, 'Declined', updatedRequest.id]);
      await logActivity(updatedRequest.id, req.session.user.id, 'Applicant decision email sent', updatedRequest.decision);
    }

    res.redirect(`/requests/${req.params.id}?decisionRecorded=1&financePacket=sent`);
  });

  app.post('/requests/:id/send-closeout-now', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
    if (!request.payment_confirmed_at) {
      return res.status(400).render('error', { title: 'Payment not confirmed', message: 'The close-out form can only be sent after Finance has confirmed payment.' });
    }
    const existingFollowup = await db.get('SELECT id FROM followups WHERE request_id=? AND submitted_by_applicant=1 ORDER BY created_at DESC LIMIT 1', request.id);
    if (existingFollowup) return res.redirect(`/requests/${request.id}?closeoutAlreadySubmitted=1`);
    if (request.applicant_followup_requested_at) return res.redirect(`/requests/${request.id}?closeoutAlreadySent=1`);

    await sendApplicantCloseoutRequest(db, req, request);
    await logActivity(request.id, req.session.user.id, 'Admin sent close-out form immediately', 'Admin bypassed the normal 3-day waiting period.');
    res.redirect(`/requests/${request.id}?closeoutSentNow=1`);
  });

  app.post('/requests/:id/notify-applicant-outcome', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
    if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
    const approved = isApprovalDecision(request.decision);
    const trackingLink = `${baseUrl(req)}/track/${request.tracking_token}`;
    let subject;
    let body;
    let newStatus;
    if (approved) {
      subject = `CCI America financial assistance update: ${request.case_id}`;
      body = `Dear ${request.full_name},

Your financial assistance request has been approved by the CCI America Financial Assistance Committee.

Case ID: ${request.case_id}
Decision: ${request.decision}
Approved amount: ${money(request.amount_approved || request.amount_requested)}

Finance has confirmed payment processing. Please expect payment/support according to the payment details you provided in your application.

For record-keeping and stewardship purposes, a short close-out form will normally be sent after 3 days. No action is needed right now.

You may continue to track your request here:
${trackingLink}

CCI America Financial Assistance Committee`;
      newStatus = request.payment_confirmed_at ? 'Payment Confirmed' : 'Decision Made';
    } else {
      subject = `CCI America financial assistance decision: ${request.case_id}`;
      body = `Dear ${request.full_name},

Thank you for submitting your financial assistance request to CCI America. After confidential review, the committee decision has been recorded as: ${request.decision || 'Not approved'}.

Case ID: ${request.case_id}

Please contact the committee if further clarification is needed.

CCI America Financial Assistance Committee`;
      newStatus = 'Declined';
    }
    await sendNotification({ db, requestId: request.id, recipientName: request.full_name, recipientEmail: request.email, subject, body });
    await db.run('UPDATE requests SET applicant_outcome_notified_at=CURRENT_TIMESTAMP, applicant_outcome_notified_by=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [req.session.user.id, newStatus, request.id]);
    await logActivity(request.id, req.session.user.id, 'Applicant outcome email sent', approved ? 'Approval/payment notice sent.' : 'Decision notice sent.');
    res.redirect(`/requests/${request.id}`);
  });

  app.get('/finance', (req, res) => res.status(404).render('error', { title: 'Not found', message: 'This module has been removed.' }));
  app.get('/finance/:id', (req, res) => res.status(404).render('error', { title: 'Not found', message: 'This module has been removed.' }));
  app.post('/finance/:id/payment', (req, res) => res.status(404).render('error', { title: 'Not found', message: 'This module has been removed.' }));

  app.post('/requests/:id/followup', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    await db.run('INSERT INTO followups (request_id, completed_by, funds_used_as_intended, issue_resolved, receipt_received, pastoral_followup_needed, notes) VALUES (?,?,?,?,?,?,?)', [req.params.id, req.session.user.id, req.body.funds_used_as_intended, req.body.issue_resolved, req.body.receipt_received, req.body.pastoral_followup_needed, req.body.notes || '']);
    await db.run('UPDATE requests SET status=?, follow_up_needed=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Closed', 'No', req.params.id]);
    await logActivity(req.params.id, req.session.user.id, 'Follow-up completed and case closed', req.body.issue_resolved);

    const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
    const reviewers = await db.all(`
      SELECT DISTINCT u.name, COALESCE(u.reviewer_contact_email,u.email) as email
      FROM request_reviewers rr
      JOIN users u ON u.id = rr.reviewer_id
      WHERE rr.request_id=? AND rr.accepted_at IS NOT NULL
    `, req.params.id);
    for (const reviewer of reviewers) {
      await sendNotification({
        db,
        requestId: req.params.id,
        recipientName: reviewer.name,
        recipientEmail: reviewer.email,
        subject: `Thank you for reviewing ${request.case_id}`,
        body: `Dear ${reviewer.name},

Thank you for completing your review for ${request.case_id}. The request has now been closed by the admin/committee lead.

We appreciate your service to the CCI America Financial Assistance Committee.

CCI America Financial Assistance Committee`
      });
    }
    if (request) {
      await sendNotification({
        db,
        requestId: req.params.id,
        recipientName: request.full_name,
        recipientEmail: request.email,
        subject: `CCI America financial assistance request closed: ${request.case_id}`,
        body: `Dear ${request.full_name},

Thank you for submitting your proof-of-use follow-up. Your request ${request.case_id} has now been closed.

CCI America Financial Assistance Committee`
      });
    }

    res.redirect(`/requests/${req.params.id}?followupClosed=1`);
  });

  app.get('/reports', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const byCategory = await db.all('SELECT request_category, COUNT(*) as count, SUM(amount_requested) as requested, SUM(amount_approved) as approved FROM requests GROUP BY request_category ORDER BY count DESC');
    const byStatus = await db.all('SELECT status, COUNT(*) as count FROM requests GROUP BY status ORDER BY count DESC');
    const byMonth = await db.all("SELECT substr(created_at,1,7) as month, COUNT(*) as count, SUM(amount_approved) as approved FROM requests GROUP BY substr(created_at,1,7) ORDER BY month DESC");
    res.render('reports', { title: 'Reports', byCategory, byStatus, byMonth });
  });

  app.get('/reports/export.csv', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const rows = await db.all('SELECT case_id, created_at, full_name, email, phone, cci_community_name, request_category, amount_requested, total_amount_needed, due_date, urgency, urgency_reason, status, leader_verified, documents_complete, decision, amount_approved, pastorate_required, pastorate_decision, follow_up_needed FROM requests ORDER BY created_at DESC');
    const headers = Object.keys(rows[0] || { case_id: '', created_at: '' });
    const csv = [headers.join(','), ...rows.map(row => headers.map(header => escapeCsv(row[header])).join(','))].join('\n');
    res.header('Content-Type', 'text/csv');
    res.attachment('cci-financial-support-report.csv');
    res.send(csv);
  });

  app.get('/admin/reviewers', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const reviewers = await db.all(`
      SELECT u.id,u.name,COALESCE(u.reviewer_contact_email,u.email) as email,u.active,u.created_at,
        (SELECT COUNT(*) FROM request_reviewers rr WHERE rr.reviewer_id=u.id) AS total_assignments,
        (SELECT COUNT(*) FROM reviews rv WHERE rv.reviewer_id=u.id) AS completed_reviews,
        (SELECT COUNT(*) FROM request_reviewers rr WHERE rr.reviewer_id=u.id AND rr.accepted_at IS NOT NULL AND rr.review_submitted_at IS NULL AND rr.expired_at IS NULL) AS open_reviews
      FROM users u
      WHERE u.role='reviewer'
      ORDER BY u.active DESC, u.name ASC
    `);
    res.render('reviewers', { title: 'Reviewer Directory', reviewers, error: req.query.error || null, added: req.query.added || null });
  });

  app.post('/admin/reviewers', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!name || !email) return res.redirect(`/admin/reviewers?error=${encodeURIComponent('Reviewer name and email are required.')}`);
    const existingReviewer = await db.get("SELECT id FROM users WHERE role='reviewer' AND lower(COALESCE(reviewer_contact_email,email))=lower(?)", email);
    if (existingReviewer) {
      await db.run('UPDATE users SET name=?, reviewer_contact_email=?, active=1 WHERE id=?', [name, email, existingReviewer.id]);
      return res.redirect('/admin/reviewers?added=reactivated');
    }
    const internalEmail = `reviewer-${crypto.randomBytes(12).toString('hex')}@internal.invalid`;
    const randomPassword = crypto.randomBytes(48).toString('hex');
    const hash = await bcrypt.hash(randomPassword, 12);
    await db.run('INSERT INTO users (name,email,password_hash,reviewer_contact_email,role,active) VALUES (?,?,?,?,?,1)', [name, internalEmail, hash, email, 'reviewer']);
    await logActivity(null, req.session.user.id, 'Reviewer added to directory', `${name} <${email}>`);
    res.redirect('/admin/reviewers?added=1');
  });

  app.post('/admin/reviewers/:id/toggle', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const reviewer = await db.get("SELECT * FROM users WHERE id=? AND role='reviewer'", req.params.id);
    if (!reviewer) return res.redirect('/admin/reviewers');
    await db.run('UPDATE users SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=?', reviewer.id);
    await logActivity(null, req.session.user.id, reviewer.active ? 'Reviewer deactivated' : 'Reviewer activated', `${reviewer.name} <${reviewer.reviewer_contact_email || reviewer.email}>`);
    res.redirect('/admin/reviewers');
  });

  app.get('/admin/users', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    const users = await db.all("SELECT id,name,email,role,active,created_at FROM users WHERE role IN ('admin','applicant') ORDER BY created_at DESC");
    res.render('users', { title: 'Login Accounts', users, error: null });
  });

  app.post('/admin/users', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    try {
      const role = ['admin', 'applicant'].includes(req.body.role) ? req.body.role : 'applicant';
      if (!req.body.password || String(req.body.password).length < 8) throw new Error('Password must contain at least 8 characters.');
      const hash = await bcrypt.hash(req.body.password, 12);
      await db.run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', [req.body.name, String(req.body.email || '').trim().toLowerCase(), hash, role]);
      await logActivity(null, req.session.user.id, 'Login account created', `${req.body.email} (${role})`);
      res.redirect('/admin/users');
    } catch (err) {
      const dbUsers = await db.all("SELECT id,name,email,role,active,created_at FROM users WHERE role IN ('admin','applicant') ORDER BY created_at DESC");
      res.status(400).render('users', { title: 'Login Accounts', users: dbUsers, error: err.message || 'Could not create account. Email may already exist.' });
    }
  });

  app.post('/admin/users/:id/toggle', requireRole('admin'), async (req, res) => {
    const db = await getDb();
    await db.run("UPDATE users SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=? AND role IN ('admin','applicant')", req.params.id);
    res.redirect('/admin/users');
  });
}

module.exports = {
  mountAdminRoutes
};
