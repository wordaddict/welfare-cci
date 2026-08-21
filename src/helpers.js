function money(value) {
  if (value === null || value === undefined || value === '') return '';
  return Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function escapeCsv(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function normalizeMultiValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(v => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) return res.status(403).render('error', { title: 'Access denied', message: 'You do not have permission to view this page.', user: req.session.user });
    next();
  };
}

function parseCategoryDetails(body) {
  const category = body.request_category;
  const details = {};
  for (const [k, v] of Object.entries(body)) {
    if (k.startsWith('cat_')) details[k.replace('cat_', '')] = v;
  }
  details.category = category;
  return JSON.stringify(details, null, 2);
}

function calculateUrgencyResult(dueDate, categoryDetails, category, consequence = '', situation = '') {
  let details = categoryDetails || {};
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch (e) { details = {}; }
  }

  const reasons = [];
  const text = `${category || ''} ${situation || ''} ${consequence || ''} ${JSON.stringify(details || {})}`.toLowerCase();

  const yes = (value) => String(value || '').trim().toLowerCase() === 'yes';
  const hasAny = (...words) => words.some(word => text.includes(word));

  const riskFlags = [];
  if (yes(details.eviction_risk) || hasAny('eviction notice', 'evicted', 'lockout', 'loss of housing')) {
    riskFlags.push('housing loss/eviction risk');
  }
  if (yes(details.disconnection_notice) || hasAny('disconnection notice', 'disconnect', 'shut off', 'cut off')) {
    riskFlags.push('utility disconnection risk');
  }
  if (yes(details.food_urgent) || hasAny('no food', 'food urgent', 'urgent food', 'food insecurity')) {
    riskFlags.push('urgent food need');
  }
  if (yes(details.medical_urgent) || hasAny('urgent medical', 'medicine', 'prescription', 'treatment', 'hospital')) {
    riskFlags.push('urgent medical/prescription need');
  }
  if (yes(details.safety_concern) || hasAny('safety concern', 'unsafe', 'domestic violence', 'danger')) {
    riskFlags.push('safety concern');
  }

  let daysUntilDue = null;
  if (dueDate) {
    const due = new Date(`${dueDate}T00:00:00`);
    const now = new Date();
    daysUntilDue = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
    if (!Number.isNaN(daysUntilDue)) {
      if (daysUntilDue < 0) reasons.push('Payment due date has passed.');
      else if (daysUntilDue === 0) reasons.push('Payment is due today.');
      else reasons.push(`Payment due date is in approximately ${daysUntilDue} day(s).`);
    } else {
      daysUntilDue = null;
    }
  }

  const immediateText = hasAny('today', 'within 24 hours', 'immediately', 'emergency', 'same day', 'right now');
  if (riskFlags.length) reasons.push(`Applicant indicated: ${riskFlags.join(', ')}.`);
  if (immediateText) reasons.push('Applicant described the situation as immediate/emergency-level.');

  let urgency = 'Standard';

  // Structured triage rule:
  // Emergency should mean action is needed now, normally within 24–72 hours.
  // A risk flag alone is not enough to make a case Emergency if the due date is far away.
  const dueNow = daysUntilDue !== null && daysUntilDue <= 3;
  const dueSoon = daysUntilDue !== null && daysUntilDue <= 14;
  const safety = riskFlags.includes('safety concern');
  const hasRisk = riskFlags.length > 0;

  if (safety || immediateText || dueNow) {
    urgency = 'Emergency';
    if (dueNow) reasons.push('Classified as Emergency because the due date is within 3 days.');
    if (safety) reasons.push('Classified as Emergency because a safety concern was indicated.');
    if (immediateText) reasons.push('Classified as Emergency because immediate/emergency language was used.');
  } else if (dueSoon || hasRisk || ['Medical or Health-Related Support', 'Emergency Accommodation'].includes(category)) {
    urgency = 'Urgent';
    if (dueSoon) reasons.push('Classified as Urgent because the due date is within 14 days.');
    if (hasRisk && !dueSoon) reasons.push('Classified as Urgent, not Emergency, because a risk was indicated but the due date is more than 14 days away or not immediate.');
  } else {
    urgency = 'Standard';
    reasons.push('Classified as Standard because no immediate emergency indicator or near deadline was identified.');
  }

  if (!reasons.length) reasons.push('No emergency indicator was selected; review under standard committee timeline unless evidence suggests otherwise.');

  return { urgency, reason: reasons.join(' ') };
}

function calculateUrgency(dueDate, categoryDetails, category, consequence = '', situation = '') {
  return calculateUrgencyResult(dueDate, categoryDetails, category, consequence, situation).urgency;
}

async function generateCaseId(db) {
  const year = new Date().getFullYear();
  const pattern = `CCI-FIN-${year}-%`;

  await db.get(`
    INSERT INTO case_sequences (case_year, last_value)
    SELECT ?, COALESCE(MAX(CAST(split_part(case_id, '-', 4) AS INTEGER)), 0)
    FROM requests
    WHERE case_id LIKE ?
    ON CONFLICT (case_year) DO NOTHING
    RETURNING last_value
  `, [year, pattern]);

  const row = await db.get(
    'UPDATE case_sequences SET last_value = last_value + 1, updated_at=CURRENT_TIMESTAMP WHERE case_year=? RETURNING last_value',
    year
  );

  return `CCI-FIN-${year}-${String(row.last_value || 1).padStart(3, '0')}`;
}

module.exports = { money, escapeCsv, normalizeMultiValue, requireAuth, requireRole, parseCategoryDetails, calculateUrgency, calculateUrgencyResult, generateCaseId };
