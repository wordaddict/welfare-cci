require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const { initDb, getDb, logActivity } = require('./src/db');
const { money, escapeCsv, requireAuth, requireRole, parseCategoryDetails, calculateUrgencyResult, generateCaseId } = require('./src/helpers');

const app = express();
const PORT = process.env.PORT || 3000;
function baseUrl(req) {
  // APP_BASE_URL is required for background emails because there may be no browser request.
  // For local testing, it falls back to localhost.
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (req && req.protocol && req.get) return `${req.protocol}://${req.get('host')}`;
  return `http://localhost:${PORT}`;
}

function applicantStatusInfo(status, workerStatus = 'No') {
  const isWorker = workerStatus === 'Yes';
  const stages = isWorker
    ? [
        { key: 'Submitted', label: 'Submitted' },
        { key: 'Leadership', label: 'Leadership verification' },
        { key: 'Pastoral', label: 'Pastoral verification' },
        { key: 'Review', label: 'Committee review' },
        { key: 'Decision', label: 'Decision' },
        { key: 'Closed', label: 'Closed' }
      ]
    : [
        { key: 'Submitted', label: 'Submitted' },
        { key: 'Pastoral', label: 'Pastoral verification' },
        { key: 'Review', label: 'Committee review' },
        { key: 'Decision', label: 'Decision' },
        { key: 'Closed', label: 'Closed' }
      ];

  const idx = (workerIndex, nonWorkerIndex) => isWorker ? workerIndex : nonWorkerIndex;
  const map = {
    'New Request': { index: 0, title: 'Request submitted', message: 'Your request has been received. The Financial Assistance Committee will begin the confidential verification and review process.' },
    'Awaiting Leadership Verification': { index: 1, title: 'Waiting for leadership verification', message: 'We are waiting for your Unit Head to verify your Celeforce service. After that, the request will proceed to pastoral verification.' },
    'Leadership Verification Complete': { index: 2, title: 'Leadership verification received', message: 'Your Unit Head has completed leadership verification. Your request has now moved to pastoral verification.' },
    'Awaiting Pastoral Verification': { index: idx(2, 1), title: 'Waiting for pastoral verification', message: 'We are waiting for your Pastor to complete the confidential pastoral verification. You do not need to take further action right now.' },
    'Awaiting Leader Verification': { index: idx(2, 1), title: 'Waiting for pastoral verification', message: 'We are waiting for your Pastor to complete the confidential pastoral verification.' },
    'Pastoral Verification Complete': { index: idx(3, 2), title: 'Pastoral verification received', message: 'Your Pastor\'s verification has been received. Your request is being prepared for committee review.' },
    'Leader Verification Complete': { index: idx(3, 2), title: 'Pastoral verification received', message: 'Your Pastor\'s verification has been received. Your request is being prepared for committee review.' },
    'Assigned to Reviewers': { index: idx(3, 2), title: 'Under committee review', message: 'Your request has been assigned for confidential review.' },
    'Under Review': { index: idx(3, 2), title: 'Under committee review', message: 'Your request is currently under review by assigned committee reviewers.' },
    'Committee Review': { index: idx(3, 2), title: 'Under committee review', message: 'Your request is currently being reviewed by the Financial Assistance Committee.' },
    'Reviews Complete': { index: idx(4, 3), title: 'Review completed', message: 'The review stage has been completed. A committee decision will be recorded.' },
    'Decision Made': { index: idx(4, 3), title: 'Decision recorded', message: 'A decision has been recorded. If payment action is required, the committee will coordinate with the finance team.' },
    'Payment Confirmed': { index: idx(4, 3), stageComplete: true, title: 'Support processed', message: 'Your request has been approved and the approved support/payment has been processed. No action is needed right now. A short close-out form will normally be sent after 3 days for record-keeping.' },
    'Follow-Up Requested': { index: idx(5, 4), title: 'Close-out form requested', message: 'Please complete the short close-out form for record-keeping and stewardship. This helps the committee complete and close your request file.' },
    'Follow-Up Submitted': { index: idx(5, 4), title: 'Follow-up submitted', message: 'Your follow-up evidence has been received. The committee will review it and close the case.' },
    'Closed': { index: idx(5, 4), title: 'Completed', message: 'This request has been closed.' },
    'Declined': { index: idx(5, 4), title: 'Request closed', message: 'This request has been closed. Please contact the committee if you have questions.' }
  };
  const info = map[status] || map['New Request'];
  return { ...info, stages, stageComplete: !!info.stageComplete, isClosed: ['Closed','Declined'].includes(status) };
}

async function sendNotification({ db, requestId, recipientName, recipientEmail, subject, body, attachments = [] }) {
  const saved = await db.run(
    'INSERT INTO notifications (request_id, recipient_name, recipient_email, subject, body, status) VALUES (?,?,?,?,?,?)',
    [requestId || null, recipientName || '', recipientEmail, subject, body, 'Queued']
  );

  if (!process.env.SMTP_HOST) {
    console.log('\n--- EMAIL PREVIEW ---');
    console.log('To:', recipientEmail);
    console.log('Subject:', subject);
    console.log(body);
    if (attachments && attachments.length) {
      console.log('Attachments:', attachments.map(a => a.filename || a.path || 'attachment').join(', '));
    }
    console.log('--- END EMAIL PREVIEW ---\n');
    await db.run('UPDATE notifications SET status=?, sent_at=CURRENT_TIMESTAMP WHERE id=?', ['Previewed', saved.lastID]);
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'CCI America Financial Assistance <no-reply@cci.local>',
      to: recipientEmail,
      subject,
      text: body,
      attachments
    });
    await db.run('UPDATE notifications SET status=?, sent_at=CURRENT_TIMESTAMP WHERE id=?', ['Sent', saved.lastID]);
  } catch (err) {
    await db.run('UPDATE notifications SET status=?, error=? WHERE id=?', ['Failed', err.message, saved.lastID]);
    console.error('Email failed:', err.message);
  }
}


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


