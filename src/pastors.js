const PASTORS = Object.freeze([
  { branch: 'DMV', name: 'DMV Pastor', email: 'dmv.pastor@joincci.org' },
  { branch: 'Dallas', name: 'Dallas Pastor', email: 'dallas.pastor@joincci.org' },
  { branch: 'Boston', name: 'Boston Pastor', email: 'boston.pastor@joincci.org' },
  { branch: 'Austin', name: 'Austin Pastor', email: 'austin.pastor@joincci.org' }
]);

function normalizePastorEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getPastorByEmail(email) {
  const normalizedEmail = normalizePastorEmail(email);
  return PASTORS.find(pastor => pastor.email === normalizedEmail) || null;
}

module.exports = {
  PASTORS,
  getPastorByEmail,
  normalizePastorEmail
};
