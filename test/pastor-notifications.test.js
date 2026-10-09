const test = require('node:test');
const assert = require('node:assert/strict');
const { money } = require('../src/helpers');
const { createPastorNotificationService } = require('../src/pastor-notifications');

function buildHarness(verification) {
  const notifications = [];
  const activities = [];
  const service = createPastorNotificationService({
    money,
    sendNotification: async (notification) => {
      notifications.push(notification);
      return { success: true };
    },
    logActivity: async (...activity) => activities.push(activity)
  });
  const db = { get: async () => verification };
  return { activities, db, notifications, service };
}

const baseRequest = {
  id: 42,
  case_id: 'CCI-2026-0042',
  full_name: 'Applicant Example',
  leader_name: 'Pastor On Application',
  leader_email: 'application-pastor@example.org',
  decision: 'Partial Approval',
  amount_requested: 1500,
  amount_approved: 1000
};

test('decision notice goes to the pastor who submitted verification', async () => {
  const harness = buildHarness({
    verified_by: null,
    verifier_name: 'Pastor Verifier',
    verifier_email: 'verifying-pastor@example.org'
  });

  await harness.service.sendPastorDecisionNotice(harness.db, baseRequest, 7);

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].recipientEmail, 'verifying-pastor@example.org');
  assert.match(harness.notifications[0].body, /Amount approved by the committee: \$1,000\.00/);
  assert.equal(harness.activities[0][2], 'Verifying pastor notified of committee decision');
});

test('manual verification falls back to the pastor selected on the application', async () => {
  const harness = buildHarness({
    verified_by: 7,
    verifier_name: 'Admin User',
    verifier_email: 'admin@example.org'
  });

  await harness.service.sendPastorDecisionNotice(harness.db, baseRequest, 7);

  assert.equal(harness.notifications[0].recipientEmail, 'application-pastor@example.org');
  assert.equal(harness.notifications[0].recipientName, 'Pastor On Application');
});

test('payment notice shows and explains different approved and paid amounts', async () => {
  const harness = buildHarness({
    verified_by: null,
    verifier_name: 'Pastor Verifier',
    verifier_email: 'verifying-pastor@example.org'
  });
  const request = { ...baseRequest, payment_confirmation_amount: 900 };

  await harness.service.sendPastorPaymentNotice(harness.db, request);

  const body = harness.notifications[0].body;
  assert.match(body, /Amount approved by the committee: \$1,000\.00/);
  assert.match(body, /Amount paid by the church: \$900\.00/);
  assert.match(body, /The amounts are different/);
});

test('payment notice confirms when approved and paid amounts match', async () => {
  const harness = buildHarness({
    verified_by: null,
    verifier_name: 'Pastor Verifier',
    verifier_email: 'verifying-pastor@example.org'
  });
  const request = { ...baseRequest, payment_confirmation_amount: 1000 };

  await harness.service.sendPastorPaymentNotice(harness.db, request);

  assert.match(harness.notifications[0].body, /matches the amount approved/);
});