function reviewScoreTotal(rowOrBody) {
  const fields = ['urgency_rating','severity_rating','gap_rating','effort_rating','history_rating','policy_rating','documentation_rating'];
  return fields.reduce((sum, field) => {
    const value = Number(rowOrBody[field] || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function reviewScoreSummary(reviews) {
  const totals = (reviews || []).map(r => Number(r.score_total || reviewScoreTotal(r))).filter(n => Number.isFinite(n) && n > 0);
  const maxPerReview = 21;
  const average = totals.length ? totals.reduce((a,b)=>a+b,0) / totals.length : 0;
  return {
    count: totals.length,
    maxPerReview,
    average,
    averageRounded: average ? average.toFixed(1) : '0.0',
    averagePercent: average ? Math.round((average / maxPerReview) * 100) : 0
  };
}



function normalizeMultiValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(v => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

function connectionMonths(value) {
  const map = {
    'Less than 1 month': 0.5,
    '1–3 months': 2,
    '3–6 months': 4.5,
    '6–12 months': 9,
    'More than 1 year': 12
  };
  return map[String(value || '').trim()] || 0;
}

function policyScoreInterpretation(total) {
  const n = Number(total || 0);
  if (n >= 19) return 'Very strong preliminary case (above the policy appendix\'s stated 15–18 strong range)';
  if (n >= 15) return 'Strong preliminary case';
  if (n >= 11) return 'Moderate preliminary case';
  if (n >= 7) return 'Weak preliminary case';
  return 'Incomplete preliminary assessment';
}

async function buildSystemAssessment(db, request, docs = [], verifications = [], leadershipVerifications = []) {
  const details = (() => { try { return JSON.parse(request.category_details || '{}'); } catch { return {}; } })();
  const yes = v => String(v || '').trim().toLowerCase() === 'yes';
  const text = `${request.situation || ''} ${request.consequence || ''} ${JSON.stringify(details)}`.toLowerCase();
  const has = (...words) => words.some(w => text.includes(w));
  const reasons = [];
  const flags = [];
  const escalationReasons = [];

  const pastor = verifications && verifications.length ? verifications[0] : null;
  const unit = leadershipVerifications && leadershipVerifications.length ? leadershipVerifications[0] : null;
  const months = connectionMonths(request.connection_duration);
  const membershipDoc = docs.some(d => d.document_type === 'CCI Membership Certificate');
  const mapDoc = docs.some(d => d.document_type === 'MAP Leader Attestation Letter');
  const supportingDocs = docs.filter(d => d.document_type === 'Supporting document');

  // Eligibility is a first filter, not part of the 21-point Appendix 1 score.
  const eligibilityReasons = [];
  let eligibilityStatus = 'Pass';
  if (months < 3) {
    eligibilityStatus = 'Escalate';
    eligibilityReasons.push(`CCI connection is reported as ${request.connection_duration}, below the policy's standard 3-month minimum.`);
    escalationReasons.push('Applicant is below the standard 3-month active-membership duration.');
  } else {
    eligibilityReasons.push(`CCI connection meets the standard 3-month duration check (${request.connection_duration}).`);
  }
  if (request.membership_status === 'Yes') {
    if (membershipDoc) eligibilityReasons.push('Official membership is supported by an uploaded membership certificate.');
    else { eligibilityStatus = 'Needs attention'; eligibilityReasons.push('Applicant reported official membership but no membership certificate is recorded.'); flags.push('Membership certificate missing.'); }
  } else if (request.map_group_status === 'Yes') {
    if (mapDoc) eligibilityReasons.push('Non-certified membership/active MAP connection is supported by a MAP Leader attestation letter.');
    else { eligibilityStatus = 'Needs attention'; eligibilityReasons.push('MAP participation was reported but the MAP Leader attestation is missing.'); flags.push('MAP Leader attestation missing.'); }
  } else {
    eligibilityReasons.push('Applicant is not yet an official member and did not report MAP participation; pastoral confirmation is therefore especially important.');
  }
  if (pastor) {
    if (pastor.active_connection === 'Yes') eligibilityReasons.push('Pastor confirmed current CCI participation.');
    else { eligibilityStatus = 'Escalate'; eligibilityReasons.push('Pastor did not confirm current CCI participation.'); escalationReasons.push('Pastoral verification did not confirm current CCI participation.'); }
    if (pastor.member_confirmed && pastor.member_confirmed !== request.membership_status) flags.push('Applicant and Pastor membership responses do not match.');
    if (pastor.worker_confirmed && pastor.worker_confirmed !== request.worker_status) flags.push('Applicant and Pastor Celeforce responses do not match.');
  } else {
    eligibilityStatus = eligibilityStatus === 'Escalate' ? 'Escalate' : 'Needs attention';
    eligibilityReasons.push('Pastoral verification has not been completed.');
  }
  if (request.worker_status === 'Yes') {
    if (!unit) { eligibilityStatus = eligibilityStatus === 'Escalate' ? 'Escalate' : 'Needs attention'; flags.push('Unit Head verification is missing.'); }
    else if (unit.worker_confirmed !== 'Yes' || unit.unit_confirmed !== 'Yes') { eligibilityStatus = 'Escalate'; escalationReasons.push('Unit Head verification does not fully confirm the applicant\'s Celeforce/unit status.'); }
  }

  // 1. Urgency
  const urgencyMap = { Emergency: 3, Urgent: 2, Standard: 1 };
  const urgencyScore = urgencyMap[request.urgency] || 1;
  const urgencyReason = request.urgency_reason || `System triage classified this request as ${request.urgency || 'Standard'}.`;

  // 2. Severity of impact
  const highImpact = yes(details.eviction_risk) || yes(details.disconnection_notice) || yes(details.food_urgent) || yes(details.medical_urgent) || yes(details.safety_concern) || request.request_category === 'Emergency Accommodation' || has('homeless', 'evict', 'no food', 'unsafe', 'hospital', 'medical emergency', 'disconnection', 'shut off');
  const dependents = String(request.dependents_affected || 'No');
  const hasDependents = dependents && dependents !== 'No';
  const essentialCategory = ['Rent or Housing','Utilities','Groceries or Food','Medical or Health-Related Support','Emergency Accommodation'].includes(request.request_category);
  const severityScore = highImpact ? 3 : (essentialCategory || hasDependents ? 2 : 1);
  const severityReason = highImpact
    ? `High-impact indicator detected${hasDependents ? `; dependents are affected (${dependents})` : ''}.`
    : (essentialCategory || hasDependents ? `The request affects an essential need${hasDependents ? ` and dependents (${dependents})` : ''}, but no immediate critical-impact indicator was detected.` : 'No structured critical-impact indicator was detected.');

  // 3. Financial gap
  const totalNeed = Math.max(0, Number(request.total_amount_needed || 0));
  const contribution = Math.max(0, Number(request.applicant_contribution || 0));
  const otherSupport = Math.max(0, Number(request.other_confirmed_support || 0));
  const requested = Math.max(0, Number(request.amount_requested || 0));
  const actualGap = Math.max(0, totalNeed - contribution - otherSupport);
  const gapRatio = totalNeed > 0 ? actualGap / totalNeed : 0;
  let gapScore = actualGap <= 0 ? 1 : (gapRatio >= 0.66 ? 3 : gapRatio >= 0.33 ? 2 : 1);
  if (requested > actualGap + 0.01) {
    gapScore = Math.min(gapScore, 2);
    flags.push(`Amount requested (${money(requested)}) is greater than the calculated remaining financial gap (${money(actualGap)}).`);
  }
  const gapReason = `Total need ${money(totalNeed)} minus applicant contribution ${money(contribution)} and confirmed outside support ${money(otherSupport)} gives an estimated gap of ${money(actualGap)}.`;

  // 4. Applicant effort
  let effortActions = [];
  try { effortActions = JSON.parse(request.effort_actions || '[]'); } catch { effortActions = normalizeMultiValue(request.effort_actions); }
  effortActions = Array.isArray(effortActions) ? effortActions : normalizeMultiValue(effortActions);
  const meaningfulActions = effortActions.filter(x => x && x !== 'None yet');
  let effortScore = 1;
  if (meaningfulActions.length >= 3 || (meaningfulActions.length >= 2 && contribution > 0)) effortScore = 3;
  else if (meaningfulActions.length >= 1 || contribution > 0 || String(request.applicant_effort || '').trim().length >= 80) effortScore = 2;
  const effortReason = meaningfulActions.length
    ? `Applicant selected ${meaningfulActions.length} concrete action(s): ${meaningfulActions.join('; ')}${contribution > 0 ? `, and reports a personal contribution of ${money(contribution)}` : ''}.`
    : (contribution > 0 ? `No structured effort action was selected, but the applicant reports contributing ${money(contribution)}.` : 'No structured evidence of prior effort was recorded beyond the narrative response.');

  // 5. History of assistance: use database records rather than applicant memory alone.
  const priorCases = await db.all(`
    SELECT id, case_id, decision, amount_approved, created_at
    FROM requests
    WHERE id <> ?
      AND (applicant_user_id = ? OR lower(email) = lower(?))
      AND decision IN ('Full Approval','Partial Approval','Conditional Approval')
    ORDER BY datetime(created_at) DESC
  `, [request.id, request.applicant_user_id || -1, request.email]);
  const year = new Date().getFullYear();
  const currentYearCases = priorCases.filter(c => String(c.created_at || '').startsWith(String(year)));
  const approvedThisYear = currentYearCases.length;
  const amountThisYear = currentYearCases.reduce((sum,c)=>sum + Number(c.amount_approved || 0), 0);
  let daysSinceLast = null;
  if (priorCases.length && priorCases[0].created_at) {
    const d = new Date(priorCases[0].created_at);
    if (!Number.isNaN(d.getTime())) daysSinceLast = Math.floor((Date.now() - d.getTime()) / 86400000);
  }
  let historyScore = 3;
  if (approvedThisYear >= 2 || (daysSinceLast !== null && daysSinceLast < 90)) historyScore = 1;
  else if (priorCases.length || request.prior_assistance === 'Yes') historyScore = 2;
  if (request.prior_assistance === 'No' && priorCases.length) flags.push('Applicant reported no prior CCI assistance, but the system found a previously approved case.');
  if (approvedThisYear >= 3) escalationReasons.push('Applicant already has 3 approved welfare requests in the current calendar year.');
  else if (approvedThisYear >= 2) flags.push('Applicant already has 2 approved welfare requests in the current calendar year; policy recommends heightened scrutiny.');
  if (daysSinceLast !== null && daysSinceLast < 90) flags.push(`Previous approval was approximately ${daysSinceLast} day(s) ago; the policy recommends about a 3-month interval between approvals.`);
  const historyReason = priorCases.length
    ? `${priorCases.length} prior approved case(s) found; ${approvedThisYear} in ${year}, totaling ${money(amountThisYear)}${daysSinceLast !== null ? `; last approval approximately ${daysSinceLast} day(s) ago` : ''}.`
    : (request.prior_assistance === 'Yes' ? 'Applicant reports prior CCI assistance, but no previous approved case is present in this local test database.' : 'No prior approved CCI welfare case was found in the database.');

  // 6. Policy alignment
  const standardCategories = ['Rent or Housing','Utilities','Groceries or Food','Medical or Health-Related Support','Tuition or Education','Emergency Accommodation','Special CCI Event Support'];
  let policyScore = standardCategories.includes(request.request_category) ? 3 : 1;
  const policyNotes = [];
  if (standardCategories.includes(request.request_category)) policyNotes.push('Request falls within a recognized assistance category.');
  else { policyNotes.push('Request is an exceptional/non-standard category.'); escalationReasons.push('Request is outside the standard listed assistance categories and requires exception review.'); }

  const exceeds = msg => { policyScore = 1; escalationReasons.push(msg); policyNotes.push(msg); };
  const attention = msg => { policyScore = Math.min(policyScore, 2); flags.push(msg); policyNotes.push(msg); };
  if (request.request_category === 'Rent or Housing') {
    const rentDue = Number(details.rent_due || totalNeed || 0);
    if (rentDue > 0 && requested > rentDue * 0.5 + 0.01) exceeds('Rent request exceeds the policy guideline of up to 50% of monthly rent.');
    if (requested > 2000) exceeds('Rent request exceeds the policy\'s recommended $800–$2,000 range.');
  }
  if (request.request_category === 'Utilities' && requested > 500) exceeds('Utilities request exceeds the policy guideline of up to $500 per request.');
  if (request.request_category === 'Groceries or Food' && requested > 500) exceeds('Groceries/food request exceeds the policy guideline of up to $500 per request.');
  if (request.request_category === 'Tuition or Education') {
    if (totalNeed > 0 && requested > totalNeed * 0.5 + 0.01) exceeds('Tuition request exceeds the policy guideline of up to 50% of tuition cost.');
    if (requested > 5000) exceeds('Tuition request exceeds the $5,000 maximum cap without Pastorate exception.');
    else if (requested > 3000) attention('Tuition request exceeds $3,000 and should be clearly justified/escalated under the policy.');
  }
  if (amountThisYear + requested > 5000) exceeds('Current-year approved assistance plus this request would exceed the policy\'s stated maximum annual assistance range of $5,000.');
  if (requested > actualGap + 0.01) attention('Requested amount is higher than the calculated remaining financial gap.');
  if (months < 3) attention('Applicant is below the standard 3-month membership/active-connection duration.');
  if (request.membership_status === 'No' && request.map_group_status !== 'Yes' && requested > 100) attention('Applicant is not a certified member and did not report MAP participation; policy describes limited immediate assistance up to $100 for certain new-attendee/non-member cases unless escalated.');
  if (request.request_category === 'Special CCI Event Support') policyNotes.push('Special CCI event support is recognized by the policy; the available quick-reference section does not provide a fixed dollar cap, so reviewer judgment remains necessary.');
  if (!policyNotes.length) policyNotes.push('No automated policy exception was identified.');

  // 7. Suitability/completeness of documentation
  let documentationScore = 3;
  const docNotes = [];
  if (supportingDocs.length) docNotes.push(`${supportingDocs.length} financial supporting document(s) uploaded.`);
  else { documentationScore = 1; docNotes.push('No financial supporting document is recorded.'); flags.push('Supporting financial documentation missing.'); }
  if (request.membership_status === 'Yes' && !membershipDoc) documentationScore = Math.min(documentationScore, 1);
  if (request.membership_status === 'No' && request.map_group_status === 'Yes' && !mapDoc) documentationScore = Math.min(documentationScore, 1);
  if (!pastor) { documentationScore = Math.min(documentationScore, 2); docNotes.push('Pastoral verification is not yet recorded.'); }
  else docNotes.push('Pastoral verification completed.');
  if (request.worker_status === 'Yes') {
    if (!unit) { documentationScore = Math.min(documentationScore, 2); docNotes.push('Required Unit Head verification is not yet recorded.'); }
    else docNotes.push('Unit Head verification completed.');
  }
  if (pastor && ((pastor.member_confirmed && pastor.member_confirmed !== request.membership_status) || (pastor.worker_confirmed && pastor.worker_confirmed !== request.worker_status))) {
    documentationScore = Math.min(documentationScore, 2);
    docNotes.push('Verification contains a mismatch that requires reviewer attention.');
  }

  const ratings = {
    urgency: { field: 'urgency_rating', label: 'Urgency', score: urgencyScore, reason: urgencyReason },
    severity: { field: 'severity_rating', label: 'Severity of Impact', score: severityScore, reason: severityReason },
    gap: { field: 'gap_rating', label: 'Financial Gap', score: gapScore, reason: gapReason },
    effort: { field: 'effort_rating', label: 'Applicant Effort', score: effortScore, reason: effortReason },
    history: { field: 'history_rating', label: 'History of Assistance', score: historyScore, reason: historyReason },
    policy: { field: 'policy_rating', label: 'Policy Alignment', score: policyScore, reason: policyNotes.join(' ') },
    documentation: { field: 'documentation_rating', label: 'Suitability of Documentation', score: documentationScore, reason: docNotes.join(' ') }
  };
  const total = Object.values(ratings).reduce((sum, r) => sum + Number(r.score || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    eligibility: { status: eligibilityStatus, reasons: eligibilityReasons },
    ratings,
    total,
    max: 21,
    interpretation: policyScoreInterpretation(total),
    actualGap,
    totalNeed,
    requested,
    contribution,
    otherSupport,
    history: { priorApprovedCases: priorCases.length, approvedThisYear, amountThisYear, daysSinceLast },
    flags: [...new Set(flags)],
    escalationRequired: escalationReasons.length > 0,
    escalationReasons: [...new Set(escalationReasons)]
  };
}

function briefText(value, limit = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Not provided';
  return text.length > limit ? text.slice(0, Math.max(0, limit - 1)).trim() + '…' : text;
}

function scoreInterpretation(summary) {
  const avg = Number(summary.average || 0);
  if (!avg) return 'Awaiting reviews';
  if (avg >= 19) return 'Very strong support';
  if (avg >= 15) return 'Strong support';
  if (avg >= 11) return 'Moderate / needs discussion';
  return 'Weak / insufficient';
}

function drawFinanceSummaryPdf({ doc, request, docs = [], verifications, assignedReviewers, reviews, reviewSummary }) {
  const pageW = doc.page.width;
  const margin = 36;
  const red = '#e30613';
  const dark = '#0b1020';
  const muted = '#5f6b7d';
  const line = '#e6e8ef';
  const soft = '#f6f7f9';
  const maroon = '#2b071f';
  const cciLogo = path.join(__dirname, 'public', 'cci-america-logo.png');
  const tmakLogo = path.join(__dirname, 'public', 'tmak-logo.jpg');
  const primaryLeader = verifications && verifications.length ? verifications[0] : null;
  const approvedAmount = request.amount_approved ? money(request.amount_approved) : (request.decision && request.decision.includes('Approval') ? money(request.amount_requested) : 'Pending');
  const interp = scoreInterpretation(reviewSummary);
  const scoreText = reviews.length ? `${reviewSummary.averageRounded}/21 (${reviewSummary.averagePercent}%)` : 'Pending';
  const supportLetter = primaryLeader && primaryLeader.support_letter_file ? 'Yes' : 'No / not uploaded';
  const applicantEvidence = (docs || []).map(d => d.original_name).filter(Boolean);
  const leaderEvidence = primaryLeader && primaryLeader.support_letter_file ? ['Pastoral support letter uploaded'] : [];
  const evidenceSummary = [...applicantEvidence, ...leaderEvidence].length
    ? [...applicantEvidence, ...leaderEvidence].join('; ')
    : 'No evidence uploaded';

  function label(text, x, y, opts={}) {
    doc.font('Helvetica-Bold').fontSize(opts.size || 6.8).fillColor(opts.color || muted).text(String(text || '').toUpperCase(), x, y, opts.text || { characterSpacing: 1.2 });
  }
  function value(text, x, y, opts={}) {
    doc.font(opts.bold === false ? 'Helvetica' : 'Helvetica-Bold').fontSize(opts.size || 9).fillColor(opts.color || dark).text(String(text || 'Not provided'), x, y, opts.text || {});
  }
  function pill(text, x, y, w, fill, stroke, color) {
    doc.roundedRect(x, y, w, 20, 10).fillAndStroke(fill, stroke);
    doc.font('Helvetica-Bold').fontSize(7.4).fillColor(color).text(text, x, y + 6, { width: w, align: 'center' });
  }
  function panel(x, y, w, h, title) {
    doc.roundedRect(x, y, w, h, 9).strokeColor(line).lineWidth(0.7).stroke();
    if (title) doc.font('Helvetica-Bold').fontSize(9.2).fillColor(dark).text(title, x + 10, y + 9, { width: w - 20 });
  }
  function smallBox(x, y, w, h, lab, val) {
    doc.roundedRect(x, y, w, h, 6).fill(soft);
    label(lab, x + 8, y + 7);
    value(briefText(val, 42), x + 8, y + 19, { size: 8, text: { width: w - 16 } });
  }

  // header
  if (fs.existsSync(cciLogo)) doc.image(cciLogo, margin, 22, { width: 24 });
  label('CCI America', margin + 42, 21, { size: 7 });
  value('Committee Approval Summary', margin + 42, 34, { size: 12 });
  label('Case ID', pageW - 185, 20, { text: { width: 150, align: 'right' } });
  value(request.case_id, pageW - 185, 34, { size: 12, text: { width: 150, align: 'right' } });
  doc.font('Helvetica-Bold').fontSize(7.2).fillColor(muted).text(`Generated ${new Date().toLocaleDateString()}`, pageW - 185, 51, { width: 150, align: 'right' });
  doc.moveTo(margin, 72).lineTo(pageW - margin, 72).strokeColor(line).lineWidth(0.8).stroke();

  // title
  doc.circle(margin + 3, 96, 4).fill(red);
  label('Confidential approval memo', margin + 13, 91, { color: '#b00010', size: 7.6 });
  value(briefText(request.full_name, 30), margin, 111, { size: 26 });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(muted).text(`${request.request_category} · Requested ${money(request.amount_requested)} · Total need ${money(request.total_amount_needed || request.amount_requested)}`, margin, 142, { width: 390 });
  pill(request.urgency || 'Standard', pageW - 160, 91, 70, request.urgency === 'Emergency' ? '#fff0f1' : '#f3f4f6', '#ffb6bd', '#b00010');
  pill(request.status || 'New Request', pageW - 82, 91, 58, '#f4f5f7', '#d8dde6', dark);

  // decision bar
  const barY = 166;
  doc.roundedRect(margin, barY, pageW - margin*2, 46, 9).fill(maroon);
  const colW = (pageW - margin*2) / 4;
  const items = [
    ['Committee decision', request.decision || 'Pending'],
    ['Approved amount', approvedAmount],
    ['Payment route', request.direct_payment_possible || 'Not provided'],
    ['Due date', request.due_date || 'Not provided']
  ];
  items.forEach(([lab,val], i)=>{
    const x = margin + i * colW;
    if (i) doc.moveTo(x, barY).lineTo(x, barY + 46).strokeColor('#58344b').lineWidth(0.5).stroke();
    label(lab, x + 9, barY + 10, { color: '#ffd2d7', size: 6.2 });
    value(briefText(val, 25), x + 9, barY + 25, { color: 'white', size: 10 });
  });

  // payment / implementation instruction
  panel(margin, 224, pageW - margin*2, 54, 'Payment / implementation instruction');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text('Payment details:', margin + 10, 244, { continued: true });
  doc.font('Helvetica').fillColor(dark).text(' ' + briefText(request.direct_payment_possible === 'Yes' ? request.payment_details : `${request.direct_payment_explanation || ''} Zelle: ${request.zelle_name || 'N/A'} / ${request.zelle_email || 'N/A'} / ${request.zelle_phone || 'N/A'}`, 120));
  doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text('Decision notes:', margin + 10, 259, { continued: true });
  doc.font('Helvetica').fillColor(dark).text(' ' + briefText(request.decision_notes, 100));

  const gap = 10;
  const half = (pageW - margin*2 - gap) / 2;
  let y = 290;
  panel(margin, y, half, 88, 'Applicant snapshot');
  smallBox(margin + 10, y + 28, (half - 30)/2, 25, 'Email', request.email);
  smallBox(margin + 20 + (half - 30)/2, y + 28, (half - 30)/2, 25, 'Phone', request.phone);
  smallBox(margin + 10, y + 58, (half - 30)/2, 25, 'Community', request.cci_community_name);
  smallBox(margin + 20 + (half - 30)/2, y + 58, (half - 30)/2, 25, 'CCI connection', `${request.connection_duration} · Membership: ${request.membership_status === 'Yes' ? 'Official member' : 'Not yet official'} · Celeforce: ${request.worker_status === 'Yes' ? 'Worker' : 'No'}`);

  panel(margin + half + gap, y, half, 88, 'Need and risk');
  doc.font('Helvetica-Bold').fontSize(7.8).fillColor(dark).text('Situation:', margin + half + gap + 10, y + 28, { continued: true });
  doc.font('Helvetica').text(' ' + briefText(request.situation, 65));
  doc.font('Helvetica-Bold').fontSize(7.8).text('Risk if not supported:', margin + half + gap + 10, y + 45, { continued: true });
  doc.font('Helvetica').text(' ' + briefText(request.consequence, 65));
  doc.font('Helvetica-Bold').fontSize(7.8).text('Applicant effort:', margin + half + gap + 10, y + 62, { continued: true });
  doc.font('Helvetica').text(' ' + briefText(request.applicant_effort, 65));

  y = 390;
  panel(margin, y, half, 92, 'Pastoral verification');
  smallBox(margin + 10, y + 28, (half - 30)/2, 25, 'Pastor', `${request.leader_name} · Pastor`);
  smallBox(margin + 20 + (half - 30)/2, y + 28, (half - 30)/2, 25, 'Membership / Celeforce', primaryLeader ? `${primaryLeader.member_confirmed || 'N/A'} / ${primaryLeader.worker_confirmed || 'N/A'}` : 'Pending');
  smallBox(margin + 10, y + 58, (half - 30)/2, 25, 'Support letter', supportLetter);
  doc.font('Helvetica-Bold').fontSize(7.6).fillColor(dark).text('Pastor comments:', margin + 20 + (half - 30)/2, y + 59, { continued: true });
  doc.font('Helvetica').fillColor(dark).text(' ' + (primaryLeader ? briefText(primaryLeader.decision_comments || primaryLeader.pastoral_context, 28) : 'Pending'), { width: (half - 30)/2 });

  panel(margin + half + gap, y, half, 92, 'Review outcome');
  doc.roundedRect(margin + half + gap + 10, y + 28, half - 20, 28, 6).fillAndStroke('#fff4f5', '#ffc7ce');
  doc.rect(margin + half + gap + 10, y + 28, 3, 28).fill(red);
  value(scoreText, margin + half + gap + 20, y + 35, { size: 12 });
  value(interp, margin + half + gap + half - 100, y + 37, { size: 8, color: '#b00010', text: { width: 78, align: 'right' } });
  doc.font('Helvetica-Bold').fontSize(7.8).fillColor(dark).text('Urgency reason:', margin + half + gap + 10, y + 63, { continued: true });
  doc.font('Helvetica').fillColor(dark).text(' ' + briefText(request.urgency_reason, 50));
  doc.font('Helvetica-Bold').fontSize(7.8).text('Reviews received:', margin + half + gap + 10, y + 78, { continued: true });
  doc.font('Helvetica').text(` ${reviews.length} of ${assignedReviewers.length} assigned`);

  y = 494;
  panel(margin, y, pageW - margin*2, 107, 'Reviewer recommendation summary');
  const tx = margin + 10, ty = y + 34;
  const widths = [130, 60, 112, 74, 160];
  const heads = ['Reviewer','Score','Recommendation','Amount','Key note'];
  let x = tx;
  heads.forEach((h,i)=>{ label(h, x, ty, { size: 6.2 }); x += widths[i]; });
  doc.moveTo(tx, ty + 14).lineTo(pageW - margin - 10, ty + 14).strokeColor(line).lineWidth(0.7).stroke();
  const rows = reviews.slice(0,4);
  if (!rows.length) {
    value('No reviewer assessments submitted yet.', tx, ty + 26, { bold: false, size: 8.2 });
  } else {
    rows.forEach((r,idx)=>{
      const yy = ty + 25 + idx*18;
      x = tx;
      const vals = [r.reviewer_name, `${r.score_total || 0}/21`, r.recommended_decision, money(r.recommended_amount), briefText(r.notes, 28)];
      vals.forEach((val,i)=>{ value(val, x, yy, { size: 7.7, text: { width: widths[i] - 6 } }); x += widths[i]; });
      if (idx < rows.length - 1) doc.moveTo(tx, yy+13).lineTo(pageW - margin - 10, yy+13).strokeColor('#f0f1f5').lineWidth(0.5).stroke();
    });
  }

  // evidence inventory
  panel(margin, 612, pageW - margin*2, 36, 'Evidence included with finance packet');
  doc.font('Helvetica').fontSize(7.2).fillColor(dark).text(briefText(evidenceSummary, 185), margin + 10, 632, { width: pageW - margin*2 - 20 });

  // footer
  doc.moveTo(margin, 665).lineTo(pageW - margin, 665).strokeColor(line).lineWidth(0.7).stroke();
  doc.font('Helvetica-Bold').fontSize(6.8).fillColor(muted).text('Confidential: For CCI USA Finance Team and authorized committee use only. · © 2026 CCI America.', margin, 676, { width: 390 });
  if (fs.existsSync(tmakLogo)) doc.image(tmakLogo, pageW - 142, 669, { width: 27 });
  doc.font('Helvetica-Bold').fontSize(6.8).fillColor(muted).text('Developed by TMAK Consultancy', pageW - 112, 676, { width: 76, align: 'right' });
}


function buildFinanceSummaryPdfBuffer({ request, docs = [], verifications, assignedReviewers, reviews, reviewSummary }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, bufferPages: false });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawFinanceSummaryPdf({ doc, request, docs, verifications, assignedReviewers, reviews, reviewSummary });
    doc.end();
  });
}

async function buildFinancePacketZipBuffer({ request, docs = [], verifications, assignedReviewers, reviews, reviewSummary }) {
  const pdfBuffer = await buildFinanceSummaryPdfBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary });
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.append(pdfBuffer, { name: `${request.case_id}-committee-approval-summary.pdf` });

    for (const file of docs || []) {
      const fullPath = path.join(uploadDir, file.stored_name);
      if (fs.existsSync(fullPath)) archive.file(fullPath, { name: `Applicant evidence/${file.original_name}` });
    }

    const leader = verifications && verifications.length ? verifications[0] : null;
    if (leader && leader.support_letter_file) {
      const fullPath = path.join(uploadDir, leader.support_letter_file);
      if (fs.existsSync(fullPath)) archive.file(fullPath, { name: `Pastoral support letter/${leader.support_letter_file}` });
    }

    archive.finalize();
  });
}

