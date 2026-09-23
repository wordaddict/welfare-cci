const { money } = require('./helpers');
const { isApprovalDecision } = require('./request-assessment');

const EXTERNAL_SOURCE = 'welfare-workflow';
const EXPENSE_CATEGORY = 'Financial Welfare/Assistance';
const FINANCE_CAMPUSES = new Set([
  'DMV',
  'CCI_VIRTUAL',
  'DALLAS',
  'BOSTON',
  'AUSTIN',
  'CCI_USA_NASHVILLE',
  'CCI_USA_OKLAHOMA',
  'CCI_USA_NEWYORK_NEWJERSEY',
  'CCI_USA_KNOXVILLE',
  'CCI_USA_NORTH_CAROLINA',
  'CCI_USA_ATLANTA',
  'CCI_USA_BAY_AREA',
  'CCI_USA_CHICAGO',
  'CCI_USA_HOUSTON'
]);

function amountToCents(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

function financeExternalId(request) {
  return request.case_id || String(request.id);
}

function financePacketFileName(request) {
  return `${financeExternalId(request)}-finance-submission-package.zip`;
}

function urgencyScore(urgency) {
  if (urgency === 'Emergency') return 3;
  if (urgency === 'Urgent') return 2;
  return 1;
}

function payeeZelle(request) {
  return [request.zelle_email, request.zelle_phone]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' / ');
}

function financeCampus(request, financeConfig) {
  const requestCampus = String(request.campus || '').trim();
  if (FINANCE_CAMPUSES.has(requestCampus)) return requestCampus;
  return financeConfig.defaultCampus;
}

function paymentDescription(request) {
  const directPayment = request.direct_payment_possible || 'Not provided';
  const details = request.direct_payment_possible === 'Yes'
    ? request.payment_details
    : request.direct_payment_explanation;

  return [
    `Case ID: ${financeExternalId(request)}`,
    `Applicant: ${request.full_name || 'Not provided'}`,
    `Decision: ${request.decision || 'Not provided'}`,
    `Requested amount: ${money(request.amount_requested)}`,
    `Approved amount: ${money(request.amount_approved || request.amount_requested)}`,
    `Request category: ${request.request_category || 'Not provided'}`,
    `Payment route/direct payment possible: ${directPayment}`,
    `Payment details: ${details || 'Not provided'}`,
    `Zelle name: ${request.zelle_name || 'N/A'}`,
    `Zelle email: ${request.zelle_email || 'N/A'}`,
    `Zelle phone: ${request.zelle_phone || 'N/A'}`,
    `Decision notes: ${request.decision_notes || 'No decision notes provided.'}`
  ].join('\n');
}

function buildFinanceExpensePayload({ request, financeConfig, packetBase64 }) {
  const externalId = financeExternalId(request);
  const amountCents = amountToCents(request.amount_approved || request.amount_requested);
  const title = `Financial assistance approved for ${externalId}`;

  return {
    externalSource: EXTERNAL_SOURCE,
    externalId,
    title,
    amountCents,
    team: financeConfig.defaultTeam,
    campus: financeCampus(request, financeConfig),
    description: paymentDescription(request),
    notes: request.decision_notes || '',
    category: EXPENSE_CATEGORY,
    urgency: urgencyScore(request.urgency),
    payToExternal: true,
    payeeName: request.zelle_name || request.full_name || '',
    payeeZelle: payeeZelle(request),
    items: [{
      description: title,
      quantity: 1,
      unitPriceCents: amountCents,
      amountCents
    }],
    packet: {
      fileName: financePacketFileName(request),
      mimeType: 'application/zip',
      base64: packetBase64
    }
  };
}

async function submitFinanceExpense({ request, packetBuffer, financeConfig, logActivity, userId = null }) {
  if (!isApprovalDecision(request.decision)) {
    console.info(`[finance-expense] skipped ${financeExternalId(request)}: decision is not approved (${request.decision || 'Not recorded'})`);
    await logActivity(request.id, userId, 'Finance expense API skipped', `Decision is not approved: ${request.decision || 'Not recorded'}`);
    return { success: true, skipped: true, reason: 'not-approved' };
  }

  if (!financeConfig || !financeConfig.apiUrl || !financeConfig.apiSecret) {
    console.info(`[finance-expense] skipped ${financeExternalId(request)}: FINANCE_EXPENSE_API_URL or FINANCE_EXPENSE_API_SECRET is missing`);
    await logActivity(request.id, userId, 'Finance expense API skipped', 'FINANCE_EXPENSE_API_URL or FINANCE_EXPENSE_API_SECRET is not configured; finance email remains the fallback notification.');
    return { success: true, skipped: true, reason: 'missing-config' };
  }

  const payload = buildFinanceExpensePayload({
    request,
    financeConfig,
    packetBase64: packetBuffer.toString('base64')
  });
  const endpoint = `${financeConfig.apiUrl}/api/integrations/workflow/expenses`;
  console.info(`[finance-expense] posting ${payload.externalId} to ${endpoint}`);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${financeConfig.apiSecret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text().catch(() => '');
    let responseBody = responseText;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }

    if (response.status === 409 || (responseBody && typeof responseBody === 'object' && responseBody.duplicate)) {
      console.info(`[finance-expense] duplicate ${payload.externalId}: ${response.status}`);
      await logActivity(request.id, userId, 'Finance expense API duplicate', `Duplicate finance expense for ${payload.externalId}.`);
      return { success: true, duplicate: true, status: response.status, body: responseBody };
    }

    if (!response.ok) {
      const detail = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody || {});
      console.error(`[finance-expense] failed ${payload.externalId}: ${response.status} ${response.statusText} ${detail}`);
      await logActivity(request.id, userId, 'Finance expense API failed', `${response.status} ${response.statusText}: ${detail}`);
      return { success: false, status: response.status, body: responseBody };
    }

    console.info(`[finance-expense] submitted ${payload.externalId}: ${response.status}`);
    await logActivity(request.id, userId, 'Finance expense API submitted', `Submitted finance expense ${payload.externalId} for ${money(payload.amountCents / 100)}.`);
    return { success: true, submitted: true, status: response.status, body: responseBody };
  } catch (error) {
    console.error(`[finance-expense] failed ${payload.externalId}:`, error);
    await logActivity(request.id, userId, 'Finance expense API failed', error instanceof Error ? error.message : String(error));
    return { success: false, error };
  }
}

module.exports = {
  amountToCents,
  buildFinanceExpensePayload,
  financeCampus,
  financeExternalId,
  financePacketFileName,
  submitFinanceExpense,
  urgencyScore
};
