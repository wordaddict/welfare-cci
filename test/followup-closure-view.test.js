const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const partialPath = path.join(__dirname, '..', 'views', 'partials_followup_closure.ejs');
const requestDetailPath = path.join(__dirname, '..', 'views', 'request-detail.ejs');

function renderFollowupClosure(overrides = {}) {
  return ejs.renderFile(partialPath, {
    request: {
      id: 42,
      status: 'Closed',
      payment_confirmed_at: '2026-10-01T12:00:00Z',
      applicant_followup_requested_at: '2026-10-04T12:00:00Z'
    },
    applicantFollowup: {
      funds_used_as_intended: 'Yes',
      issue_resolved: 'Partly',
      receipt_received: 'Yes',
      notes: 'I paid part of the bill.',
      receipt_file: 'receipt-key.pdf',
      created_at: '2026-10-06T20:18:00Z'
    },
    closureFollowup: {
      pastoral_followup_needed: 'Yes',
      notes: 'Pastor will check in next week.',
      completed_by_name: 'Admin Example',
      created_at: '2026-10-07T14:00:00Z'
    },
    ...overrides
  });
}

test('closed state renders the applicant response and administrative closure record', async () => {
  const html = await renderFollowupClosure();

  assert.match(html, /Follow-up completed and case closed/);
  assert.match(html, /Applicant close-out/);
  assert.match(html, /I paid part of the bill\./);
  assert.match(html, /href="\/uploads\/receipt-key\.pdf"/);
  assert.match(html, /Administrative closure/);
  assert.match(html, /Pastor will check in next week\./);
  assert.match(html, /Admin Example/);
  assert.match(html, /Pastoral follow-up was marked as needed/);
});

test('closed legacy case clearly reports missing closure records', async () => {
  const html = await renderFollowupClosure({ applicantFollowup: null, closureFollowup: null });

  assert.match(html, /No applicant close-out is attached/);
  assert.match(html, /No administrative closure details were recorded/);
});

test('submitted state keeps the admin close-out form available', async () => {
  const html = await renderFollowupClosure({
    request: {
      id: 42,
      status: 'Follow-Up Submitted',
      payment_confirmed_at: '2026-10-01T12:00:00Z',
      applicant_followup_requested_at: '2026-10-04T12:00:00Z'
    },
    closureFollowup: null
  });

  assert.match(html, /Admin review needed/);
  assert.match(html, /Review applicant response/);
  assert.match(html, /Complete final closure/);
  assert.match(html, /action="\/requests\/42\/followup"/);
  assert.match(html, /Complete Follow-Up and Close Case/);
  assert.match(html, /Received Oct 6, 2026/);
});

test('follow-up dates render safely without a parent template helper', async () => {
  const html = await renderFollowupClosure({
    request: {
      id: 42,
      status: 'Follow-Up Submitted',
      payment_confirmed_at: '2026-10-01T12:00:00Z',
      applicant_followup_requested_at: '2026-10-04T12:00:00Z'
    },
    applicantFollowup: {
      funds_used_as_intended: 'Yes',
      issue_resolved: 'Yes',
      receipt_received: 'No',
      notes: '',
      receipt_file: null,
      created_at: 'not-a-date'
    },
    closureFollowup: null
  });

  assert.match(html, /Received not-a-date/);
  assert.doesNotMatch(html, /formatDateTime is not defined/);
});

test('request details renders the submitted close-out workflow without implicit view locals', async () => {
  const html = await ejs.renderFile(requestDetailPath, {
    title: 'CCI-FIN-TEST-001',
    user: { role: 'admin', name: 'Test Admin' },
    request: {
      id: 42,
      case_id: 'CCI-FIN-TEST-001',
      full_name: 'Test Applicant',
      email: 'test@example.com',
      request_category: 'Housing',
      amount_requested: 500,
      urgency: 'Standard',
      status: 'Follow-Up Submitted',
      created_at: '2026-10-01T12:00:00Z',
      worker_status: 'No',
      leader_verified: 'Complete',
      payment_confirmed_at: '2026-10-03T12:00:00Z',
      applicant_followup_requested_at: '2026-10-04T12:00:00Z'
    },
    docs: [],
    users: [],
    assignedReviewers: [],
    reviews: [],
    verifications: [],
    leadershipVerifications: [],
    logs: [],
    applicantFollowup: {
      created_at: '2026-10-06T20:18:00Z',
      funds_used_as_intended: 'Yes',
      issue_resolved: 'Yes',
      receipt_received: 'No',
      notes: 'Test close-out response.',
      receipt_file: null
    },
    closureFollowup: null,
    financeNotification: null,
    financePacketState: 'not-sent',
    financeTeamEmail: 'finance@example.com',
    reviewerAutoAssignEnabled: false,
    flash: {},
    reviewSummary: { averageRounded: 0, averagePercent: 0 },
    categoryDetails: {},
    money: (value) => `$${Number(value || 0).toFixed(2)}`
  });

  assert.match(html, /CCI-FIN-TEST-001/);
  assert.match(html, /Test close-out response\./);
  assert.match(html, /Complete Follow-Up and Close Case/);
  assert.doesNotMatch(html, /is not defined/);
});
