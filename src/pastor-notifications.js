function amountForCommitteeDecision(request) {
  if (request.amount_approved !== null && request.amount_approved !== undefined && request.amount_approved !== '') {
    return Number(request.amount_approved);
  }

  return String(request.decision || '').includes('Approval')
    ? Number(request.amount_requested || 0)
    : 0;
}

function amountsDiffer(left, right) {
  return Math.round(Number(left || 0) * 100) !== Math.round(Number(right || 0) * 100);
}

function pastorGreeting(name) {
  const pastorName = String(name || '').trim().replace(/^pastor\s+/i, '');
  return pastorName ? `Dear Pastor ${pastorName},` : 'Dear Pastor,';
}

function createPastorNotificationService({ logActivity, money, sendNotification }) {
  async function getVerifyingPastor(db, request) {
    const verification = await db.get(
      `SELECT verified_by, verifier_name, verifier_email
       FROM leader_verifications
       WHERE request_id=?
       ORDER BY created_at DESC
       LIMIT 1`,
      request.id
    );

    const wasSubmittedByPastor = verification && !verification.verified_by && verification.verifier_email;
    return {
      name: wasSubmittedByPastor ? verification.verifier_name : request.leader_name,
      email: wasSubmittedByPastor ? verification.verifier_email : request.leader_email
    };
  }

  async function sendPastorNotice({ db, request, actorId = null, subject, body, successAction, failureAction }) {
    const pastor = await getVerifyingPastor(db, request);
    if (!pastor.email) {
      await logActivity(request.id, actorId, failureAction, 'No verifying pastor email is available.');
      return { success: false, skipped: true, reason: 'No verifying pastor email is available.' };
    }

    const delivery = await sendNotification({
      db,
      requestId: request.id,
      recipientName: pastor.name || 'Pastor',
      recipientEmail: pastor.email,
      subject,
      body: body(pastor)
    });

    await logActivity(
      request.id,
      actorId,
      delivery.success ? successAction : failureAction,
      delivery.success ? pastor.email : (delivery.reason || 'Email delivery failed')
    );
    return delivery;
  }

  async function sendPastorDecisionNotice(db, request, actorId = null) {
    const approvedAmount = amountForCommitteeDecision(request);
    const approved = String(request.decision || '').includes('Approval');

    return sendPastorNotice({
      db,
      request,
      actorId,
      subject: `Committee decision for ${request.full_name}: ${request.case_id}`,
      body: (pastor) => `${pastorGreeting(pastor.name)}

Thank you for completing the pastoral verification for ${request.full_name}'s financial assistance request.

The CCI America Financial Assistance Committee has now recorded its decision.

Case ID: ${request.case_id}
Applicant: ${request.full_name}
Committee decision: ${request.decision}
Amount approved by the committee: ${money(approvedAmount)}

${approved ? 'The request will now proceed to the Finance team for payment processing. You will receive another email when Finance confirms the amount actually paid.' : 'No payment is currently scheduled for this decision.'}

This information should continue to be handled confidentially.

CCI America Financial Assistance Committee`,
      successAction: 'Verifying pastor notified of committee decision',
      failureAction: 'Verifying pastor decision notification failed'
    });
  }

  async function sendPastorPaymentNotice(db, request, actorId = null) {
    const approvedAmount = amountForCommitteeDecision(request);
    const paidAmount = Number(request.payment_confirmation_amount || 0);
    const amountComparison = amountsDiffer(approvedAmount, paidAmount)
      ? `The amounts are different: the committee approved ${money(approvedAmount)}, while the church paid ${money(paidAmount)}.`
      : 'The amount paid by the church matches the amount approved by the committee.';

    return sendPastorNotice({
      db,
      request,
      actorId,
      subject: `Payment confirmed for ${request.full_name}: ${request.case_id}`,
      body: (pastor) => `${pastorGreeting(pastor.name)}

Finance has confirmed payment for ${request.full_name}'s financial assistance request.

Case ID: ${request.case_id}
Applicant: ${request.full_name}
Committee decision: ${request.decision}
Amount approved by the committee: ${money(approvedAmount)}
Amount paid by the church: ${money(paidAmount)}

${amountComparison}

This information should continue to be handled confidentially.

CCI America Financial Assistance Committee`,
      successAction: 'Verifying pastor notified of finance payment',
      failureAction: 'Verifying pastor payment notification failed'
    });
  }

  return {
    sendPastorDecisionNotice,
    sendPastorPaymentNotice
  };
}

module.exports = {
  amountForCommitteeDecision,
  amountsDiffer,
  createPastorNotificationService,
  pastorGreeting
};
