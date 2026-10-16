const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const partialPath = path.join(__dirname, '..', 'views', 'partials_followup_closure.ejs');

function formatDateTime(value) {
  return new Date(value).toISOString();
}

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
    formatDateTime,
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
});
