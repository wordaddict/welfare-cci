const crypto = require('crypto');
const path = require('path');
const { calculateUrgencyResult, generateCaseId, parseCategoryDetails } = require('../helpers');
const { validateApplicantSubmission, validateLeadershipVerification, validatePastorVerification } = require('../validators/request-flow-validator');
const { validateReviewSubmission } = require('../validators/review-validator');

function normalizeApplicantName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function mountPublicRoutes(app, {
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
}) {
  async function renderLeadershipVerification(req, res) {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE unit_leader_verification_token=?', req.params.token);
    if (!request) return res.status(404).render('error', { title: 'Invalid link', message: 'This leadership verification link is invalid or has expired.', publicPage: true });
    if (request.worker_status !== 'Yes') return res.status(400).render('error', { title: 'Leadership verification not required', message: 'Leadership verification is not required for this request.', publicPage: true });
    const existing = await db.get('SELECT id FROM leadership_verifications WHERE request_id=? ORDER BY created_at DESC LIMIT 1', request.id);
    if (existing) return res.render('leadership-verify-success', { title: 'Leadership Verification Submitted', request, publicPage: true });
    res.render('leadership-verify', { title: 'Leadership Verification', request, token: req.params.token, error: null, publicPage: true });
  }

  async function submitLeadershipVerification(req, res) {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE unit_leader_verification_token=?', req.params.token);
    if (!request) return res.status(404).render('error', { title: 'Invalid link', message: 'This leadership verification link is invalid or has expired.', publicPage: true });
    if (request.worker_status !== 'Yes') return res.status(400).render('error', { title: 'Leadership verification not required', message: 'Leadership verification is not required for this request.', publicPage: true });

    const existing = await db.get('SELECT id FROM leadership_verifications WHERE request_id=? ORDER BY created_at DESC LIMIT 1', request.id);
    if (existing) return res.render('leadership-verify-success', { title: 'Leadership Verification Submitted', request, publicPage: true });

    try {
      validateLeadershipVerification(req.body);
    } catch (err) {
      return res.status(400).render('leadership-verify', {
        title: 'Leadership Verification',
        request,
        token: req.params.token,
        error: err.message,
        publicPage: true
      });
    }

    await db.run(`INSERT INTO leadership_verifications (
      request_id, verifier_name, verifier_email, verifier_phone, unit_name,
      worker_confirmed, unit_confirmed, service_duration_value, service_duration_unit, comments
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
      request.id, req.body.verifier_name, req.body.verifier_email, req.body.verifier_phone, request.unit_name || '',
      req.body.worker_confirmed, req.body.unit_confirmed, Number(req.body.service_duration_value), req.body.service_duration_unit, req.body.comments
    ]);

    await db.run('UPDATE requests SET unit_leader_verified=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Complete', 'Awaiting Pastoral Verification', request.id]);
    await logActivity(request.id, null, 'Leadership verification submitted', `${req.body.verifier_name} submitted Unit Head verification`);

    if (!request.leader_verification_sent_at) {
      const pastorLink = `${baseUrl(req)}/pastor-verify/${request.leader_verification_token}`;
      await sendNotification({
        db,
        requestId: request.id,
        recipientName: request.leader_name,
        recipientEmail: request.leader_email,
        subject: `CCI America pastoral verification needed for ${request.full_name}`,
        body: `Dear ${request.leader_name},

${request.full_name} identified you as their Pastor for a confidential financial assistance request submitted to CCI America.

The required Celeforce leadership verification has now been completed. The secure pastoral verification page below will show the applicant's relevant submitted information. Please review it and complete all required pastoral verification questions.

${pastorLink}

This request should be handled confidentially.

CCI America Financial Assistance Committee`
      });
      await db.run('UPDATE requests SET leader_verification_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?', request.id);
      await logActivity(request.id, null, 'Pastoral verification email prepared after leadership verification', request.leader_email);
    }

    res.render('leadership-verify-success', { title: 'Leadership Verification Submitted', request, publicPage: true });
  }

  async function renderPastorVerification(req, res) {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE leader_verification_token=?', req.params.token);
    if (!request) return res.status(404).render('error', { title: 'Invalid link', message: 'This pastoral verification link is invalid or has expired.', publicPage: true });
    if (request.worker_status === 'Yes' && request.unit_leader_verified !== 'Complete') {
      return res.status(403).render('error', { title: 'Leadership verification pending', message: 'This request must complete Celeforce leadership verification before pastoral verification can begin.', publicPage: true });
    }
    const existing = await db.get('SELECT id FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC LIMIT 1', request.id);
    if (existing) return res.render('leader-verify-success', { title: 'Pastoral Verification Submitted', request, publicPage: true });
    const categoryDetails = JSON.parse(request.category_details || '{}');
    res.render('leader-verify', { title: 'Pastoral Verification', request, token: req.params.token, categoryDetails, error: null, publicPage: true });
  }

  async function submitPastorVerification(req, res) {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE leader_verification_token=?', req.params.token);
    if (!request) return res.status(404).render('error', { title: 'Invalid link', message: 'This pastoral verification link is invalid or has expired.', publicPage: true });

    if (request.worker_status === 'Yes' && request.unit_leader_verified !== 'Complete') {
      return res.status(403).render('error', { title: 'Leadership verification pending', message: 'This request must complete Celeforce leadership verification before pastoral verification can begin.', publicPage: true });
    }

    const alreadySubmitted = await db.get('SELECT id FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC LIMIT 1', request.id);
    if (alreadySubmitted) return res.render('leader-verify-success', { title: 'Pastoral Verification Submitted', request, publicPage: true });

    const categoryDetails = JSON.parse(request.category_details || '{}');
    try {
      validatePastorVerification(req.body);
    } catch (err) {
      return res.status(400).render('leader-verify', {
        title: 'Pastoral Verification',
        request,
        token: req.params.token,
        categoryDetails,
        error: err.message,
        publicPage: true
      });
    }

    const storedSupportLetter = req.file ? await saveUploadedFile(db, req.file, { folder: `pastoral-support/${request.case_id}` }) : null;
    await db.run(`INSERT INTO leader_verifications (
      request_id, verified_by, verifier_name, verifier_email, verifier_phone,
      knows_applicant, active_connection, aware_of_need, pastoral_context, recommendation, support_letter_file,
      member_confirmed, worker_confirmed, known_duration_value, known_duration_unit, decision_comments
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      request.id, null, req.body.verifier_name, req.body.verifier_email, req.body.verifier_phone,
      'Yes', req.body.is_regular_participant, 'Not separately asked', req.body.decision_comments, '', storedSupportLetter ? storedSupportLetter.storageKey : '',
      req.body.is_member, req.body.is_worker, Number(req.body.known_duration_value), req.body.known_duration_unit, req.body.decision_comments
    ]);

    await db.run('UPDATE requests SET leader_verified=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Complete', 'Pastoral Verification Complete', request.id]);
    await logActivity(request.id, null, 'Pastoral verification submitted', `${req.body.verifier_name} submitted pastoral verification`);

    const notifiedCount = await notifyAssignedReviewers(db, req, request.id);
    if (notifiedCount > 0) {
      await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Assigned to Reviewers', request.id]);
      await logActivity(request.id, null, 'Assigned reviewers notified after pastoral verification', `${notifiedCount} reviewer(s) notified`);
    } else {
      const activeAssignments = await db.get('SELECT COUNT(*) as count FROM request_reviewers WHERE request_id=? AND declined_at IS NULL AND expired_at IS NULL', request.id);
      if ((activeAssignments.count || 0) === 0) {
        await sendNotification({
          db,
          requestId: request.id,
          recipientName: 'CCI Welfare Admin',
          recipientEmail: process.env.ADMIN_EMAIL || 'admin@cci.local',
          subject: `Reviewer assignment needed: ${request.case_id}`,
          body: `Pastoral verification is complete for ${request.case_id}. Please log in to the Admin portal and assign two reviewers from the Reviewer Directory.`
        });
      }
    }

    res.render('leader-verify-success', { title: 'Pastoral Verification Submitted', request, publicPage: true });
  }

  async function getReviewAccess(db, token) {
    return db.get(`
      SELECT rr.*, r.case_id, r.id as request_id_value, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email
      FROM request_reviewers rr
      JOIN requests r ON r.id=rr.request_id
      JOIN users u ON u.id=rr.reviewer_id
      WHERE rr.review_token=? AND rr.accepted_at IS NOT NULL AND rr.declined_at IS NULL AND rr.expired_at IS NULL
    `, token);
  }

  app.get('/apply', requireRole('applicant'), (req, res) => res.render('apply', { title: 'Financial Assistance Request', error: null }));

  app.post('/apply', requireRole('applicant'), upload.fields([
    { name: 'membership_certificate', maxCount: 1 },
    { name: 'map_leader_attestation', maxCount: 1 },
    { name: 'documents', maxCount: 6 }
  ]), async (req, res) => {
    try {
      const { effortActions, membershipCertificate, mapLeaderAttestation, supportingDocuments } = validateApplicantSubmission({
        body: req.body,
        files: req.files
      });

      const db = await getDb();
      const details = parseCategoryDetails(req.body);
      const caseId = await generateCaseId(db);
      const urgencyResult = calculateUrgencyResult(req.body.due_date, details, req.body.request_category, req.body.consequence, req.body.situation);
      const urgency = urgencyResult.urgency;
      const pastorToken = crypto.randomBytes(24).toString('hex');
      const unitLeaderToken = req.body.worker_status === 'Yes' ? crypto.randomBytes(24).toString('hex') : null;
      const trackingToken = crypto.randomBytes(24).toString('hex');
      const nowIso = new Date().toISOString();
      const initialStatus = req.body.worker_status === 'Yes' ? 'Awaiting Leadership Verification' : 'Awaiting Pastoral Verification';

      const columns = [
        'case_id', 'applicant_user_id', 'full_name', 'email', 'phone', 'city_state', 'cci_connection_type', 'cci_community_name',
        'leader_name', 'leader_role', 'leader_contact', 'leader_email', 'leader_phone', 'leader_verification_token', 'leader_verification_sent_at', 'tracking_token',
        'connection_duration', 'membership_status', 'map_group_status', 'map_group_name', 'worker_status', 'worker_duration_value', 'worker_duration_unit',
        'unit_name', 'unit_leader_name', 'unit_leader_email', 'unit_leader_phone', 'unit_leader_verification_token', 'unit_leader_verification_sent_at', 'unit_leader_verified', 'pastor_informed',
        'request_category', 'amount_requested', 'total_amount_needed', 'due_date', 'situation', 'consequence', 'one_time_or_ongoing', 'prior_assistance', 'prior_assistance_details', 'applicant_effort', 'applicant_contribution', 'other_confirmed_support', 'dependents_affected', 'effort_actions',
        'direct_payment_possible', 'payment_details', 'direct_payment_explanation', 'zelle_name', 'zelle_email', 'zelle_phone', 'category_details',
        'applicant_declaration', 'consent_leader_contact', 'consent_proof_of_use', 'urgency', 'urgency_reason', 'status', 'leader_verified'
      ];
      const values = [
        caseId, req.session.user.id, req.body.full_name, req.body.email, req.body.phone, req.body.city_state, req.body.cci_connection_type, req.body.cci_community_name,
        req.body.leader_name, 'Pastor', `${req.body.leader_email} / ${req.body.leader_phone}`, req.body.leader_email, req.body.leader_phone, pastorToken,
        req.body.worker_status === 'Yes' ? null : nowIso, trackingToken,
        req.body.connection_duration, req.body.membership_status,
        req.body.membership_status === 'No' ? req.body.map_group_status : null,
        req.body.membership_status === 'No' && req.body.map_group_status === 'Yes' ? req.body.map_group_name : null,
        req.body.worker_status,
        req.body.worker_status === 'Yes' ? Number(req.body.worker_duration_value) : null,
        req.body.worker_status === 'Yes' ? req.body.worker_duration_unit : null,
        req.body.worker_status === 'Yes' ? req.body.unit_name : null,
        req.body.worker_status === 'Yes' ? req.body.unit_leader_name : null,
        req.body.worker_status === 'Yes' ? req.body.unit_leader_email : null,
        req.body.worker_status === 'Yes' ? req.body.unit_leader_phone : null,
        unitLeaderToken,
        req.body.worker_status === 'Yes' ? nowIso : null,
        req.body.worker_status === 'Yes' ? 'Pending' : 'Not Required',
        req.body.pastor_informed,
        req.body.request_category, Number(req.body.amount_requested), Number(req.body.total_amount_needed), req.body.due_date || null,
        req.body.situation, req.body.consequence, req.body.one_time_or_ongoing, req.body.prior_assistance, req.body.prior_assistance_details || '', req.body.applicant_effort || '', Number(req.body.applicant_contribution || 0), Number(req.body.other_confirmed_support || 0), req.body.dependents_affected || 'No', JSON.stringify(effortActions),
        req.body.direct_payment_possible, req.body.payment_details || '', req.body.direct_payment_explanation || '', req.body.zelle_name || '', req.body.zelle_email || '', req.body.zelle_phone || '',
        details, 1, 1, 1, urgency, urgencyResult.reason, initialStatus, 'Pending'
      ];

      const placeholders = columns.map(() => '?').join(',');
      const result = await db.run(`INSERT INTO requests (${columns.join(',')}) VALUES (${placeholders})`, values);

      const saveDocument = async (file, documentType) => {
        if (!file) return;
        const stored = await saveUploadedFile(db, file, { folder: `requests/${caseId}` });
        await db.run(
          'INSERT INTO documents (request_id, original_name, stored_name, mime_type, size_bytes, document_type) VALUES (?,?,?,?,?,?)',
          [result.lastID, file.originalname, stored.storageKey, file.mimetype, file.size, documentType]
        );
      };
      await saveDocument(membershipCertificate, 'CCI Membership Certificate');
      await saveDocument(mapLeaderAttestation, 'MAP Leader Attestation Letter');
      for (const file of supportingDocuments) await saveDocument(file, 'Supporting document');

      await logActivity(result.lastID, null, 'Request submitted', `Applicant submitted ${caseId}`);
      const trackingLink = `${baseUrl(req)}/track/${trackingToken}`;

      if (req.body.worker_status === 'Yes') {
        const leadershipLink = `${baseUrl(req)}/leadership-verify/${unitLeaderToken}`;
        await sendNotification({
          db,
          requestId: result.lastID,
          recipientName: req.body.unit_leader_name,
          recipientEmail: req.body.unit_leader_email,
          subject: `CCI America leadership verification needed for ${req.body.full_name}`,
          body: `Dear ${req.body.unit_leader_name},

${req.body.full_name} identified you as their Unit Head for a confidential financial assistance request submitted to CCI America.

The applicant reported serving in the ${req.body.unit_name} unit. Please use the secure link below to verify their Celeforce service and unit connection.

${leadershipLink}

After leadership verification is completed, the request will proceed to pastoral verification.

This request should be handled confidentially.

CCI America Financial Assistance Committee`
        });
        await logActivity(result.lastID, null, 'Leadership verification email prepared', req.body.unit_leader_email);
      } else {
        const pastorLink = `${baseUrl(req)}/pastor-verify/${pastorToken}`;
        await sendNotification({
          db,
          requestId: result.lastID,
          recipientName: req.body.leader_name,
          recipientEmail: req.body.leader_email,
          subject: `CCI America pastoral verification needed for ${req.body.full_name}`,
          body: `Dear ${req.body.leader_name},

${req.body.full_name} identified you as their Pastor for a confidential financial assistance request submitted to CCI America.

The secure verification page will show the applicant's relevant submitted information. Please review it and complete all required pastoral verification questions.

${pastorLink}

This request should be handled confidentially.

CCI America Financial Assistance Committee`
        });
        await logActivity(result.lastID, null, 'Pastoral verification email prepared', req.body.leader_email);
      }

      const applicantTrackingName = String(req.body.full_name || '').trim();
      const verificationMessage = req.body.worker_status === 'Yes'
        ? 'Because you identified yourself as a Celeforce worker, your Unit Head will complete leadership verification first. Your Pastor will then receive the pastoral verification request.'
        : 'Your Pastor will be asked to complete a confidential pastoral verification before committee review.';

      await sendNotification({
        db,
        requestId: result.lastID,
        recipientName: req.body.full_name,
        recipientEmail: req.body.email,
        subject: `CCI America financial assistance request received: ${caseId}`,
        body: `Dear ${req.body.full_name},

Your confidential financial assistance request has been received by CCI America.

Case ID: ${caseId}
Full name for tracking: ${applicantTrackingName}
Track your request here:
${trackingLink}

${verificationMessage}

CCI America Financial Assistance Committee`
      });
      await logActivity(result.lastID, null, 'Applicant tracking email prepared', req.body.email);
      res.redirect(`/apply/success/${caseId}?token=${trackingToken}`);
    } catch (err) {
      res.status(400).render('apply', { title: 'Financial Assistance Request', error: err.message });
    }
  });

  app.get('/apply/success/:caseId', async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT case_id, email, tracking_token FROM requests WHERE case_id=?', req.params.caseId);
    const token = req.query.token || (request && request.tracking_token);
    const trackingLink = token ? `${baseUrl(req)}/track/${token}` : null;
    res.render('success', { title: 'Request Received', caseId: req.params.caseId, trackingLink });
  });

  app.get('/track', (req, res) => {
    res.render('track-start', { title: 'Track Request', error: null, publicPage: true, publicLabel: 'Secure request tracking' });
  });

  app.post('/track', async (req, res) => {
    const caseId = String(req.body.case_id || '').trim();
    const submittedFullName = normalizeApplicantName(req.body.full_name);
    if (!caseId || !submittedFullName) {
      return res.status(400).render('track-start', { title: 'Track Request', error: 'Please enter both your Case ID and full name.', publicPage: true, publicLabel: 'Secure request tracking' });
    }
    const db = await getDb();
    const request = await db.get('SELECT case_id, full_name, tracking_token FROM requests WHERE case_id=?', [caseId]);
    const storedFullName = normalizeApplicantName(request && request.full_name);
    if (!request || !request.tracking_token || submittedFullName !== storedFullName) {
      return res.status(404).render('track-start', { title: 'Track Request', error: 'We could not find a request matching that Case ID and full name. Please enter the full name exactly as it was entered on the application.', publicPage: true, publicLabel: 'Secure request tracking' });
    }
    res.redirect(`/track/${request.tracking_token}`);
  });

  app.get('/track/:token', async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT id, case_id, full_name, email, phone, request_category, amount_requested, total_amount_needed, due_date, status, urgency, urgency_reason, created_at, updated_at, leader_verified, unit_leader_verified, worker_status, decision, amount_approved, tracking_token FROM requests WHERE tracking_token=?', req.params.token);
    if (!request) return res.status(404).render('error', { title: 'Tracking link not found', message: 'This tracking link is invalid or has expired.', publicPage: true, publicLabel: 'Secure request tracking' });
    await db.run('UPDATE requests SET applicant_last_viewed_at=CURRENT_TIMESTAMP WHERE tracking_token=?', req.params.token);
    const applicantFollowup = await db.get('SELECT * FROM followups WHERE request_id=? AND submitted_by_applicant=1 ORDER BY created_at DESC LIMIT 1', request.id);
    const statusInfo = applicantStatusInfo(request.status, request.worker_status);
    res.render('track-status', { title: 'Track Request', request, statusInfo, applicantFollowup, publicPage: true, publicLabel: 'Secure request tracking' });
  });

  app.post('/track/:token/followup', upload.single('receipt'), async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE tracking_token=?', req.params.token);
    if (!request) return res.status(404).render('error', { title: 'Tracking link not found', message: 'This tracking link is invalid or has expired.', publicPage: true, publicLabel: 'Secure request tracking' });
    if (!req.body.funds_used_as_intended || !req.body.issue_resolved || !req.body.notes || !req.file) {
      return res.status(400).render('error', { title: 'Missing follow-up information', message: 'Please complete all follow-up questions and upload receipt/payment evidence.', publicPage: true, publicLabel: 'Secure request tracking' });
    }
    const storedReceipt = await saveUploadedFile(db, req.file, { folder: `followups/${request.case_id}` });
    await db.run(`INSERT INTO followups (request_id, completed_by, funds_used_as_intended, issue_resolved, receipt_received, pastoral_followup_needed, notes, submitted_by_applicant, receipt_file)
      VALUES (?,?,?,?,?,?,?,?,?)`, [request.id, request.applicant_user_id || 1, req.body.funds_used_as_intended, req.body.issue_resolved, 'Yes', 'Pending admin review', req.body.notes, 1, storedReceipt.storageKey]);
    await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Follow-Up Submitted', request.id]);
    await logActivity(request.id, request.applicant_user_id || null, 'Applicant follow-up submitted', 'Applicant uploaded receipt/payment evidence for follow-up closure.');
    await sendNotification({ db, requestId: request.id, recipientName: 'Admin', recipientEmail: 'admin@cci.local', subject: `Follow-up evidence submitted: ${request.case_id}`, body: `Applicant follow-up evidence has been submitted for ${request.case_id}. Please log in as admin and complete follow-up closure.` });
    res.redirect(`/track/${req.params.token}`);
  });

  app.get('/dev-login/:role', async (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).send('Not found');
    const role = req.params.role;
    const allowed = { admin: 'admin@cci.local', applicant: 'applicant@cci.local' };
    const email = allowed[role];
    if (!email) return res.status(400).send('Invalid role');
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE email=? AND active=1', email);
    if (!user) return res.status(404).send('User not found. Run npm run seed first.');
    const authUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    req.session.user = authUser;
    req.session.save(() => {
      if (authUser.role === 'applicant') return res.redirect('/apply');
      return res.redirect('/dashboard');
    });
  });

  app.get('/leadership-verify/:token', renderLeadershipVerification);
  app.post('/leadership-verify/:token', submitLeadershipVerification);
  app.get('/pastor-verify/:token', renderPastorVerification);
  app.post('/pastor-verify/:token', upload.single('support_letter'), submitPastorVerification);
  app.get('/leader-verify/:token', renderPastorVerification);
  app.post('/leader-verify/:token', upload.single('support_letter'), submitPastorVerification);

  app.get('/review-invite/:token', async (req, res) => {
    const db = await getDb();
    const invite = await db.get(`
      SELECT rr.*, r.case_id, r.request_category, r.urgency, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email
      FROM request_reviewers rr
      JOIN requests r ON r.id=rr.request_id
      JOIN users u ON u.id=rr.reviewer_id
      WHERE rr.invite_token=?
    `, req.params.token);
    if (!invite) return res.status(404).render('error', { title: 'Invalid review invite', message: 'This review invitation link is invalid or expired.', publicPage: true, publicLabel: 'Secure reviewer invitation' });
    res.render('review-invite', { title: 'Review Invitation', invite, publicPage: true, publicLabel: 'Secure reviewer invitation' });
  });

  app.post('/review-invite/:token/accept', async (req, res) => {
    const db = await getDb();
    const invite = await db.get(`
      SELECT rr.*, r.case_id, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email
      FROM request_reviewers rr
      JOIN requests r ON r.id=rr.request_id
      JOIN users u ON u.id=rr.reviewer_id
      WHERE rr.invite_token=?
    `, req.params.token);
    if (!invite) return res.status(404).render('error', { title: 'Invalid review invite', message: 'This review invitation link is invalid or expired.', publicPage: true, publicLabel: 'Secure reviewer invitation' });
    if (invite.declined_at || invite.expired_at) {
      return res.status(400).render('error', { title: 'Invitation not active', message: 'This review invitation is no longer active.', publicPage: true, publicLabel: 'Secure reviewer invitation' });
    }

    let reviewToken = invite.review_token;
    const firstAcceptance = !invite.accepted_at;
    if (!reviewToken) reviewToken = crypto.randomBytes(32).toString('hex');

    await db.run(`UPDATE request_reviewers
      SET accepted_at=COALESCE(accepted_at,CURRENT_TIMESTAMP), review_token=?, review_token_sent_at=COALESCE(review_token_sent_at,CURRENT_TIMESTAMP), invite_token=NULL
      WHERE id=?`, [reviewToken, invite.id]);
    await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Committee Review', invite.request_id]);

    if (firstAcceptance || !invite.review_token_sent_at) {
      const reviewLink = `${baseUrl(req)}/review/${reviewToken}`;
      await sendNotification({
        db,
        requestId: invite.request_id,
        recipientName: invite.reviewer_name,
        recipientEmail: invite.reviewer_email,
        subject: `Secure review link: ${invite.case_id}`,
        body: `Dear ${invite.reviewer_name},

Thank you for accepting the invitation to review ${invite.case_id}.

Please use the separate secure link below to access the confidential case materials and submit your independent review:
${reviewLink}

This link is intended only for you. Please do not forward it. No reviewer account or password is required.

CCI America Financial Assistance Committee`
      });
      await logActivity(invite.request_id, null, 'Reviewer accepted assignment', `${invite.reviewer_email} accepted; secure review link sent.`);
    }

    res.render('review-invite-accepted', { title: 'Review Accepted', publicPage: true, publicLabel: 'Secure reviewer invitation', reviewerEmail: invite.reviewer_email });
  });

  app.post('/review-invite/:token/decline', async (req, res) => {
    const db = await getDb();
    const invite = await db.get(`
      SELECT rr.*, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email
      FROM request_reviewers rr JOIN users u ON u.id=rr.reviewer_id
      WHERE rr.invite_token=?
    `, req.params.token);
    if (!invite) return res.status(404).render('error', { title: 'Invalid review invite', message: 'This review invitation link is invalid or expired.', publicPage: true, publicLabel: 'Secure reviewer invitation' });
    if (!invite.accepted_at) await db.run('UPDATE request_reviewers SET declined_at=CURRENT_TIMESTAMP WHERE id=?', invite.id);
    await logActivity(invite.request_id, null, 'Reviewer declined assignment', `${invite.reviewer_email} declined the availability request.`);
    if (process.env.AUTO_ASSIGN_REVIEWERS === 'true') {
      await ensureTwoReviewerInvites(db, req, invite.request_id);
    } else {
      const request = await db.get('SELECT case_id FROM requests WHERE id=?', invite.request_id);
      await sendNotification({ db, requestId: invite.request_id, recipientName: 'CCI Welfare Admin', recipientEmail: process.env.ADMIN_EMAIL || 'admin@cci.local', subject: `Reviewer declined: ${request ? request.case_id : 'CCI case'}`, body: `${invite.reviewer_email} declined the review invitation. Please assign another reviewer from the Admin portal.` });
    }
    res.render('review-invite-accepted', { title: 'Review Declined', publicPage: true, publicLabel: 'Secure reviewer invitation', declined: true });
  });

  app.get('/review/:token/uploads/:filename', async (req, res) => {
    const db = await getDb();
    const access = await getReviewAccess(db, req.params.token);
    if (!access || access.review_submitted_at) return res.status(403).render('error', { title: 'Access denied', message: 'This reviewer access link is invalid, completed, or expired.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
    const safeName = path.basename(req.params.filename);
    const belongs = await db.get('SELECT id FROM documents WHERE request_id=? AND stored_name=?', [access.request_id, safeName]);
    const pastoral = await db.get('SELECT id FROM leader_verifications WHERE request_id=? AND support_letter_file=?', [access.request_id, safeName]);
    if (!belongs && !pastoral) return res.status(404).render('error', { title: 'File not found', message: 'This file is not part of the assigned case.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
    const fileRecord = await getStoredFileByKey(db, safeName);
    if (!fileRecord) return res.status(404).render('error', { title: 'File not found', message: 'The uploaded file could not be found.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
    await sendStoredFile(res, fileRecord, fileRecord.original_name);
  });

  app.get('/review/:token', async (req, res) => {
    const db = await getDb();
    const access = await getReviewAccess(db, req.params.token);
    if (!access) return res.status(404).render('error', { title: 'Invalid review link', message: 'This secure review link is invalid or expired.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
    if (access.review_submitted_at) {
      return res.render('review-submitted', { title: 'Review Submitted', publicPage: true, publicLabel: 'Secure reviewer workspace', access });
    }
    const request = await db.get('SELECT * FROM requests WHERE id=?', access.request_id);
    const docs = await db.all('SELECT * FROM documents WHERE request_id=?', access.request_id);
    const verifications = await db.all('SELECT * FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC', access.request_id);
    const leadershipVerifications = await db.all('SELECT * FROM leadership_verifications WHERE request_id=? ORDER BY created_at DESC', access.request_id);
    const myReview = await db.get('SELECT * FROM reviews WHERE request_id=? AND reviewer_id=?', [access.request_id, access.reviewer_id]);
    const categoryDetails = JSON.parse(request.category_details || '{}');
    const systemAssessment = await buildSystemAssessment(db, request, docs, verifications, leadershipVerifications);
    res.render('reviewer-case', {
      title: `Review ${request.case_id}`,
      request,
      docs,
      verifications,
      leadershipVerifications,
      myReview,
      categoryDetails,
      systemAssessment,
      query: req.query || {},
      publicPage: true,
      publicLabel: 'Secure reviewer workspace',
      reviewToken: req.params.token,
      reviewerName: access.reviewer_name
    });
  });

  app.post('/review/:token', async (req, res) => {
    const db = await getDb();
    const access = await getReviewAccess(db, req.params.token);
    if (!access) return res.status(404).render('error', { title: 'Invalid review link', message: 'This secure review link is invalid or expired.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
    if (access.review_submitted_at) return res.render('review-submitted', { title: 'Review Submitted', publicPage: true, publicLabel: 'Secure reviewer workspace', access });

    const request = await db.get('SELECT * FROM requests WHERE id=?', access.request_id);
    const docs = await db.all('SELECT * FROM documents WHERE request_id=? ORDER BY uploaded_at ASC', access.request_id);
    const verifications = await db.all('SELECT * FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC', access.request_id);
    const leadershipVerifications = await db.all('SELECT * FROM leadership_verifications WHERE request_id=? ORDER BY created_at DESC', access.request_id);
    const systemAssessment = await buildSystemAssessment(db, request, docs, verifications, leadershipVerifications);

    try {
      validateReviewSubmission(req.body, systemAssessment);
    } catch (err) {
      return res.status(400).render('error', {
        title: err.message === 'Please briefly explain any disagreement with, or change to, the system-generated assessment.' ? 'Reason required' : 'Incomplete review',
        message: err.message,
        publicPage: true,
        publicLabel: 'Secure reviewer workspace'
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
      access.request_id, access.reviewer_id, req.body.conflict_of_interest, null, Number(req.body.urgency_rating), Number(req.body.severity_rating), Number(req.body.gap_rating), Number(req.body.effort_rating), Number(req.body.history_rating),
      Number(req.body.policy_rating), Number(req.body.documentation_rating), reviewScoreTotal(req.body), systemAssessment.total, JSON.stringify(systemAssessment), req.body.system_assessment_agreement,
      req.body.override_reason || '', Number(systemAssessment.actualGap || 0), req.body.recommended_decision, req.body.recommended_amount || null, req.body.notes || ''
    ]);
    await db.run('UPDATE request_reviewers SET review_submitted_at=CURRENT_TIMESTAMP WHERE id=?', access.id);
    await logActivity(access.request_id, null, 'Reviewer assessment submitted', `${access.reviewer_email}; system ${systemAssessment.total}/21; reviewer ${reviewScoreTotal(req.body)}/21`);

    const reviewCount = await db.get('SELECT COUNT(*) as count FROM reviews WHERE request_id=?', access.request_id);
    await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [(reviewCount.count || 0) >= 2 ? 'Reviews Complete' : 'Committee Review', access.request_id]);
    if ((reviewCount.count || 0) >= 2) {
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@cci.local';
      await sendNotification({ db, requestId: access.request_id, recipientName: 'CCI Welfare Admin', recipientEmail: adminEmail, subject: `Two reviews completed: ${request.case_id}`, body: `Two independent reviewer assessments have now been submitted for ${request.case_id}. The case is ready for the committee/admin decision stage.` });
    }
    res.render('review-submitted', { title: 'Review Submitted', publicPage: true, publicLabel: 'Secure reviewer workspace', access: { ...access, review_submitted_at: new Date().toISOString() } });
  });

  app.get('/finance-confirm/:token', async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE finance_confirm_token=?', req.params.token);
    if (!request) return res.status(404).render('error', { title: 'Invalid link', message: 'This finance confirmation link is invalid or expired.', publicPage: true, publicLabel: 'Finance confirmation' });
    res.render('finance-confirm', { title: `Confirm Payment ${request.case_id}`, publicPage: true, publicLabel: 'Finance confirmation', request });
  });

  app.post('/finance-confirm/:token', upload.single('confirmation_file'), async (req, res) => {
    const db = await getDb();
    const request = await db.get('SELECT * FROM requests WHERE finance_confirm_token=?', req.params.token);
    if (!request) return res.status(404).render('error', { title: 'Invalid link', message: 'This finance confirmation link is invalid or expired.', publicPage: true, publicLabel: 'Finance confirmation' });
    if (request.payment_confirmed_at) {
      return res.render('finance-confirm-success', { title: 'Payment Already Confirmed', publicPage: true, publicLabel: 'Finance confirmation', request, alreadyConfirmed: true });
    }
    const storedConfirmationFile = req.file ? await saveUploadedFile(db, req.file, { folder: `finance-confirmations/${request.case_id}` }) : null;
    await db.run(`UPDATE requests SET payment_confirmed_at=CURRENT_TIMESTAMP, payment_confirmed_by=?, payment_confirmation_amount=?, payment_confirmation_method=?, payment_confirmation_reference=?, payment_confirmation_notes=?, payment_confirmation_file=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [
      req.body.confirmed_by || 'CCI USA Finance Team', req.body.amount_paid || request.amount_approved || request.amount_requested, req.body.payment_method || '', req.body.payment_reference || '', req.body.confirmation_notes || '', storedConfirmationFile ? storedConfirmationFile.storageKey : null, 'Payment Confirmed', request.id
    ]);
    await logActivity(request.id, null, 'Finance payment confirmed', `Confirmed by ${req.body.confirmed_by || 'Finance'}; amount ${req.body.amount_paid || request.amount_approved || request.amount_requested}`);
    await sendNotification({
      db,
      requestId: request.id,
      recipientName: 'Admin',
      recipientEmail: process.env.ADMIN_EMAIL || 'admin@cci.local',
      subject: `Payment confirmed by Finance: ${request.case_id}`,
      body: `Finance has confirmed payment for ${request.case_id} (${request.full_name}).

Amount paid: ${req.body.amount_paid || request.amount_approved || request.amount_requested}
Reference: ${req.body.payment_reference || 'Not provided'}

The applicant has also been automatically notified that the request was approved and the support/payment has been processed. The normal close-out request will be sent after 3 days unless Admin sends it immediately.`
    });
    await logActivity(request.id, null, 'Admin notified of finance payment confirmation', process.env.ADMIN_EMAIL || 'admin@cci.local');

    const freshRequest = await db.get('SELECT * FROM requests WHERE id=?', request.id);
    await sendApplicantPaymentNotice(db, req, freshRequest, {
      amount: req.body.amount_paid || request.amount_approved || request.amount_requested,
      method: req.body.payment_method || '',
      reference: req.body.payment_reference || ''
    });

    res.render('finance-confirm-success', { title: 'Payment Confirmed', publicPage: true, publicLabel: 'Finance confirmation', request, alreadyConfirmed: false });
  });
}

module.exports = {
  mountPublicRoutes
};
