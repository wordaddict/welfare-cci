const { normalizeMultiValue } = require('../helpers');

const APPLICANT_REQUIRED_FIELDS = [
  'full_name',
  'email',
  'phone',
  'city_state',
  'cci_connection_type',
  'cci_community_name',
  'leader_name',
  'leader_email',
  'leader_phone',
  'connection_duration',
  'membership_status',
  'worker_status',
  'pastor_informed',
  'request_category',
  'total_amount_needed',
  'amount_requested',
  'applicant_contribution',
  'other_confirmed_support',
  'due_date',
  'situation',
  'consequence',
  'dependents_affected',
  'applicant_effort',
  'one_time_or_ongoing',
  'prior_assistance',
  'direct_payment_possible',
  'applicant_declaration',
  'consent_leader_contact',
  'consent_proof_of_use'
];

const WORKER_REQUIRED_FIELDS = [
  'worker_duration_value',
  'worker_duration_unit',
  'unit_name',
  'unit_leader_name',
  'unit_leader_email',
  'unit_leader_phone'
];

const LEADERSHIP_REQUIRED_FIELDS = [
  'verifier_name',
  'verifier_email',
  'verifier_phone',
  'worker_confirmed',
  'unit_confirmed',
  'service_duration_value',
  'service_duration_unit',
  'comments'
];

const PASTOR_REQUIRED_FIELDS = [
  'verifier_name',
  'verifier_email',
  'verifier_phone',
  'is_member',
  'is_regular_participant',
  'is_worker',
  'known_duration_value',
  'known_duration_unit',
  'decision_comments'
];

const CATEGORY_REQUIRED_FIELDS = Object.freeze({
  'Rent or Housing': ['cat_rent_due', 'cat_eviction_risk'],
  'Utilities': ['cat_utility_type', 'cat_disconnection_notice'],
  'Groceries or Food': ['cat_household_size', 'cat_food_urgent'],
  'Medical or Health-Related Support': ['cat_medical_type', 'cat_medical_urgent'],
  'Tuition or Education': ['cat_school_name', 'cat_education_purpose'],
  'Emergency Accommodation': ['cat_current_accommodation', 'cat_accommodation_timeline', 'cat_safety_concern'],
  'Special CCI Event Support': ['cat_event_name', 'cat_event_support_type', 'cat_event_support_details'],
  'Other Exceptional Need': ['cat_other_description', 'cat_other_urgency']
});

function hasValue(value) {
  if (Array.isArray(value)) return value.some(item => hasValue(item));
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function assertFieldsPresent(body, fields, errorMessage) {
  if (fields.some(field => !hasValue(body[field]))) {
    throw new Error(errorMessage);
  }
}

function validateApplicantSubmission({ body, files }) {
  assertFieldsPresent(body, APPLICANT_REQUIRED_FIELDS, 'Please complete all required fields before submitting.');

  if (!['Yes', 'No'].includes(body.membership_status)) {
    throw new Error('Please indicate whether you are an official member of CCI.');
  }

  if (!['Yes', 'No'].includes(body.worker_status)) {
    throw new Error('Please indicate whether you are a worker (Celeforce).');
  }

  if (body.membership_status === 'No') {
    if (!['Yes', 'No'].includes(body.map_group_status)) {
      throw new Error('Please indicate whether you belong to a CCI MAP group.');
    }

    if (body.map_group_status === 'Yes' && !hasValue(body.map_group_name)) {
      throw new Error('Please provide the name of your MAP group.');
    }
  }

  if (body.worker_status === 'Yes') {
    assertFieldsPresent(
      body,
      WORKER_REQUIRED_FIELDS,
      'Please complete the Celeforce service and Unit Head details required for leadership verification.'
    );
  }

  if (body.pastor_informed !== 'Yes') {
    throw new Error('Please inform your Pastor about this application before submitting it.');
  }

  const effortActions = normalizeMultiValue(body.effort_actions);
  if (effortActions.length === 0) {
    throw new Error('Please select at least one step you have taken to address the need. Select "None yet" if no step has been taken.');
  }

  if (effortActions.includes('None yet') && effortActions.length > 1) {
    throw new Error('Please select either "None yet" or the actions you have taken, not both.');
  }

  const membershipCertificate = files && files.membership_certificate ? files.membership_certificate[0] : null;
  const mapLeaderAttestation = files && files.map_leader_attestation ? files.map_leader_attestation[0] : null;
  const supportingDocuments = files && files.documents ? files.documents : [];

  if (body.membership_status === 'Yes' && !membershipCertificate) {
    throw new Error('Please upload your CCI Membership Certificate.');
  }

  if (body.membership_status === 'No' && body.map_group_status === 'Yes' && !mapLeaderAttestation) {
    throw new Error('Please upload an attestation letter from your MAP Leader.');
  }

  for (const field of CATEGORY_REQUIRED_FIELDS[body.request_category] || []) {
    if (!hasValue(body[field])) {
      throw new Error('Please complete all questions for the selected request type.');
    }
  }

  if (body.prior_assistance === 'Yes' && !hasValue(body.prior_assistance_details)) {
    throw new Error('Please provide details of previous CCI America financial assistance.');
  }

  if (body.direct_payment_possible === 'Yes' && !hasValue(body.payment_details)) {
    throw new Error('Please provide vendor/service-provider payment details or instructions.');
  }

  if (body.direct_payment_possible === 'No') {
    if (!hasValue(body.direct_payment_explanation)) {
      throw new Error('Please explain why direct vendor/service-provider payment is not possible.');
    }

    assertFieldsPresent(
      body,
      ['zelle_name', 'zelle_email', 'zelle_phone'],
      'Please provide the applicant Zelle name, email, and phone number for direct disbursement.'
    );
  }

  if (supportingDocuments.length === 0) {
    throw new Error('Please upload at least one supporting document for the financial need.');
  }

  return {
    effortActions,
    membershipCertificate,
    mapLeaderAttestation,
    supportingDocuments
  };
}

function validateLeadershipVerification(body) {
  assertFieldsPresent(
    body,
    LEADERSHIP_REQUIRED_FIELDS,
    'Please answer all required leadership verification questions before submitting.'
  );

  if (!['Yes', 'No'].includes(body.worker_confirmed) || !['Yes', 'No'].includes(body.unit_confirmed)) {
    throw new Error('Please answer the worker and unit verification questions with Yes or No.');
  }
}

function validatePastorVerification(body) {
  assertFieldsPresent(
    body,
    PASTOR_REQUIRED_FIELDS,
    'Please answer all required pastoral verification questions before submitting.'
  );

  if (!['Yes', 'No'].includes(body.is_member) || !['Yes', 'No'].includes(body.is_regular_participant) || !['Yes', 'No'].includes(body.is_worker)) {
    throw new Error('Please answer the membership, CCI participation, and worker verification questions with Yes or No.');
  }
}

module.exports = {
  validateApplicantSubmission,
  validateLeadershipVerification,
  validatePastorVerification
};
