const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const { CCI_CAMPUSES } = require('../src/campuses');
const { PASTORS } = require('../src/pastors');
const { validateApplicantSubmission } = require('../src/validators/request-flow-validator');

const applicationViewPath = path.join(__dirname, '..', 'views', 'apply.ejs');

const EXPECTED_CAMPUSES = [
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
];

function validSubmissionBody(campus = 'DMV') {
  return {
    full_name: 'Test Applicant',
    email: 'applicant@example.com',
    phone: '555-0100',
    city_state: 'Dallas, TX',
    cci_connection_type: 'Physical campus',
    cci_community_name: campus,
    leader_name: 'Dallas Pastor',
    leader_email: 'dallas.pastor@joincci.org',
    connection_duration: 'More than 1 year',
    membership_status: 'Yes',
    worker_status: 'No',
    pastor_informed: 'Yes',
    request_category: 'Other Exceptional Need',
    cat_other_description: 'Unexpected essential expense',
    cat_other_urgency: 'Urgent',
    total_amount_needed: '250',
    amount_requested: '250',
    applicant_contribution: '0',
    other_confirmed_support: '0',
    due_date: '2026-10-31',
    situation: 'Test situation',
    consequence: 'Test consequence',
    dependents_affected: 'No',
    applicant_effort: 'Asked for help',
    effort_actions: 'Contacted provider/landlord/school',
    one_time_or_ongoing: 'One-time',
    prior_assistance: 'No',
    direct_payment_possible: 'No',
    direct_payment_explanation: 'Direct payment is not available.',
    zelle_name: 'Test Applicant',
    zelle_email: 'applicant@example.com',
    zelle_phone: '555-0100',
    applicant_declaration: '1',
    consent_leader_contact: '1',
    consent_proof_of_use: '1'
  };
}

const submissionFiles = {
  membership_certificate: [{ originalname: 'membership.pdf' }],
  documents: [{ originalname: 'evidence.pdf' }]
};

test('campus options exactly match the finance-system identifiers', () => {
  assert.deepEqual([...CCI_CAMPUSES], EXPECTED_CAMPUSES);
});

test('application renders campus as a controlled select list', async () => {
  const html = await ejs.renderFile(applicationViewPath, {
    title: 'Financial Assistance Request',
    error: null,
    campuses: CCI_CAMPUSES,
    pastors: PASTORS,
    user: { role: 'applicant' }
  });

  assert.match(html, /<select name="cci_community_name" required>/);
  assert.doesNotMatch(html, /<input name="cci_community_name"/);
  for (const campus of EXPECTED_CAMPUSES) {
    assert.match(html, new RegExp(`<option value="${campus}">${campus}<\\/option>`));
  }
});

test('applicant validation accepts a listed campus and rejects free text', () => {
  assert.doesNotThrow(() => validateApplicantSubmission({
    body: validSubmissionBody('CCI_USA_HOUSTON'),
    files: submissionFiles
  }));

  assert.throws(
    () => validateApplicantSubmission({
      body: validSubmissionBody('Houston'),
      files: submissionFiles
    }),
    /select a campus from the approved list/
  );
});
