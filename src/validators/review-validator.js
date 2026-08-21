const REVIEW_RATING_FIELDS = Object.freeze([
  'urgency_rating',
  'severity_rating',
  'gap_rating',
  'effort_rating',
  'history_rating',
  'policy_rating',
  'documentation_rating'
]);

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function validateReviewSubmission(body, systemAssessment) {
  for (const field of REVIEW_RATING_FIELDS) {
    const score = Number(body[field]);
    if (![1, 2, 3].includes(score)) {
      throw new Error('Please provide a 1-3 rating for each review criterion.');
    }
  }

  if (!['Yes', 'Partially', 'No'].includes(body.system_assessment_agreement)) {
    throw new Error('Please indicate whether you agree with the system-generated preliminary assessment.');
  }

  const systemRatings = Object.values((systemAssessment && systemAssessment.ratings) || {});
  const changedRatings = REVIEW_RATING_FIELDS.filter(field => {
    const systemItem = systemRatings.find(item => item.field === field);
    return systemItem && Number(body[field]) !== Number(systemItem.score);
  });

  if ((body.system_assessment_agreement !== 'Yes' || changedRatings.length > 0) && !hasValue(body.override_reason)) {
    throw new Error('Please briefly explain any disagreement with, or change to, the system-generated assessment.');
  }
}

module.exports = {
  REVIEW_RATING_FIELDS,
  validateReviewSubmission
};
