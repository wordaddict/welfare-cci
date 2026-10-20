const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFinanceExpensePayload,
  financeExpenseEndpoint,
  financeExpenseRequestHeaders
} = require('../src/finance-packet');

test('finance expense payload matches the finance-system contract', () => {
  const payload = buildFinanceExpensePayload({
    request: {
      case_id: 'CASE-123',
      amount_approved: 250,
      amount_requested: 300,
      cci_community_name: 'DMV',
      full_name: 'Jane Doe',
      zelle_name: 'Jane Doe',
      zelle_email: 'jane@example.com',
      zelle_phone: '555-0100'
    },
    packetBuffer: Buffer.from('packet')
  });

  assert.deepEqual(payload, {
    externalId: 'WELFARE-CASE-123',
    title: 'Financial assistance for CASE-123',
    amountCents: 25000,
    team: 'FOLLOW_UP',
    campus: 'DMV',
    description: 'Approved financial assistance request.',
    notes: 'Approved by the welfare committee.',
    category: 'Financial Welfare/Assistance',
    urgency: 2,
    eventDate: null,
    eventName: null,
    fullEventBudgetCents: null,
    payToExternal: true,
    payeeName: 'Jane Doe',
    payeeZelle: 'jane@example.com',
    items: [{
      description: 'Approved financial assistance',
      category: 'Financial Welfare/Assistance',
      quantity: 1,
      unitPriceCents: 25000,
      amountCents: 25000
    }],
    packet: {
      fileName: 'WELFARE-CASE-123.zip',
      mimeType: 'application/zip',
      base64: 'cGFja2V0'
    }
  });
});

test('finance expense payload uses the selected campus and rejects unsupported values', () => {
  const request = {
    case_id: 'CASE-456',
    amount_approved: 100.01,
    cci_community_name: 'CCI_USA_HOUSTON',
    full_name: 'Test Applicant',
    zelle_phone: '555-0101'
  };

  const payload = buildFinanceExpensePayload({ request, packetBuffer: Buffer.from('zip') });
  assert.equal(payload.campus, 'CCI_USA_HOUSTON');
  assert.equal(payload.amountCents, 10001);
  assert.equal(payload.payeeZelle, '555-0101');

  assert.throws(
    () => buildFinanceExpensePayload({
      request: { ...request, cci_community_name: 'Typed campus' },
      packetBuffer: Buffer.from('zip')
    }),
    /not supported by the finance system/
  );

  assert.throws(
    () => buildFinanceExpensePayload({
      request: { ...request, amount_approved: 0 },
      packetBuffer: Buffer.from('zip')
    }),
    /approved amount must be greater than zero/
  );
});

test('finance API uses the established workflow endpoint and bearer authentication', () => {
  assert.deepEqual(financeExpenseRequestHeaders({
    apiSecret: 'shared-secret'
  }), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer shared-secret'
  });
  assert.equal(
    financeExpenseEndpoint({ apiUrl: 'https://finance.example.com/' }),
    'https://finance.example.com/api/integrations/workflow/expenses'
  );
});