async function getDecisionArtifacts(db, requestId) {
  const request = await db.get('SELECT * FROM requests WHERE id=?', requestId);
  const docs = await db.all('SELECT * FROM documents WHERE request_id=?', requestId);
  const verifications = await db.all('SELECT v.*, COALESCE(u.name, v.verifier_name) as verifier_name FROM leader_verifications v LEFT JOIN users u ON u.id=v.verified_by WHERE v.request_id=? ORDER BY v.created_at DESC', requestId);
  const assignedReviewers = await db.all(`
    SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
    FROM request_reviewers rr
    JOIN users u ON u.id = rr.reviewer_id
    WHERE rr.request_id=?
    ORDER BY rr.assigned_at ASC
  `, requestId);
  const reviews = await db.all('SELECT r.*, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.request_id=? ORDER BY r.created_at ASC', requestId);
  return { request, docs, verifications, assignedReviewers, reviews, reviewSummary: reviewScoreSummary(reviews) };
}

function isApprovalDecision(decision) {
  return ['Full Approval','Partial Approval','Conditional Approval'].includes(decision);
}

async function emailFinanceDecisionPacket(db, req, requestId) {
  const { request, docs, verifications, assignedReviewers, reviews, reviewSummary } = await getDecisionArtifacts(db, requestId);
  if (!request) return;
  const financeEmail = process.env.FINANCE_TEAM_EMAIL || 'finance@cci.local';
  const financeName = process.env.FINANCE_TEAM_NAME || 'CCI USA Finance Team';
  const approved = isApprovalDecision(request.decision);
  let token = request.finance_confirm_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    await db.run('UPDATE requests SET finance_confirm_token=? WHERE id=?', [token, request.id]);
    request.finance_confirm_token = token;
  }
  const packetBuffer = await buildFinancePacketZipBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary });
  const amountForAction = approved ? money(request.amount_approved || request.amount_requested) : 'No payment action requested';
  const confirmLink = `${baseUrl(req)}/finance-confirm/${token}`;
  const paymentDetails = request.payment_details || request.direct_payment_explanation || 'No payment details provided.';
  const subject = `CCI America Committee Decision: ${request.case_id} - ${request.decision || 'Decision recorded'}`;
  const body = `Dear ${financeName},

The CCI America Financial Assistance Committee has completed review of the request below.

Case ID: ${request.case_id}
Applicant: ${request.full_name}
Category: ${request.request_category}
Committee recommendation/decision: ${request.decision || 'Pending'}
Amount requested: ${money(request.amount_requested)}
Amount approved / finance action: ${amountForAction}
Due date: ${request.due_date || 'Not provided'}
Urgency: ${request.urgency}

Payment route / direct payment possible: ${request.direct_payment_possible || 'Not provided'}
Payment details/instructions: ${paymentDetails}
Zelle name: ${request.zelle_name || 'N/A'}
Zelle email: ${request.zelle_email || 'N/A'}
Zelle phone: ${request.zelle_phone || 'N/A'}

Decision notes:
${request.decision_notes || 'No decision notes provided.'}

A finance submission packet is attached. It includes the committee summary, applicant evidence, and pastoral support letter if uploaded.

${approved ? `After payment is completed, please confirm payment using this secure link:
${confirmLink}

