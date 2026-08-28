const { money, normalizeMultiValue } = require('./helpers');
const { REVIEW_RATING_FIELDS } = require('./validators/review-validator');

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
  return { ...info, stages, stageComplete: !!info.stageComplete, isClosed: ['Closed', 'Declined'].includes(status) };
}

function reviewScoreTotal(rowOrBody) {
  return REVIEW_RATING_FIELDS.reduce((sum, field) => {
    const value = Number(rowOrBody[field] || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function reviewScoreSummary(reviews) {
  const totals = (reviews || []).map(r => Number(r.score_total || reviewScoreTotal(r))).filter(n => Number.isFinite(n) && n > 0);
  const maxPerReview = 21;
  const average = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
  return {
    count: totals.length,
    maxPerReview,
    average,
    averageRounded: average ? average.toFixed(1) : '0.0',
    averagePercent: average ? Math.round((average / maxPerReview) * 100) : 0
  };
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
  const flags = [];
  const escalationReasons = [];

  const pastor = verifications && verifications.length ? verifications[0] : null;
  const unit = leadershipVerifications && leadershipVerifications.length ? leadershipVerifications[0] : null;
  const months = connectionMonths(request.connection_duration);
  const membershipDoc = docs.some(d => d.document_type === 'CCI Membership Certificate');
  const mapDoc = docs.some(d => d.document_type === 'MAP Leader Attestation Letter');
  const supportingDocs = docs.filter(d => d.document_type === 'Supporting document');

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
    else {
      eligibilityStatus = 'Needs attention';
      eligibilityReasons.push('Applicant reported official membership but no membership certificate is recorded.');
      flags.push('Membership certificate missing.');
    }
  } else if (request.map_group_status === 'Yes') {
    if (mapDoc) eligibilityReasons.push('Non-certified membership/active MAP connection is supported by a MAP Leader attestation letter.');
    else {
      eligibilityStatus = 'Needs attention';
      eligibilityReasons.push('MAP participation was reported but the MAP Leader attestation is missing.');
      flags.push('MAP Leader attestation missing.');
    }
  } else {
    eligibilityReasons.push('Applicant is not yet an official member and did not report MAP participation; pastoral confirmation is therefore especially important.');
  }
  if (pastor) {
    if (pastor.active_connection === 'Yes') eligibilityReasons.push('Pastor confirmed current CCI participation.');
    else {
      eligibilityStatus = 'Escalate';
      eligibilityReasons.push('Pastor did not confirm current CCI participation.');
      escalationReasons.push('Pastoral verification did not confirm current CCI participation.');
    }
    if (pastor.member_confirmed && pastor.member_confirmed !== request.membership_status) flags.push('Applicant and Pastor membership responses do not match.');
    if (pastor.worker_confirmed && pastor.worker_confirmed !== request.worker_status) flags.push('Applicant and Pastor Celeforce responses do not match.');
  } else {
    eligibilityStatus = eligibilityStatus === 'Escalate' ? 'Escalate' : 'Needs attention';
    eligibilityReasons.push('Pastoral verification has not been completed.');
  }
  if (request.worker_status === 'Yes') {
    if (!unit) {
      eligibilityStatus = eligibilityStatus === 'Escalate' ? 'Escalate' : 'Needs attention';
      flags.push('Unit Head verification is missing.');
    } else if (unit.worker_confirmed !== 'Yes' || unit.unit_confirmed !== 'Yes') {
      eligibilityStatus = 'Escalate';
      escalationReasons.push('Unit Head verification does not fully confirm the applicant\'s Celeforce/unit status.');
    }
  }

  const urgencyMap = { Emergency: 3, Urgent: 2, Standard: 1 };
  const urgencyScore = urgencyMap[request.urgency] || 1;
  const urgencyReason = request.urgency_reason || `System triage classified this request as ${request.urgency || 'Standard'}.`;

  const highImpact = yes(details.eviction_risk) || yes(details.disconnection_notice) || yes(details.food_urgent) || yes(details.medical_urgent) || yes(details.safety_concern) || request.request_category === 'Emergency Accommodation' || has('homeless', 'evict', 'no food', 'unsafe', 'hospital', 'medical emergency', 'disconnection', 'shut off');
  const dependents = String(request.dependents_affected || 'No');
  const hasDependents = dependents && dependents !== 'No';
  const essentialCategory = ['Rent or Housing', 'Utilities', 'Groceries or Food', 'Medical or Health-Related Support', 'Emergency Accommodation'].includes(request.request_category);
  const severityScore = highImpact ? 3 : (essentialCategory || hasDependents ? 2 : 1);
  const severityReason = highImpact
    ? `High-impact indicator detected${hasDependents ? `; dependents are affected (${dependents})` : ''}.`
    : (essentialCategory || hasDependents ? `The request affects an essential need${hasDependents ? ` and dependents (${dependents})` : ''}, but no immediate critical-impact indicator was detected.` : 'No structured critical-impact indicator was detected.');

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

  const priorCases = await db.all(`
    SELECT id, case_id, decision, amount_approved, created_at
    FROM requests
    WHERE id <> ?
      AND (applicant_user_id = ? OR lower(email) = lower(?))
      AND decision IN ('Full Approval','Partial Approval','Conditional Approval')
    ORDER BY created_at DESC
  `, [request.id, request.applicant_user_id || -1, request.email]);
  const year = new Date().getFullYear();
  const currentYearCases = priorCases.filter(c => String(c.created_at || '').startsWith(String(year)));
  const approvedThisYear = currentYearCases.length;
  const amountThisYear = currentYearCases.reduce((sum, c) => sum + Number(c.amount_approved || 0), 0);
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

  const standardCategories = ['Rent or Housing', 'Utilities', 'Groceries or Food', 'Medical or Health-Related Support', 'Tuition or Education', 'Emergency Accommodation', 'Special CCI Event Support'];
  let policyScore = standardCategories.includes(request.request_category) ? 3 : 1;
  const policyNotes = [];
  if (standardCategories.includes(request.request_category)) policyNotes.push('Request falls within a recognized assistance category.');
  else {
    policyNotes.push('Request is an exceptional/non-standard category.');
    escalationReasons.push('Request is outside the standard listed assistance categories and requires exception review.');
  }

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

  let documentationScore = 3;
  const docNotes = [];
  if (supportingDocs.length) docNotes.push(`${supportingDocs.length} financial supporting document(s) uploaded.`);
  else {
    documentationScore = 1;
    docNotes.push('No financial supporting document is recorded.');
    flags.push('Supporting financial documentation missing.');
  }
  if (request.membership_status === 'Yes' && !membershipDoc) documentationScore = Math.min(documentationScore, 1);
  if (request.membership_status === 'No' && request.map_group_status === 'Yes' && !mapDoc) documentationScore = Math.min(documentationScore, 1);
  if (!pastor) {
    documentationScore = Math.min(documentationScore, 2);
    docNotes.push('Pastoral verification is not yet recorded.');
  } else {
    docNotes.push('Pastoral verification completed.');
  }
  if (request.worker_status === 'Yes') {
    if (!unit) {
      documentationScore = Math.min(documentationScore, 2);
      docNotes.push('Required Unit Head verification is not yet recorded.');
    } else {
      docNotes.push('Unit Head verification completed.');
    }
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
  const total = Object.values(ratings).reduce((sum, rating) => sum + Number(rating.score || 0), 0);

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

function isApprovalDecision(decision) {
  return ['Full Approval', 'Partial Approval', 'Conditional Approval'].includes(decision);
}

module.exports = {
  applicantStatusInfo,
  buildSystemAssessment,
  isApprovalDecision,
  reviewScoreSummary,
  reviewScoreTotal
};
