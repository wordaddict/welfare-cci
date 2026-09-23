const assert = require('node:assert/strict');
const test = require('node:test');

const { buildFinanceExpenseConfig } = require('../src/config');
const {
  amountToCents,
  buildFinanceExpensePayload,
  financeCampus,
  financePacketFileName,
  urgencyScore
} = require('../src/finance-expense-integration');

test('finance expense config enables only when API URL and secret are configured', () => {
  const disabled = buildFinanceExpenseConfig({
    FINANCE_EXPENSE_API_URL: undefined,
    FINANCE_EXPENSE_API_SECRET: undefined,
    FINANCE_EXPENSE_DEFAULT_TEAM: 'ADMINISTRATION',
    FINANCE_EXPENSE_DEFAULT_CAMPUS: 'DMV'
  });

  assert.equal(disabled.enabled, false);
  assert.equal(disabled.defaultTeam, 'ADMINISTRATION');
  assert.equal(disabled.defaultCampus, 'DMV');

  const enabled = buildFinanceExpenseConfig({
    FINANCE_EXPENSE_API_URL: 'https://finance.example.com/',
    FINANCE_EXPENSE_API_SECRET: 'secret',
    FINANCE_EXPENSE_DEFAULT_TEAM: 'ADMINISTRATION',
    FINANCE_EXPENSE_DEFAULT_CAMPUS: 'DMV'
  });

  assert.equal(enabled.enabled, true);
  assert.equal(enabled.apiUrl, 'https://finance.example.com');
  assert.equal(enabled.apiSecret, 'secret');
});

test('finance expense payload matches approved welfare request contract', () => {
  const request = {
    id: 42,
    case_id: 'CCI-2026-0007',
    full_name: 'Ada Applicant',
    request_category: 'Rent or Housing',
    amount_requested: 700,
    amount_approved: 650.25,
    decision: 'Partial Approval',
    decision_notes: 'Approved for urgent rent support.',
    urgency: 'Emergency',
    direct_payment_possible: 'No',
    direct_payment_explanation: 'Send support by Zelle.',
    zelle_name: 'Ada Zelle',
    zelle_email: 'ada@example.com',
    zelle_phone: '+15551234567',
    cci_community_name: 'CCI Columbus'
  };

  const payload = buildFinanceExpensePayload({
    request,
    financeConfig: {
      defaultTeam: 'ADMINISTRATION',
      defaultCampus: 'DMV'
    },
    packetBase64: 'UEsDBAo='
  });

  assert.equal(payload.externalSource, 'welfare-workflow');
  assert.equal(payload.externalId, 'CCI-2026-0007');
  assert.equal(payload.title, 'Financial assistance approved for CCI-2026-0007');
  assert.equal(payload.amountCents, 65025);
  assert.equal(payload.team, 'ADMINISTRATION');
  assert.equal(payload.campus, 'DMV');
  assert.equal(payload.category, 'Financial Welfare/Assistance');
  assert.equal(payload.urgency, 3);
  assert.equal(payload.payToExternal, true);
  assert.equal(payload.payeeName, 'Ada Zelle');
  assert.equal(payload.payeeZelle, 'ada@example.com / +15551234567');
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].quantity, 1);
  assert.equal(payload.items[0].unitPriceCents, 65025);
  assert.equal(payload.items[0].amountCents, 65025);
  assert.deepEqual(payload.packet, {
    fileName: 'CCI-2026-0007-finance-submission-package.zip',
    mimeType: 'application/zip',
    base64: 'UEsDBAo='
  });
  assert.match(payload.description, /Case ID: CCI-2026-0007/);
  assert.match(payload.description, /Applicant: Ada Applicant/);
  assert.match(payload.description, /Decision notes: Approved for urgent rent support\./);
});

test('finance expense payload falls back to request id, requested amount, default campus, and full name', () => {
  const request = {
    id: 99,
    full_name: 'Fallback Applicant',
    amount_requested: '123.45',
    decision: 'Full Approval',
    urgency: 'Standard'
  };

  const payload = buildFinanceExpensePayload({
    request,
    financeConfig: {
      defaultTeam: 'ADMINISTRATION',
      defaultCampus: 'DMV'
    },
    packetBase64: 'zip'
  });

  assert.equal(amountToCents('123.45'), 12345);
  assert.equal(urgencyScore('Urgent'), 2);
  assert.equal(financeCampus({ campus: 'DALLAS', cci_community_name: 'CCI Columbus' }, { defaultCampus: 'DMV' }), 'DALLAS');
  assert.equal(financeCampus({ campus: 'CCI Columbus' }, { defaultCampus: 'DMV' }), 'DMV');
  assert.equal(urgencyScore('Standard'), 1);
  assert.equal(financePacketFileName(request), '99-finance-submission-package.zip');
  assert.equal(payload.externalId, '99');
  assert.equal(payload.amountCents, 12345);
  assert.equal(payload.campus, 'DMV');
  assert.equal(payload.payeeName, 'Fallback Applicant');
});