This confirmation will notify the admin so the applicant can be informed and asked to complete follow-up evidence.` : 'No payment is requested unless further instruction is provided by the committee.'}

Confidentiality: This information is for CCI USA Finance Team and authorized committee use only.

CCI America Financial Assistance Committee`;

  await sendNotification({
    db,
    requestId: request.id,
    recipientName: financeName,
    recipientEmail: financeEmail,
    subject,
    body,
    attachments: [{ filename: `${request.case_id}-finance-submission-package.zip`, content: packetBuffer }]
  });
  await db.run('UPDATE requests SET finance_packet_sent_at=CURRENT_TIMESTAMP WHERE id=?', request.id);
  await logActivity(request.id, req.session && req.session.user ? req.session.user.id : null, 'Finance packet emailed', `Sent to ${financeEmail} with committee decision: ${request.decision}`);
}

async function ensureTwoReviewerInvites(db, req, requestId) {
  const request = await db.get('SELECT * FROM requests WHERE id=?', requestId);
  if (!request) return 0;

  const leaderResponse = await db.get('SELECT id FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC LIMIT 1', requestId);
  if (!leaderResponse) return 0;

  const completedReviews = await db.get('SELECT COUNT(*) as count FROM reviews WHERE request_id=?', requestId);
  if ((completedReviews.count || 0) >= 2) return 0;

  const reminderHours = request.urgency === 'Emergency' ? 12 : 48;
  const replaceHours = request.urgency === 'Emergency' ? 24 : 72;

  const pendingActive = await db.all(`
    SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
    FROM request_reviewers rr
    JOIN users u ON u.id=rr.reviewer_id
    WHERE rr.request_id=? AND rr.accepted_at IS NULL AND rr.declined_at IS NULL AND rr.expired_at IS NULL AND rr.notified_at IS NOT NULL
  `, requestId);

  const now = Date.now();
  for (const inv of pendingActive) {
    const notifiedAt = inv.notified_at ? new Date(inv.notified_at).getTime() : now;
    const ageHours = (now - notifiedAt) / 36e5;
    if (ageHours >= replaceHours) {
      await db.run('UPDATE request_reviewers SET expired_at=CURRENT_TIMESTAMP WHERE id=?', inv.id);
      await logActivity(requestId, null, 'Reviewer invitation expired', `${inv.email} did not respond within ${replaceHours} hours.`);
      if (process.env.AUTO_ASSIGN_REVIEWERS !== 'true') {
        await sendNotification({ db, requestId, recipientName: 'CCI Welfare Admin', recipientEmail: process.env.ADMIN_EMAIL || 'admin@cci.local', subject: `Reviewer replacement needed: ${request.case_id}`, body: `${inv.name} (${inv.email}) did not respond to the review invitation within the allowed window. Please assign a replacement reviewer from the Admin portal.` });
      }
    } else if (ageHours >= reminderHours && !inv.reminder_sent_at) {
      const acceptLink = `${baseUrl(req)}/review-invite/${inv.invite_token}`;
      await sendNotification({
        db,
        requestId,
        recipientName: inv.name,
        recipientEmail: inv.email,
        subject: `Reminder: review availability requested for ${request.case_id}`,
        body: `Dear ${inv.name},

This is a reminder that you were invited to review confidential financial assistance request ${request.case_id}.

Please accept or decline using the secure link below:
${acceptLink}

If there is no response within the review window, another reviewer may be contacted.

CCI America Financial Assistance Committee`
      });
      await db.run('UPDATE request_reviewers SET reminder_sent_at=CURRENT_TIMESTAMP WHERE id=?', inv.id);
      await logActivity(requestId, inv.reviewer_id, 'Reviewer reminder sent', `Reminder sent after ${reminderHours} hours.`);
    }
  }

  const active = await db.all('SELECT * FROM request_reviewers WHERE request_id=? AND declined_at IS NULL AND expired_at IS NULL', requestId);
  const needed = Math.max(0, 2 - active.length);

  if (needed > 0 && process.env.AUTO_ASSIGN_REVIEWERS === 'true') {
    const candidates = await db.all(`
      SELECT u.id, u.name, COALESCE(u.reviewer_contact_email,u.email) as email,
        (SELECT COUNT(*) FROM request_reviewers rr WHERE rr.reviewer_id=u.id AND rr.declined_at IS NULL AND rr.expired_at IS NULL) AS assignment_count,
        (SELECT COUNT(*) FROM reviews rv WHERE rv.reviewer_id=u.id) AS completed_count
      FROM users u
      WHERE u.active=1 AND u.role='reviewer'
        AND u.id NOT IN (SELECT reviewer_id FROM request_reviewers WHERE request_id=?)
      ORDER BY assignment_count ASC, completed_count ASC, RANDOM()
      LIMIT ?
    `, [requestId, needed]);

    for (const reviewer of candidates) {
      const token = crypto.randomBytes(24).toString('hex');
      await db.run('INSERT OR IGNORE INTO request_reviewers (request_id, reviewer_id, assigned_by, invite_token) VALUES (?,?,?,?)', [requestId, reviewer.id, req.session && req.session.user ? req.session.user.id : null, token]);
    }
  }

  const pending = await db.all(`
    SELECT rr.id as assignment_id, rr.notified_at, rr.invite_token, u.id, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
    FROM request_reviewers rr
    JOIN users u ON u.id = rr.reviewer_id
    WHERE rr.request_id=? AND rr.notified_at IS NULL AND rr.declined_at IS NULL AND rr.expired_at IS NULL
    ORDER BY rr.assigned_at ASC
  `, requestId);

  for (const reviewer of pending) {
    const token = reviewer.invite_token || crypto.randomBytes(24).toString('hex');
    if (!reviewer.invite_token) await db.run('UPDATE request_reviewers SET invite_token=? WHERE id=?', [token, reviewer.assignment_id]);
    const inviteLink = `${baseUrl(req)}/review-invite/${token}`;
    await sendNotification({
      db,
      requestId,
      recipientName: reviewer.name,
      recipientEmail: reviewer.email,
      subject: `Review availability requested: ${request.case_id}`,
      body: `Dear ${reviewer.name},

A confidential financial assistance request (${request.case_id}) is ready for review.

Please accept or decline this review request using the secure link below:
${inviteLink}

Only two reviewers are needed for each case. If you decline or do not respond within the review window, another reviewer will be contacted.

Review window:
- Emergency cases: reminder after 12 hours, replacement after 24 hours.
- Other cases: reminder after 48 hours, replacement after 72 hours.

CCI America Financial Assistance Committee`
    });
    await db.run('UPDATE request_reviewers SET notified_at=CURRENT_TIMESTAMP WHERE id=?', reviewer.assignment_id);
  }

  const activeAfter = await db.get('SELECT COUNT(*) as count FROM request_reviewers WHERE request_id=? AND declined_at IS NULL AND expired_at IS NULL', requestId);
  if ((activeAfter.count || 0) > 0) await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Assigned to Reviewers', requestId]);
  return pending.length;
}

async function notifyAssignedReviewers(db, req, requestId) {
  return ensureTwoReviewerInvites(db, req, requestId);
}



function followupDelayDays() {
  const raw = process.env.FOLLOWUP_CLOSEOUT_DELAY_DAYS;
  if (raw === undefined || raw === null || raw === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function followupReminderDays() {
  const raw = process.env.FOLLOWUP_REMINDER_INTERVAL_DAYS;
  if (raw === undefined || raw === null || raw === '') return 7;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

async function sendApplicantPaymentNotice(db, req, request, paymentInfo = {}) {
  const trackingLink = `${baseUrl(req)}/track/${request.tracking_token}`;
  const amountProcessed = paymentInfo.amount || request.payment_confirmation_amount || request.amount_approved || request.amount_requested;
  const method = paymentInfo.method || request.payment_confirmation_method || 'as arranged by the finance team';
  const reference = paymentInfo.reference || request.payment_confirmation_reference || 'not provided';

  await sendNotification({
    db,
    requestId: request.id,
    recipientName: request.full_name,
    recipientEmail: request.email,
    subject: `Your CCI America financial assistance request has been approved: ${request.case_id}`,
    body: `Dear ${request.full_name},

We are pleased to let you know that your financial assistance request has been approved and the approved support has now been processed.

Case ID: ${request.case_id}
Request category: ${request.request_category}
Decision: ${request.decision}
Amount processed: ${money(amountProcessed)}
Payment method/platform: ${method}
Payment reference: ${reference}

We are glad to have been able to support you at this time of need. We will continue to keep you in our prayers, and we wish you all the very best.

For record-keeping and stewardship purposes, a short close-out form will normally be sent after 3 days. There is no action needed from you right now. When you receive the close-out request, kindly complete it and upload any available receipt or confirmation related to the support provided.

You may continue to track your request here:
${trackingLink}

With care,
CCI America Financial Assistance Committee`
  });

  await db.run('UPDATE requests SET applicant_payment_notified_at=CURRENT_TIMESTAMP, applicant_outcome_notified_at=CURRENT_TIMESTAMP, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Payment Confirmed', request.id]);
  await logActivity(request.id, null, 'Applicant payment update email sent', 'Applicant received supportive payment/update email. Close-out request will be sent later.');
}

async function sendApplicantCloseoutRequest(db, req, request) {
  const trackingLink = `${baseUrl(req)}/track/${request.tracking_token}`;
  await sendNotification({
    db,
    requestId: request.id,
    recipientName: request.full_name,
    recipientEmail: request.email,
    subject: `Close-out form for your CCI America financial assistance request: ${request.case_id}`,
    body: `Dear ${request.full_name},

We hope the support provided has been helpful.

As part of our regular record-keeping and stewardship process, please complete the short close-out form for your request. This helps the committee keep accurate records and complete the case file responsibly.

Case ID: ${request.case_id}
Request category: ${request.request_category}
Amount processed: ${money(request.payment_confirmation_amount || request.amount_approved || request.amount_requested)}

Please use your tracking page to complete the close-out form and upload any available receipt, payment confirmation, or related evidence:
${trackingLink}

Completing the close-out form helps keep your request record complete and may be considered when reviewing any future assistance requests.

Thank you,
CCI America Financial Assistance Committee`
  });

  await db.run('UPDATE requests SET applicant_followup_requested_at=CURRENT_TIMESTAMP, applicant_followup_reminder_sent_at=CURRENT_TIMESTAMP, applicant_followup_reminder_count=0, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Follow-Up Requested', request.id]);
  await logActivity(request.id, null, 'Applicant close-out form requested', 'Close-out/follow-up request email sent after payment confirmation.');
}

async function sendApplicantCloseoutReminder(db, req, request) {
  const trackingLink = `${baseUrl(req)}/track/${request.tracking_token}`;
  const count = Number(request.applicant_followup_reminder_count || 0) + 1;
  await sendNotification({
    db,
    requestId: request.id,
    recipientName: request.full_name,
    recipientEmail: request.email,
    subject: `Reminder: close-out form for ${request.case_id}`,
    body: `Dear ${request.full_name},

This is a gentle reminder to complete the short close-out form for your CCI America financial assistance request.

Case ID: ${request.case_id}
Request category: ${request.request_category}
Amount processed: ${money(request.payment_confirmation_amount || request.amount_approved || request.amount_requested)}

Please complete the form through your tracking page and upload any available receipt, payment confirmation, or related evidence:
${trackingLink}

This helps CCI America keep accurate records and complete the case file responsibly.

Thank you,
CCI America Financial Assistance Committee`
  });

  await db.run('UPDATE requests SET applicant_followup_reminder_sent_at=CURRENT_TIMESTAMP, applicant_followup_reminder_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [count, request.id]);
  await logActivity(request.id, null, 'Applicant close-out reminder sent', `Weekly close-out reminder #${count} sent.`);
}

async function runApplicantCloseoutSweep(reason = 'scheduled') {
  const db = await getDb();
  const delay = followupDelayDays();
  const reminderInterval = followupReminderDays();
  const requests = await db.all(`
    SELECT r.*,
      (SELECT COUNT(*) FROM followups f WHERE f.request_id = r.id AND f.submitted_by_applicant = 1) AS applicant_followup_count
    FROM requests r
    WHERE r.payment_confirmed_at IS NOT NULL
      AND r.applicant_payment_notified_at IS NOT NULL
      AND r.status NOT IN ('Closed','Declined')
  `);

  const now = Date.now();
  let sent = 0;
  let reminded = 0;
  for (const request of requests) {
    try {
      if (Number(request.applicant_followup_count || 0) > 0) continue;
      const confirmedAt = request.payment_confirmed_at ? new Date(request.payment_confirmed_at).getTime() : now;
      const ageDays = (now - confirmedAt) / 86400000;
      if (!request.applicant_followup_requested_at) {
        if (ageDays >= delay) {
          await sendApplicantCloseoutRequest(db, null, request);
          sent += 1;
        }
        continue;
      }

      const lastReminderAt = request.applicant_followup_reminder_sent_at || request.applicant_followup_requested_at;
      const lastReminderTime = lastReminderAt ? new Date(lastReminderAt).getTime() : confirmedAt;
      const daysSinceLastReminder = (now - lastReminderTime) / 86400000;
      if (daysSinceLastReminder >= reminderInterval) {
        await sendApplicantCloseoutReminder(db, null, request);
        reminded += 1;
      }
    } catch (err) {
      console.error(`[closeout-sweep] ${request.case_id}:`, err.message);
      await logActivity(request.id, null, 'Close-out sweep error', err.message);
    }
  }
  if (requests.length || sent || reminded) console.log(`[closeout-sweep] ${reason}: checked ${requests.length} request(s), sent ${sent} close-out request(s), sent ${reminded} reminder(s).`);
}

function startApplicantCloseoutScheduler() {
  if (process.env.DISABLE_CLOSEOUT_SCHEDULER === 'true') {
    console.log('[closeout-scheduler] disabled');
    return;
  }
  const minutes = Math.max(1, Number(process.env.CLOSEOUT_SWEEP_INTERVAL_MINUTES || 60));
  console.log(`[closeout-scheduler] running every ${minutes} minute(s); close-out delay ${followupDelayDays()} day(s); reminder interval ${followupReminderDays()} day(s).`);
  setTimeout(() => runApplicantCloseoutSweep('startup').catch(err => console.error('[closeout-scheduler]', err.message)), 15000);
  setInterval(() => runApplicantCloseoutSweep('scheduled').catch(err => console.error('[closeout-scheduler]', err.message)), minutes * 60 * 1000);
}

async function runReviewerInvitationSweep(reason = 'scheduled') {
  const db = await getDb();
  const requests = await db.all(`
    SELECT r.id, r.case_id
    FROM requests r
    WHERE r.status IN ('Pastoral Verification Complete','Leader Verification Complete','Assigned to Reviewers','Committee Review','Under Review')
      AND EXISTS (SELECT 1 FROM leader_verifications lv WHERE lv.request_id = r.id)
      AND (SELECT COUNT(*) FROM reviews rv WHERE rv.request_id = r.id) < 2
  `);

  let totalNotifications = 0;
  for (const request of requests) {
    try {
      const notified = await ensureTwoReviewerInvites(db, null, request.id);
      totalNotifications += Number(notified || 0);
    } catch (err) {
      console.error(`[reviewer-sweep] ${request.case_id}:`, err.message);
      await logActivity(request.id, null, 'Reviewer sweep error', err.message);
    }
  }

  if (requests.length) {
    console.log(`[reviewer-sweep] ${reason}: checked ${requests.length} request(s), queued ${totalNotifications} notification(s).`);
  }
}

function startReviewerScheduler() {
  if (process.env.DISABLE_REVIEWER_SCHEDULER === 'true') {
    console.log('[reviewer-scheduler] disabled');
    return;
  }

  const minutes = Math.max(1, Number(process.env.REVIEWER_SWEEP_INTERVAL_MINUTES || 15));
  console.log(`[reviewer-scheduler] running every ${minutes} minute(s).`);

  // Run once shortly after startup, then on the interval.
  setTimeout(() => runReviewerInvitationSweep('startup').catch(err => console.error('[reviewer-scheduler]', err.message)), 10000);
  setInterval(() => runReviewerInvitationSweep('scheduled').catch(err => console.error('[reviewer-scheduler]', err.message)), minutes * 60 * 1000);
}



const uploadDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const sessionDir = process.env.SESSION_DIR ? path.resolve(process.env.SESSION_DIR) : path.join(__dirname, 'db');
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/png','image/jpeg','image/webp','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-me')) {
  throw new Error('SESSION_SECRET must be set to a strong random value in production.');
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production' || ['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const originHost = new URL(origin).host;
    const requestHost = req.get('host');
    if (originHost !== requestHost) return res.status(403).render('error', { title: 'Request blocked', message: 'This form submission did not originate from the CCI Welfare application.', user: null, publicPage: true, publicLabel: 'Secure request' });
  } catch {
    return res.status(403).render('error', { title: 'Request blocked', message: 'Invalid request origin.', user: null, publicPage: true, publicLabel: 'Secure request' });
  }
  next();
});
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: sessionDir }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.money = money;
  next();
});

app.get('/uploads/:filename', requireRole('admin'), (req, res) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(uploadDir, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).render('error', { title: 'File not found', message: 'The uploaded file could not be found.' });
  const ext = path.extname(safeName).toLowerCase();
  const mimeMap = { '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.doc':'application/msword', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  if (mimeMap[ext]) res.type(mimeMap[ext]);
  const dispositionType = ['.pdf','.png','.jpg','.jpeg','.webp'].includes(ext) ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${dispositionType}; filename="${safeName.replace(/"/g,'')}"`);
  res.sendFile(filePath);
});

app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'cci-welfare-app' }));
app.get('/', (req, res) => res.render('home', { title: 'CCI America Financial Assistance', landingPage: true }));

app.get('/apply', requireRole('applicant'), (req, res) => res.render('apply', { title: 'Financial Assistance Request', error: null }));

app.post('/apply', requireRole('applicant'), upload.fields([
  { name: 'membership_certificate', maxCount: 1 },
  { name: 'map_leader_attestation', maxCount: 1 },
  { name: 'documents', maxCount: 6 }
]), async (req, res) => {
  try {
    const required = ['full_name','email','phone','city_state','cci_connection_type','cci_community_name','leader_name','leader_email','leader_phone','connection_duration','membership_status','worker_status','pastor_informed','request_category','total_amount_needed','amount_requested','applicant_contribution','other_confirmed_support','due_date','situation','consequence','dependents_affected','applicant_effort','one_time_or_ongoing','prior_assistance','direct_payment_possible','applicant_declaration','consent_leader_contact','consent_proof_of_use'];
    for (const field of required) {
      if (!req.body[field]) throw new Error('Please complete all required fields before submitting.');
    }

    if (!['Yes','No'].includes(req.body.membership_status)) {
      throw new Error('Please indicate whether you are an official member of CCI.');
    }
    if (!['Yes','No'].includes(req.body.worker_status)) {
      throw new Error('Please indicate whether you are a worker (Celeforce).');
    }
    if (req.body.membership_status === 'No') {
      if (!['Yes','No'].includes(req.body.map_group_status)) {
        throw new Error('Please indicate whether you belong to a CCI MAP group.');
      }
      if (req.body.map_group_status === 'Yes' && !req.body.map_group_name) {
        throw new Error('Please provide the name of your MAP group.');
      }
    }
    if (req.body.worker_status === 'Yes') {
      const workerFields = ['worker_duration_value','worker_duration_unit','unit_name','unit_leader_name','unit_leader_email','unit_leader_phone'];
      if (workerFields.some(field => !req.body[field])) {
        throw new Error('Please complete the Celeforce service and Unit Head details required for leadership verification.');
      }
    }
    if (req.body.pastor_informed !== 'Yes') {
      throw new Error('Please inform your Pastor about this application before submitting it.');
    }
    const effortActions = normalizeMultiValue(req.body.effort_actions);
    if (effortActions.length === 0) {
      throw new Error('Please select at least one step you have taken to address the need. Select "None yet" if no step has been taken.');
    }
    if (effortActions.includes('None yet') && effortActions.length > 1) {
      throw new Error('Please select either "None yet" or the actions you have taken, not both.');
    }

    const membershipCertificate = req.files && req.files.membership_certificate ? req.files.membership_certificate[0] : null;
    const mapLeaderAttestation = req.files && req.files.map_leader_attestation ? req.files.map_leader_attestation[0] : null;
    const supportingDocuments = req.files && req.files.documents ? req.files.documents : [];

    if (req.body.membership_status === 'Yes' && !membershipCertificate) {
      throw new Error('Please upload your CCI Membership Certificate.');
    }
    if (req.body.membership_status === 'No' && req.body.map_group_status === 'Yes' && !mapLeaderAttestation) {
      throw new Error('Please upload an attestation letter from your MAP Leader.');
    }

    const categoryRequired = {
      'Rent or Housing': ['cat_rent_due','cat_eviction_risk'],
      'Utilities': ['cat_utility_type','cat_disconnection_notice'],
      'Groceries or Food': ['cat_household_size','cat_food_urgent'],
      'Medical or Health-Related Support': ['cat_medical_type','cat_medical_urgent'],
      'Tuition or Education': ['cat_school_name','cat_education_purpose'],
      'Emergency Accommodation': ['cat_current_accommodation','cat_accommodation_timeline','cat_safety_concern'],
      'Special CCI Event Support': ['cat_event_name','cat_event_support_type','cat_event_support_details'],
      'Other Exceptional Need': ['cat_other_description','cat_other_urgency']
    };
    for (const field of (categoryRequired[req.body.request_category] || [])) {
      if (!req.body[field]) throw new Error('Please complete all questions for the selected request type.');
    }
    if (req.body.prior_assistance === 'Yes' && !req.body.prior_assistance_details) {
      throw new Error('Please provide details of previous CCI America financial assistance.');
    }
    if (req.body.direct_payment_possible === 'Yes' && !req.body.payment_details) {
      throw new Error('Please provide vendor/service-provider payment details or instructions.');
    }
    if (req.body.direct_payment_possible === 'No') {
      if (!req.body.direct_payment_explanation) throw new Error('Please explain why direct vendor/service-provider payment is not possible.');
      if (!req.body.zelle_name || !req.body.zelle_email || !req.body.zelle_phone) throw new Error('Please provide the applicant Zelle name, email, and phone number for direct disbursement.');
    }
    if (supportingDocuments.length === 0) {
      throw new Error('Please upload at least one supporting document for the financial need.');
    }

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
      'case_id','applicant_user_id','full_name','email','phone','city_state','cci_connection_type','cci_community_name',
      'leader_name','leader_role','leader_contact','leader_email','leader_phone','leader_verification_token','leader_verification_sent_at','tracking_token',
      'connection_duration','membership_status','map_group_status','map_group_name','worker_status','worker_duration_value','worker_duration_unit',
      'unit_name','unit_leader_name','unit_leader_email','unit_leader_phone','unit_leader_verification_token','unit_leader_verification_sent_at','unit_leader_verified','pastor_informed',
      'request_category','amount_requested','total_amount_needed','due_date','situation','consequence','one_time_or_ongoing','prior_assistance','prior_assistance_details','applicant_effort','applicant_contribution','other_confirmed_support','dependents_affected','effort_actions',
      'direct_payment_possible','payment_details','direct_payment_explanation','zelle_name','zelle_email','zelle_phone','category_details',
      'applicant_declaration','consent_leader_contact','consent_proof_of_use','urgency','urgency_reason','status','leader_verified'
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
      await db.run(
        'INSERT INTO documents (request_id, original_name, stored_name, mime_type, size_bytes, document_type) VALUES (?,?,?,?,?,?)',
        [result.lastID, file.originalname, file.filename, file.mimetype, file.size, documentType]
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



function normalizeApplicantName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

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
  const request = await db.get(`SELECT id, case_id, full_name, email, phone, request_category, amount_requested, total_amount_needed, due_date, status, urgency, urgency_reason, created_at, updated_at, leader_verified, unit_leader_verified, worker_status, decision, amount_approved, tracking_token FROM requests WHERE tracking_token=?`, req.params.token);
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
  await db.run(`INSERT INTO followups (request_id, completed_by, funds_used_as_intended, issue_resolved, receipt_received, pastoral_followup_needed, notes, submitted_by_applicant, receipt_file)
    VALUES (?,?,?,?,?,?,?,?,?)`, [request.id, request.applicant_user_id || 1, req.body.funds_used_as_intended, req.body.issue_resolved, 'Yes', 'Pending admin review', req.body.notes, 1, req.file.filename]);
  await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', ['Follow-Up Submitted', request.id]);
  await logActivity(request.id, request.applicant_user_id || null, 'Applicant follow-up submitted', 'Applicant uploaded receipt/payment evidence for follow-up closure.');
  await sendNotification({ db, requestId: request.id, recipientName: 'Admin', recipientEmail: 'admin@cci.local', subject: `Follow-up evidence submitted: ${request.case_id}`, body: `Applicant follow-up evidence has been submitted for ${request.case_id}. Please log in as admin and complete follow-up closure.` });
  res.redirect(`/track/${req.params.token}`);
});


// Local-only quick login helpers for first-time setup/testing.
// These routes are disabled automatically when NODE_ENV=production.
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

  const requiredFields = ['verifier_name','verifier_email','verifier_phone','worker_confirmed','unit_confirmed','service_duration_value','service_duration_unit','comments'];
  for (const field of requiredFields) {
    if (!req.body[field]) {
      return res.status(400).render('leadership-verify', {
        title: 'Leadership Verification', request, token: req.params.token,
        error: 'Please answer all required leadership verification questions before submitting.', publicPage: true
      });
    }
  }
  if (!['Yes','No'].includes(req.body.worker_confirmed) || !['Yes','No'].includes(req.body.unit_confirmed)) {
    return res.status(400).render('leadership-verify', {
      title: 'Leadership Verification', request, token: req.params.token,
      error: 'Please answer the worker and unit verification questions with Yes or No.', publicPage: true
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

app.get('/leadership-verify/:token', renderLeadershipVerification);
app.post('/leadership-verify/:token', submitLeadershipVerification);

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

  const requiredPastorFields = ['verifier_name','verifier_email','verifier_phone','is_member','is_regular_participant','is_worker','known_duration_value','known_duration_unit','decision_comments'];
  const categoryDetails = JSON.parse(request.category_details || '{}');
  for (const field of requiredPastorFields) {
    if (!req.body[field]) {
      return res.status(400).render('leader-verify', {
        title: 'Pastoral Verification',
        request,
        token: req.params.token,
        categoryDetails,
        error: 'Please answer all required pastoral verification questions before submitting.',
        publicPage: true
      });
    }
  }

  if (!['Yes','No'].includes(req.body.is_member) || !['Yes','No'].includes(req.body.is_regular_participant) || !['Yes','No'].includes(req.body.is_worker)) {
    return res.status(400).render('leader-verify', {
      title: 'Pastoral Verification',
      request,
      token: req.params.token,
      categoryDetails,
      error: 'Please answer the membership, CCI participation, and worker verification questions with Yes or No.',
      publicPage: true
    });
  }

  const filename = req.file ? req.file.filename : '';
  await db.run(`INSERT INTO leader_verifications (
    request_id, verified_by, verifier_name, verifier_email, verifier_phone,
    knows_applicant, active_connection, aware_of_need, pastoral_context, recommendation, support_letter_file,
    member_confirmed, worker_confirmed, known_duration_value, known_duration_unit, decision_comments
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    request.id, null, req.body.verifier_name, req.body.verifier_email, req.body.verifier_phone,
    'Yes', req.body.is_regular_participant, 'Not separately asked', req.body.decision_comments, '', filename,
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
        db, requestId: request.id, recipientName: 'CCI Welfare Admin', recipientEmail: process.env.ADMIN_EMAIL || 'admin@cci.local',
        subject: `Reviewer assignment needed: ${request.case_id}`,
        body: `Pastoral verification is complete for ${request.case_id}. Please log in to the Admin portal and assign two reviewers from the Reviewer Directory.`
      });
    }
  }

  res.render('leader-verify-success', { title: 'Pastoral Verification Submitted', request, publicPage: true });
}

app.get('/pastor-verify/:token', renderPastorVerification);
app.post('/pastor-verify/:token', upload.single('support_letter'), submitPastorVerification);

// Backward-compatible aliases for verification links generated by older builds.
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

async function getReviewAccess(db, token) {
  return db.get(`
    SELECT rr.*, r.case_id, r.id as request_id_value, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email
    FROM request_reviewers rr
    JOIN requests r ON r.id=rr.request_id
    JOIN users u ON u.id=rr.reviewer_id
    WHERE rr.review_token=? AND rr.accepted_at IS NOT NULL AND rr.declined_at IS NULL AND rr.expired_at IS NULL
  `, token);
}

app.get('/review/:token/uploads/:filename', async (req, res) => {
  const db = await getDb();
  const access = await getReviewAccess(db, req.params.token);
  if (!access || access.review_submitted_at) return res.status(403).render('error', { title: 'Access denied', message: 'This reviewer access link is invalid, completed, or expired.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
  const safeName = path.basename(req.params.filename);
  const belongs = await db.get('SELECT id FROM documents WHERE request_id=? AND stored_name=?', [access.request_id, safeName]);
  const pastoral = await db.get('SELECT id FROM leader_verifications WHERE request_id=? AND support_letter_file=?', [access.request_id, safeName]);
  if (!belongs && !pastoral) return res.status(404).render('error', { title: 'File not found', message: 'This file is not part of the assigned case.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
  const filePath = path.join(uploadDir, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).render('error', { title: 'File not found', message: 'The uploaded file could not be found.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
  res.sendFile(filePath);
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
    title: `Review ${request.case_id}`, request, docs, verifications, leadershipVerifications,
    myReview, categoryDetails, systemAssessment, query: req.query || {},
    publicPage: true, publicLabel: 'Secure reviewer workspace', reviewToken: req.params.token,
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

  const ratingFields = ['urgency_rating','severity_rating','gap_rating','effort_rating','history_rating','policy_rating','documentation_rating'];
  for (const field of ratingFields) {
    const score = Number(req.body[field]);
    if (![1,2,3].includes(score)) return res.status(400).render('error', { title: 'Incomplete review', message: 'Please provide a 1–3 rating for each review criterion.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
  }
  if (!['Yes','Partially','No'].includes(req.body.system_assessment_agreement)) {
    return res.status(400).render('error', { title: 'Incomplete review', message: 'Please indicate whether you agree with the system-generated preliminary assessment.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
  }
  const changedRatings = ratingFields.filter(field => {
    const systemItem = Object.values(systemAssessment.ratings).find(x => x.field === field);
    return systemItem && Number(req.body[field]) !== Number(systemItem.score);
  });
  if ((req.body.system_assessment_agreement !== 'Yes' || changedRatings.length) && !String(req.body.override_reason || '').trim()) {
    return res.status(400).render('error', { title: 'Reason required', message: 'Please briefly explain any disagreement with, or change to, the system-generated assessment.', publicPage: true, publicLabel: 'Secure reviewer workspace' });
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
  const expectedRole = (req.body.expectedRole || '').trim();
  const loginEmail = String(req.body.email || '').trim().toLowerCase();
  const loginPassword = String(req.body.password || '');
  const user = await db.get('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1', loginEmail);
  if (!user || !loginPassword || !(await bcrypt.compare(loginPassword, user.password_hash))) {
    return res.status(401).render('login', { title: 'Login', error: 'Invalid email or password.', selectedRole: expectedRole });
  }

  if (!['admin','applicant'].includes(user.role)) {
    return res.status(403).render('login', { title: 'Login', error: 'This role does not use a password login. Reviewers and verifiers access cases only through secure email links.', selectedRole: expectedRole });
  }

  // If the user selected a portal, make sure the account belongs to that role.
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
app.post('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

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
  const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  const docs = await db.all('SELECT * FROM documents WHERE request_id=?', req.params.id);
  const verifications = await db.all('SELECT v.*, COALESCE(u.name, v.verifier_name) as verifier_name FROM leader_verifications v LEFT JOIN users u ON u.id=v.verified_by WHERE v.request_id=? ORDER BY v.created_at DESC', req.params.id);
  const assignedReviewers = await db.all(`
    SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
    FROM request_reviewers rr
    JOIN users u ON u.id = rr.reviewer_id
    WHERE rr.request_id=?
    ORDER BY rr.assigned_at ASC
  `, req.params.id);
  const reviews = await db.all('SELECT r.*, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.request_id=? ORDER BY r.created_at ASC', req.params.id);
  const categoryDetails = JSON.parse(request.category_details || '{}');
  res.render('request-report', { title: `Review Report ${request.case_id}`, request, docs, verifications, assignedReviewers, reviews, categoryDetails, reviewSummary: reviewScoreSummary(reviews) });
});


app.get('/requests/:id/report/download', requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  const docs = await db.all('SELECT * FROM documents WHERE request_id=?', req.params.id);
  const verifications = await db.all('SELECT v.*, COALESCE(u.name, v.verifier_name) as verifier_name FROM leader_verifications v LEFT JOIN users u ON u.id=v.verified_by WHERE v.request_id=? ORDER BY v.created_at DESC', req.params.id);
  const assignedReviewers = await db.all(`
    SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
    FROM request_reviewers rr
    JOIN users u ON u.id = rr.reviewer_id
    WHERE rr.request_id=?
    ORDER BY rr.assigned_at ASC
  `, req.params.id);
  const reviews = await db.all('SELECT r.*, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.request_id=? ORDER BY r.created_at ASC', req.params.id);
  const filename = `${request.case_id}-committee-approval-summary.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, bufferPages: false });
  doc.pipe(res);
  drawFinanceSummaryPdf({ doc, request, docs, verifications, assignedReviewers, reviews, reviewSummary: reviewScoreSummary(reviews) });
  doc.end();
});


app.get('/requests/:id/report/package', requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  const docs = await db.all('SELECT * FROM documents WHERE request_id=?', req.params.id);
  const verifications = await db.all('SELECT v.*, COALESCE(u.name, v.verifier_name) as verifier_name FROM leader_verifications v LEFT JOIN users u ON u.id=v.verified_by WHERE v.request_id=? ORDER BY v.created_at DESC', req.params.id);
  const assignedReviewers = await db.all(`
    SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
    FROM request_reviewers rr
    JOIN users u ON u.id = rr.reviewer_id
    WHERE rr.request_id=?
    ORDER BY rr.assigned_at ASC
  `, req.params.id);
  const reviews = await db.all('SELECT r.*, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.request_id=? ORDER BY r.created_at ASC', req.params.id);
  const pdfBuffer = await buildFinanceSummaryPdfBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary: reviewScoreSummary(reviews) });

  const filename = `${request.case_id}-finance-submission-package.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { throw err; });
  archive.pipe(res);
  archive.append(pdfBuffer, { name: `${request.case_id}-committee-approval-summary.pdf` });

  for (const file of docs) {
    const fullPath = path.join(uploadDir, file.stored_name);
    if (fs.existsSync(fullPath)) archive.file(fullPath, { name: `Applicant evidence/${file.original_name}` });
  }

  const leader = verifications && verifications.length ? verifications[0] : null;
  if (leader && leader.support_letter_file) {
    const fullPath = path.join(uploadDir, leader.support_letter_file);
    if (fs.existsSync(fullPath)) archive.file(fullPath, { name: `Pastoral support letter/${leader.support_letter_file}` });
  }

  await archive.finalize();
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
  res.render('request-detail', { title: request.case_id, request, docs, users, assignedReviewers, reviews, verifications, leadershipVerifications, logs, applicantFollowup, reviewSummary: reviewScoreSummary(reviews), categoryDetails: JSON.parse(request.category_details || '{}') });
});

app.post('/requests/:id/status', requireRole('admin'), async (req, res) => {
  const db = await getDb();
  await db.run('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [req.body.status, req.params.id]);
  await logActivity(req.params.id, req.session.user.id, 'Status updated', req.body.status);
  res.redirect(`/requests/${req.params.id}`);
});

app.post('/requests/:id/urgency', requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const allowed = ['Emergency','Urgent','Standard'];
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
    await db.run(`UPDATE request_reviewers SET assigned_by=?, assigned_at=CURRENT_TIMESTAMP, notified_at=NULL, invite_token=?, accepted_at=NULL, declined_at=NULL, review_token=NULL, review_token_sent_at=NULL, review_submitted_at=NULL, reminder_sent_at=NULL, expired_at=NULL WHERE id=?`, [req.session.user.id, inviteToken, existing.id]);
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
  const assignment = await db.get(`SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email FROM request_reviewers rr JOIN users u ON u.id=rr.reviewer_id WHERE rr.id=? AND rr.request_id=?`, [req.params.assignmentId, req.params.id]);
  if (!assignment) return res.redirect(`/requests/${req.params.id}`);
  const review = await db.get('SELECT id FROM reviews WHERE request_id=? AND reviewer_id=?', [req.params.id, assignment.reviewer_id]);
  if (review) return res.status(400).render('error', { title: 'Cannot remove completed review', message: 'This reviewer has already submitted an assessment. The review remains part of the audit record.' });
  await db.run('DELETE FROM request_reviewers WHERE id=?', assignment.id);
  await logActivity(req.params.id, req.session.user.id, 'Reviewer assignment removed', `${assignment.name} <${assignment.email}>`);
  res.redirect(`/requests/${req.params.id}?reviewerRemoved=1`);
});

app.post('/requests/:id/reviewers/:assignmentId/resend', requireRole('admin'), async (req, res) => {
  const db = await getDb();
  const assignment = await db.get(`SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email, r.case_id FROM request_reviewers rr JOIN users u ON u.id=rr.reviewer_id JOIN requests r ON r.id=rr.request_id WHERE rr.id=? AND rr.request_id=?`, [req.params.assignmentId, req.params.id]);
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

app.post('/requests/:id/verification' , requireRole('admin'), async (req, res) => {
  const db = await getDb();
  await db.run(`INSERT INTO leader_verifications (request_id, verified_by, verifier_name, verifier_email, knows_applicant, active_connection, aware_of_need, pastoral_context, recommendation) VALUES (?,?,?,?,?,?,?,?,?)`, [req.params.id, req.session.user.id, req.session.user.name, req.session.user.email, req.body.knows_applicant, req.body.active_connection, req.body.aware_of_need, req.body.pastoral_context || '', req.body.recommendation || '']);
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
  const assignment = await db.get('SELECT id FROM request_reviewers WHERE request_id=? AND reviewer_id=? AND accepted_at IS NOT NULL', [req.params.id, req.session.user.id]);

  const request = await db.get('SELECT * FROM requests WHERE id=?', req.params.id);
  if (!request) return res.status(404).render('error', { title: 'Request not found', message: 'The requested case could not be found.' });
  const docs = await db.all('SELECT * FROM documents WHERE request_id=? ORDER BY uploaded_at ASC', req.params.id);
  const verifications = await db.all('SELECT * FROM leader_verifications WHERE request_id=? ORDER BY created_at DESC', req.params.id);
  const leadershipVerifications = await db.all('SELECT * FROM leadership_verifications WHERE request_id=? ORDER BY created_at DESC', req.params.id);
  const systemAssessment = await buildSystemAssessment(db, request, docs, verifications, leadershipVerifications);

  const ratingFields = ['urgency_rating','severity_rating','gap_rating','effort_rating','history_rating','policy_rating','documentation_rating'];
  for (const field of ratingFields) {
    const score = Number(req.body[field]);
    if (![1,2,3].includes(score)) return res.status(400).render('error', { title: 'Incomplete review', message: 'Please provide a 1–3 rating for each review criterion.' });
  }
  if (!['Yes','Partially','No'].includes(req.body.system_assessment_agreement)) {
    return res.status(400).render('error', { title: 'Incomplete review', message: 'Please indicate whether you agree with the system-generated preliminary assessment.' });
  }
  const changedRatings = ratingFields.filter(field => {
    const systemItem = Object.values(systemAssessment.ratings).find(x => x.field === field);
    return systemItem && Number(req.body[field]) !== Number(systemItem.score);
  });
  if ((req.body.system_assessment_agreement !== 'Yes' || changedRatings.length) && !String(req.body.override_reason || '').trim()) {
    return res.status(400).render('error', { title: 'Reason required', message: 'Please briefly explain any disagreement with, or change to, the system-generated assessment.' });
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
  await db.run(`UPDATE requests SET decision=?, amount_approved=?, decision_notes=?, pastorate_required=?, pastorate_decision=?, documents_complete=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [
    req.body.decision, req.body.amount_approved || null, req.body.decision_notes || '', req.body.pastorate_required || 'No', req.body.pastorate_decision || '', req.body.documents_complete || 'Pending', status, req.params.id
  ]);
  await logActivity(req.params.id, req.session.user.id, 'Decision recorded', req.body.decision);
  await emailFinanceDecisionPacket(db, req, req.params.id);

  // For decisions that do not require finance payment confirmation, notify the applicant immediately.
  // For approvals, applicant notification is sent after finance confirms payment.
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
  const fileName = req.file ? req.file.filename : null;
  await db.run(`UPDATE requests SET payment_confirmed_at=CURRENT_TIMESTAMP, payment_confirmed_by=?, payment_confirmation_amount=?, payment_confirmation_method=?, payment_confirmation_reference=?, payment_confirmation_notes=?, payment_confirmation_file=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [
    req.body.confirmed_by || 'CCI USA Finance Team', req.body.amount_paid || request.amount_approved || request.amount_requested, req.body.payment_method || '', req.body.payment_reference || '', req.body.confirmation_notes || '', fileName, 'Payment Confirmed', request.id
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
  let subject, body, newStatus;
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
  await db.run(`INSERT INTO followups (request_id, completed_by, funds_used_as_intended, issue_resolved, receipt_received, pastoral_followup_needed, notes) VALUES (?,?,?,?,?,?,?)`, [req.params.id, req.session.user.id, req.body.funds_used_as_intended, req.body.issue_resolved, req.body.receipt_received, req.body.pastoral_followup_needed, req.body.notes || '']);
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
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => escapeCsv(r[h])).join(','))].join('\n');
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
  if (!name || !email) return res.redirect('/admin/reviewers?error=' + encodeURIComponent('Reviewer name and email are required.'));
  const existingReviewer = await db.get("SELECT id FROM users WHERE role='reviewer' AND lower(COALESCE(reviewer_contact_email,email))=lower(?)", email);
  if (existingReviewer) {
    await db.run('UPDATE users SET name=?, reviewer_contact_email=?, active=1 WHERE id=?', [name, email, existingReviewer.id]);
    return res.redirect('/admin/reviewers?added=reactivated');
  }
  // Reviewer contacts are intentionally separate from login identities. The internal
  // users.email value is synthetic so the same real email may also belong to an Applicant/Admin account.
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
    const role = ['admin','applicant'].includes(req.body.role) ? req.body.role : 'applicant';
    if (!req.body.password || String(req.body.password).length < 8) throw new Error('Password must contain at least 8 characters.');
    const hash = await bcrypt.hash(req.body.password, 12);
    await db.run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', [req.body.name, String(req.body.email || '').trim().toLowerCase(), hash, role]);
    await logActivity(null, req.session.user.id, 'Login account created', `${req.body.email} (${role})`);
    res.redirect('/admin/users');
  } catch (err) {
    const users = await db.all("SELECT id,name,email,role,active,created_at FROM users WHERE role IN ('admin','applicant') ORDER BY created_at DESC");
    res.status(400).render('users', { title: 'Login Accounts', users, error: err.message || 'Could not create account. Email may already exist.' });
  }
});

app.post('/admin/users/:id/toggle', requireRole('admin'), async (req, res) => {
  const db = await getDb();
  await db.run("UPDATE users SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=? AND role IN ('admin','applicant')", req.params.id);
  res.redirect('/admin/users');
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
