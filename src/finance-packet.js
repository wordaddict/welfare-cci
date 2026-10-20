const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { CCI_CAMPUSES } = require('./campuses');
const { getAppConfig } = require('./config');
const { money } = require('./helpers');
const { isApprovalDecision, reviewScoreSummary } = require('./request-assessment');

const MAX_EMAIL_SIZE_BYTES = 40 * 1024 * 1024;
const FINANCE_CATEGORY = 'Financial Welfare/Assistance';
const FINANCE_ITEM_TEMP_ID = 'welfare-assistance';
const MAX_FINANCE_ATTACHMENTS = 10;
const MAX_FINANCE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_FINANCE_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;
const FINANCE_ATTACHMENT_MIME_TYPES = Object.freeze({
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.pdf': ['application/pdf'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls': ['application/vnd.ms-excel', 'application/msexcel', 'application/x-msexcel'],
  '.csv': ['text/csv', 'application/csv', 'application/vnd.ms-excel'],
  '.ods': ['application/vnd.oasis.opendocument.spreadsheet']
});

class FinanceApiError extends Error {
  constructor(message, { status = null, issues = [], retryable = false, configuration = false } = {}) {
    super(message);
    this.name = 'FinanceApiError';
    this.status = status;
    this.issues = issues;
    this.retryable = retryable;
    this.configuration = configuration;
  }
}

function approvedAmountCents(request) {
  const hasApprovedAmount = request.amount_approved !== null
    && request.amount_approved !== undefined
    && request.amount_approved !== '';
  const amount = Number(hasApprovedAmount ? request.amount_approved : (request.amount_requested || 0));
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error('The approved amount must be greater than zero before sending the expense to Finance.');
  }
  return cents;
}

function financeExternalId(request) {
  return `WELFARE-${request.case_id}`;
}

function buildFinanceAttachments(attachmentFiles) {
  if (!Array.isArray(attachmentFiles) || attachmentFiles.length === 0) {
    throw new Error('At least one finance attachment is required.');
  }
  if (attachmentFiles.length > MAX_FINANCE_ATTACHMENTS) {
    throw new Error(`Finance accepts a maximum of ${MAX_FINANCE_ATTACHMENTS} attachments per expense.`);
  }

  let combinedBytes = 0;
  return attachmentFiles.map((file, index) => {
    if (!file || !Buffer.isBuffer(file.buffer)) {
      throw new Error(`Finance attachment ${index + 1} does not contain readable file bytes.`);
    }

    const fileName = path.basename(String(file.fileName || '').trim());
    const mimeType = String(file.mimeType || '').trim();
    const extension = path.extname(fileName).toLowerCase();
    const supportedMimes = FINANCE_ATTACHMENT_MIME_TYPES[extension];
    if (!fileName || !supportedMimes || !supportedMimes.includes(mimeType.toLowerCase())) {
      throw new Error(`Finance attachment "${fileName || `File ${index + 1}`}" must be a JPG, PNG, PDF, XLSX, XLS, CSV, or ODS file with a matching MIME type.`);
    }
    if (file.buffer.length > MAX_FINANCE_ATTACHMENT_BYTES) {
      throw new Error(`Finance attachment "${fileName}" exceeds the 10 MB per-file limit.`);
    }

    combinedBytes += file.buffer.length;
    if (combinedBytes > MAX_FINANCE_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error('Finance attachments exceed the 25 MB combined decoded-size limit.');
    }

    return {
      itemId: String(file.itemId || FINANCE_ITEM_TEMP_ID),
      fileName,
      mimeType,
      base64: file.buffer.toString('base64')
    };
  });
}

function buildFinanceExpensePayload({ request, attachmentFiles }) {
  if (!request || !request.case_id) throw new Error('A valid welfare request is required.');
  if (!CCI_CAMPUSES.includes(request.cci_community_name)) {
    throw new Error(`The request campus "${request.cci_community_name || 'Not provided'}" is not supported by the finance system.`);
  }

  const amountCents = approvedAmountCents(request);
  const externalId = financeExternalId(request);
  const attachments = buildFinanceAttachments(attachmentFiles);

  return {
    externalId,
    title: `Financial assistance for ${request.case_id}`,
    amountCents,
    team: 'FOLLOW_UP',
    campus: request.cci_community_name,
    description: 'Approved financial assistance request.',
    notes: 'Approved by the welfare committee.',
    category: FINANCE_CATEGORY,
    urgency: 2,
    eventDate: null,
    eventName: null,
    fullEventBudgetCents: null,
    payToExternal: true,
    payeeName: request.zelle_name || request.full_name,
    payeeZelle: request.zelle_email || request.zelle_phone || '',
    items: [{
      tempId: FINANCE_ITEM_TEMP_ID,
      description: 'Approved financial assistance',
      category: FINANCE_CATEGORY,
      quantity: 1,
      unitPriceCents: amountCents,
      amountCents
    }],
    attachments
  };
}

function financeExpenseRequestHeaders(config) {
  const bearerToken = config.apiToken || config.apiSecret;
  return {
    'Content-Type': 'application/json',
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
  };
}

function financeExpenseEndpoint(config) {
  return `${String(config.apiUrl || '').replace(/\/$/, '')}/api/integrations/workflow/expenses`;
}

function normalizeFinanceApiIssues(issues) {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => ({
    code: String(issue && issue.code ? issue.code : 'validation_error'),
    path: Array.isArray(issue && issue.path) ? issue.path.map(String) : [],
    message: String(issue && issue.message ? issue.message : 'Invalid value').slice(0, 300)
  }));
}

async function postFinanceExpensePayload(payload, financeConfig, fetchImpl = global.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), financeConfig.timeoutMs);
  let response;
  try {
    response = await fetchImpl(financeExpenseEndpoint(financeConfig), {
      method: 'POST',
      headers: financeExpenseRequestHeaders(financeConfig),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseBody = await response.text();
  let responseJson = {};
  try {
    responseJson = responseBody ? JSON.parse(responseBody) : {};
  } catch (error) {
    responseJson = {};
  }

  const duplicate = response.status === 200 && responseJson.duplicate === true;
  if (response.status === 201 || duplicate) {
    return {
      duplicate,
      expenseId: responseJson.expense && responseJson.expense.id
        ? String(responseJson.expense.id)
        : (responseJson.id ? String(responseJson.id) : null),
      externalId: String(
        responseJson.externalId
        || (responseJson.expense && responseJson.expense.externalId)
        || payload.externalId
      ),
      status: response.status
    };
  }

  if (response.status === 400) {
    const issues = normalizeFinanceApiIssues(responseJson.issues);
    const detail = issues.length
      ? issues.map(issue => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')
      : 'The Finance API rejected the expense payload.';
    throw new FinanceApiError(`Finance API validation failed (HTTP 400): ${detail}`, {
      status: 400,
      issues,
      retryable: false
    });
  }

  if (response.status === 401 || response.status === 503) {
    const guidance = response.status === 401
      ? 'Verify the Finance shared secret.'
      : 'Verify the Finance requester account and service configuration.';
    throw new FinanceApiError(
      `Finance API configuration failed (HTTP ${response.status}): ${guidance}`,
      { status: response.status, retryable: false, configuration: true }
    );
  }

  if (response.status >= 500) {
    throw new FinanceApiError(
      `Finance API temporary failure (HTTP ${response.status}). Retry the submission after the Finance service recovers.`,
      { status: response.status, retryable: true }
    );
  }

  throw new FinanceApiError(
    `Finance API rejected the request with HTTP ${response.status}.`,
    { status: response.status, retryable: false }
  );
}

function estimateBase64Size(byteLength) {
  return Math.ceil(Number(byteLength || 0) / 3) * 4;
}

function formatBytes(byteLength) {
  const bytes = Number(byteLength || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function scoreInterpretation(summary) {
  const avg = Number(summary.average || 0);
  if (!avg) return 'Awaiting reviews';
  if (avg >= 19) return 'Very strong support';
  if (avg >= 15) return 'Strong support';
  if (avg >= 11) return 'Moderate / needs discussion';
  return 'Weak / insufficient';
}

function drawFinanceSummaryPdf({ doc, request, docs = [], verifications, assignedReviewers, reviews, reviewSummary }) {
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const margin = 44;
  const contentW = pageW - margin * 2;
  const contentTop = 88;
  const contentBottom = pageH - 58;
  const red = '#e30613';
  const dark = '#0b1020';
  const muted = '#5f6b7d';
  const line = '#e6e8ef';
  const soft = '#f6f7f9';
  const maroon = '#2b071f';
  const cciLogo = path.join(__dirname, '..', 'public', 'cci-america-logo.png');
  const primaryLeader = verifications && verifications.length ? verifications[0] : null;
  const approvedAmount = request.amount_approved ? money(request.amount_approved) : (request.decision && request.decision.includes('Approval') ? money(request.amount_requested) : 'Pending');
  const interp = scoreInterpretation(reviewSummary);
  const scoreText = reviews.length ? `${reviewSummary.averageRounded}/21 (${reviewSummary.averagePercent}%)` : 'Pending';
  const supportLetter = primaryLeader && primaryLeader.support_letter_file ? 'Yes' : 'No / not uploaded';
  const applicantEvidence = (docs || []).map(d => d.original_name).filter(Boolean);
  const leaderEvidence = primaryLeader && primaryLeader.support_letter_file ? ['Pastoral support letter uploaded'] : [];
  const evidenceFiles = [...applicantEvidence, ...leaderEvidence];
  let cursorY = contentTop;

  function inlineText(value, fallback = 'Not provided') {
    const text = String(value == null ? '' : value)
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\s+/g, ' ')
      .trim();
    return text || fallback;
  }

  function narrativeText(value, fallback = 'Not provided') {
    const text = String(value == null ? '' : value)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\u2026/g, '...')
      .split('\n')
      .map(part => part.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n');
    return text || fallback;
  }

  function formatDate(value) {
    const raw = inlineText(value, 'Not provided');
    if (raw === 'Not provided') return raw;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return raw;
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(parsed);
  }

  function label(text, x, y, width, opts = {}) {
    doc.font('Helvetica-Bold')
      .fontSize(opts.size || 6.8)
      .fillColor(opts.color || muted)
      .text(inlineText(text, '').toUpperCase(), x, y, {
        width,
        characterSpacing: opts.characterSpacing == null ? 1.05 : opts.characterSpacing,
        align: opts.align || 'left',
        lineBreak: false
      });
  }

  function drawHeader() {
    if (fs.existsSync(cciLogo)) doc.image(cciLogo, margin, 25, { width: 48 });
    label('CCI America', margin + 62, 24, 190, { size: 7.1 });
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(dark)
      .text('Committee Approval Summary', margin + 62, 38, { width: 260, lineBreak: false });
    label('Case ID', pageW - margin - 174, 22, 174, { align: 'right' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(dark)
      .text(inlineText(request.case_id), pageW - margin - 210, 36, { width: 210, align: 'right', lineBreak: false });
    doc.moveTo(margin, 67).lineTo(pageW - margin, 67).strokeColor(line).lineWidth(0.8).stroke();
  }

  function newPage() {
    doc.addPage();
    drawHeader();
    cursorY = contentTop;
  }

  function ensureSpace(height) {
    if (cursorY + height > contentBottom) newPage();
  }

  function heightOf(text, width, font = 'Helvetica', size = 9, lineGap = 2) {
    doc.font(font).fontSize(size);
    return doc.heightOfString(text, { width, lineGap });
  }

  function drawSectionTitle(title, subtitle = '', minContentHeight = 78) {
    const cleanTitle = inlineText(title);
    const cleanSubtitle = subtitle ? inlineText(subtitle, '') : '';
    const titleH = heightOf(cleanTitle, contentW, 'Helvetica-Bold', 13, 0);
    const subtitleH = cleanSubtitle ? heightOf(cleanSubtitle, contentW, 'Helvetica', 8, 1) + 4 : 0;
    // Keep a section heading with at least one useful row/card of its content.
    ensureSpace(titleH + subtitleH + minContentHeight);
    doc.rect(margin, cursorY + 2, 4, titleH + subtitleH + 2).fill(red);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(dark)
      .text(cleanTitle, margin + 13, cursorY, { width: contentW - 13 });
    cursorY += titleH + 3;
    if (cleanSubtitle) {
      doc.font('Helvetica').fontSize(8).fillColor(muted)
        .text(cleanSubtitle, margin + 13, cursorY, { width: contentW - 13, lineGap: 1 });
      cursorY += subtitleH;
    }
    cursorY += 8;
  }

  function drawFactGrid(items, options = {}) {
    const filtered = items.filter(item => item && item[0]);
    const columns = options.columns || 2;
    const gap = 10;
    const colW = (contentW - gap * (columns - 1)) / columns;
    const valueSize = options.valueSize || 9.2;

    for (let index = 0; index < filtered.length; index += columns) {
      const row = filtered.slice(index, index + columns);
      const heights = row.map(([, value]) => {
        const body = inlineText(value);
        return Math.max(options.minHeight || 49, 12 + 8 + 6 + heightOf(body, colW - 24, 'Helvetica-Bold', valueSize, 1.5) + 11);
      });
      const rowH = Math.max(...heights);
      ensureSpace(rowH + 9);

      row.forEach(([fieldLabel, value], colIndex) => {
        const x = margin + colIndex * (colW + gap);
        doc.roundedRect(x, cursorY, colW, rowH, 7)
          .fillAndStroke(options.fill || soft, options.stroke || line);
        label(fieldLabel, x + 12, cursorY + 11, colW - 24, {
          size: 6.4,
          color: options.labelColor || muted
        });
        doc.font('Helvetica-Bold').fontSize(valueSize).fillColor(options.valueColor || dark)
          .text(inlineText(value), x + 12, cursorY + 26, { width: colW - 24, lineGap: 1.5 });
      });
      cursorY += rowH + 9;
    }
  }

  function fittingPrefix(text, width, maxHeight, font, size, lineGap) {
    const words = text.split(/\s+/).filter(Boolean);
    let low = 1;
    let high = words.length;
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = words.slice(0, mid).join(' ');
      if (heightOf(candidate, width, font, size, lineGap) <= maxHeight) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (!best) best = 1;
    return {
      part: words.slice(0, best).join(' '),
      rest: words.slice(best).join(' ')
    };
  }

  function drawNarrativeCard(cardLabel, value, options = {}) {
    const bodySize = options.bodySize || 9.2;
    const bodyFont = options.bold ? 'Helvetica-Bold' : 'Helvetica';
    const bodyColor = options.bodyColor || dark;
    const lineGap = options.lineGap == null ? 2.2 : options.lineGap;
    const textW = contentW - 28;
    const chromeH = 43;
    let remaining = narrativeText(value);
    let continuation = false;

    while (remaining) {
      if (contentBottom - cursorY < 92) newPage();
      const available = contentBottom - cursorY;
      const fullBodyH = heightOf(remaining, textW, bodyFont, bodySize, lineGap);
      let part = remaining;
      let rest = '';
      if (fullBodyH + chromeH > available) {
        const split = fittingPrefix(remaining, textW, Math.max(18, available - chromeH), bodyFont, bodySize, lineGap);
        part = split.part;
        rest = split.rest;
      }
      const bodyH = heightOf(part, textW, bodyFont, bodySize, lineGap);
      const cardH = chromeH + bodyH;
      doc.roundedRect(margin, cursorY, contentW, cardH, 8)
        .fillAndStroke(options.fill || '#ffffff', options.stroke || line);
      if (options.accent) doc.rect(margin, cursorY, 4, cardH).fill(options.accent);
      label(`${cardLabel}${continuation ? ' - continued' : ''}`, margin + 14, cursorY + 12, textW, {
        size: 6.5,
        color: options.labelColor || muted
      });
      doc.font(bodyFont).fontSize(bodySize).fillColor(bodyColor)
        .text(part, margin + 14, cursorY + 29, { width: textW, lineGap });
      cursorY += cardH + 9;
      remaining = rest;
      continuation = true;
      if (remaining) newPage();
    }
  }

  drawHeader();

  doc.circle(margin + 4, cursorY + 6, 4).fill(red);
  label('Confidential approval memo', margin + 16, cursorY + 1, 260, { color: '#b00010', size: 7.2 });
  cursorY += 23;

  const name = inlineText(request.full_name);
  const categoryLine = `${inlineText(request.request_category)} - Requested ${money(request.amount_requested)} - Total need ${money(request.total_amount_needed || request.amount_requested)}`;
  const nameW = 330;
  const sideW = 164;
  const nameH = heightOf(name, nameW, 'Helvetica-Bold', 22, 0);
  const categoryH = heightOf(categoryLine, nameW, 'Helvetica-Bold', 8.5, 1);
  const sideText = `Urgency: ${inlineText(request.urgency || 'Standard')}\nStatus: ${inlineText(request.status || 'New Request')}`;
  const sideH = heightOf(sideText, sideW, 'Helvetica-Bold', 8.5, 4);
  const heroH = Math.max(nameH + categoryH + 9, sideH);
  ensureSpace(heroH + 12);
  doc.font('Helvetica-Bold').fontSize(22).fillColor(dark).text(name, margin, cursorY, { width: nameW, lineGap: 0 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(muted).text(categoryLine, margin, cursorY + nameH + 5, { width: nameW, lineGap: 1 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(dark).text(sideText, pageW - margin - sideW, cursorY + 2, { width: sideW, align: 'right', lineGap: 4 });
  cursorY += heroH + 13;

  drawSectionTitle('Decision at a glance');
  drawFactGrid([
    ['Committee decision', request.decision || 'Pending'],
    ['Approved amount', approvedAmount],
    ['Amount requested', money(request.amount_requested)],
    ['Due date', formatDate(request.due_date)],
    ['Payment route available', request.direct_payment_possible || 'Not provided'],
    ['Committee review score', `${scoreText} - ${interp}`]
  ], { fill: maroon, stroke: maroon, labelColor: '#ffd2d7', valueColor: '#ffffff' });

  drawSectionTitle('Payment and implementation', 'Complete payment instructions and the committee decision record.');
  if (inlineText(request.payment_details, '')) {
    drawNarrativeCard('Payment details', request.payment_details, { accent: red });
  }
  if (inlineText(request.direct_payment_explanation, '')) {
    drawNarrativeCard('Direct payment explanation', request.direct_payment_explanation, { accent: red });
  }
  if (!inlineText(request.payment_details, '') && !inlineText(request.direct_payment_explanation, '')) {
    drawNarrativeCard('Payment details', 'No payment details provided.', { accent: red });
  }
  if (request.zelle_name || request.zelle_email || request.zelle_phone) {
    drawFactGrid([
      ['Zelle name', request.zelle_name || 'Not provided'],
      ['Zelle email', request.zelle_email || 'Not provided'],
      ['Zelle phone', request.zelle_phone || 'Not provided']
    ]);
  }
  drawNarrativeCard('Committee decision notes', request.decision_notes || 'No decision notes provided.', { accent: maroon });

  drawSectionTitle('Applicant snapshot');
  drawFactGrid([
    ['Email', request.email],
    ['Phone', request.phone],
    ['CCI community', request.cci_community_name],
    ['Connection duration', request.connection_duration],
    ['Membership', request.membership_status === 'Yes' ? 'Official member' : 'Not yet official'],
    ['Celeforce', request.worker_status === 'Yes' ? 'Worker' : 'No']
  ]);

  drawSectionTitle('Need, risk, and applicant effort', 'Narrative answers are reproduced in full for committee and finance review.');
  drawNarrativeCard('Situation', request.situation);
  drawNarrativeCard('Risk if support is not provided', request.consequence);
  drawNarrativeCard('Applicant effort', request.applicant_effort);
  drawNarrativeCard('Urgency reason', request.urgency_reason);

  drawSectionTitle('Pastoral verification');
  drawFactGrid([
    ['Pastor / leader', request.leader_name || (primaryLeader && primaryLeader.verifier_name) || 'Not provided'],
    ['Membership confirmed', primaryLeader ? primaryLeader.member_confirmed : 'Pending'],
    ['Celeforce confirmed', primaryLeader ? primaryLeader.worker_confirmed : 'Pending'],
    ['Support letter', supportLetter]
  ]);
  if (primaryLeader) {
    drawNarrativeCard('Pastoral context', primaryLeader.pastoral_context || 'No pastoral context provided.');
    if (primaryLeader.decision_comments && primaryLeader.decision_comments !== primaryLeader.pastoral_context) {
      drawNarrativeCard('Pastor comments', primaryLeader.decision_comments);
    }
  } else {
    drawNarrativeCard('Pastoral comments', 'Pastoral verification is pending.');
  }

  drawSectionTitle('Review outcome', `${reviews.length} of ${assignedReviewers.length} assigned reviewer assessments received.`);
  drawFactGrid([
    ['Average score', scoreText],
    ['Interpretation', interp],
    ['Reviews received', `${reviews.length} of ${assignedReviewers.length}`],
    ['Final committee decision', request.decision || 'Pending']
  ], { fill: '#fff4f5', stroke: '#ffc7ce', valueColor: '#8f0010' });

  if (!reviews.length) {
    drawNarrativeCard('Reviewer assessments', 'No reviewer assessments have been submitted yet.');
  } else {
    reviews.forEach((review, index) => {
      drawSectionTitle(`Reviewer ${index + 1}: ${inlineText(review.reviewer_name)}`, '', 184);
      drawFactGrid([
        ['Score', `${review.score_total || 0}/21`],
        ['Recommendation', review.recommended_decision || 'Not provided'],
        ['Recommended amount', review.recommended_amount ? money(review.recommended_amount) : 'Not provided'],
        ['System assessment agreement', review.system_assessment_agreement || 'Not provided'],
        ['Conflict of interest', review.conflict_of_interest || 'Not provided'],
        ['Submitted', formatDate(review.created_at)]
      ]);
      drawNarrativeCard('Reviewer note', review.notes || 'No reviewer note provided.', {
        fill: '#fff9fa',
        stroke: '#ffc7ce',
        accent: red,
        bodySize: 9.6
      });
      if (inlineText(review.override_reason, '')) {
        drawNarrativeCard('Override reason', review.override_reason, { accent: maroon });
      }
    });
  }

  drawSectionTitle('Evidence included with finance packet');
  drawNarrativeCard('Included files', evidenceFiles.length
    ? evidenceFiles.map((fileName, index) => `${index + 1}. ${inlineText(fileName)}`).join('\n')
    : 'No evidence uploaded.');

  const generatedDate = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date());
  const pageRange = doc.bufferedPageRange();
  for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    doc.moveTo(margin, pageH - 42).lineTo(pageW - margin, pageH - 42).strokeColor(line).lineWidth(0.7).stroke();
    doc.font('Helvetica-Bold').fontSize(6.7).fillColor(muted)
      .text('Confidential - For CCI USA Finance Team and authorized committee use only.', margin, pageH - 32, { width: 360, lineBreak: false });
    doc.font('Helvetica').fontSize(6.7).fillColor(muted)
      .text(`Generated ${generatedDate}  |  Page ${pageIndex - pageRange.start + 1} of ${pageRange.count}`, pageW - margin - 190, pageH - 32, { width: 190, align: 'right', lineBreak: false });
  }
}

function buildFinanceSummaryPdfBuffer({ request, docs = [], verifications, assignedReviewers, reviews, reviewSummary }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, bufferPages: true, autoFirstPage: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawFinanceSummaryPdf({ doc, request, docs, verifications, assignedReviewers, reviews, reviewSummary });
    doc.end();
  });
}

function createFinancePacketService({ baseUrl, getDb, logActivity, sendNotification, appendStoredFileToArchive, getStoredFileBuffer, getStoredFileByKey, fetchImpl = global.fetch }) {
  async function buildFinancePacketZipBuffer({ request, docs = [], verifications, assignedReviewers, reviews, reviewSummary }) {
    const db = await getDb();
    const pdfBuffer = await buildFinanceSummaryPdfBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary });
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks = [];
      archive.on('data', chunk => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
      archive.append(pdfBuffer, { name: `${request.case_id}-committee-approval-summary.pdf` });

      (async () => {
        for (const file of docs || []) {
          const storedFile = await getStoredFileByKey(db, file.stored_name);
          await appendStoredFileToArchive(archive, storedFile, `Applicant evidence/${file.original_name}`);
        }

        const leader = verifications && verifications.length ? verifications[0] : null;
        if (leader && leader.support_letter_file) {
          const supportLetter = await getStoredFileByKey(db, leader.support_letter_file);
          await appendStoredFileToArchive(archive, supportLetter, `Pastoral support letter/${supportLetter ? supportLetter.original_name : leader.support_letter_file}`);
        }

        await archive.finalize();
      })().catch(reject);
    });
  }

  async function buildFinanceExpenseAttachmentFiles(db, { request, docs = [], verifications = [], assignedReviewers = [], reviews = [], reviewSummary }) {
    if (typeof getStoredFileBuffer !== 'function') {
      throw new Error('The stored-file buffer reader is not configured for Finance submissions.');
    }

    const summaryBuffer = await buildFinanceSummaryPdfBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary });
    const attachmentFiles = [{
      itemId: FINANCE_ITEM_TEMP_ID,
      fileName: `WELFARE-${request.case_id}-committee-approval-summary.pdf`,
      mimeType: 'application/pdf',
      buffer: summaryBuffer
    }];
    const seenStorageKeys = new Set();

    async function appendStoredAttachment(storageKey, fallbackName, fallbackMimeType) {
      if (!storageKey || seenStorageKeys.has(storageKey)) return;
      seenStorageKeys.add(storageKey);
      const storedFile = await getStoredFileByKey(db, storageKey);
      if (!storedFile) {
        throw new Error(`Finance attachment "${fallbackName || storageKey}" could not be found in file storage.`);
      }
      const buffer = await getStoredFileBuffer(storedFile);
      if (!Buffer.isBuffer(buffer)) {
        throw new Error(`Finance attachment "${storedFile.original_name || fallbackName || storageKey}" could not be read from file storage.`);
      }
      attachmentFiles.push({
        itemId: FINANCE_ITEM_TEMP_ID,
        fileName: storedFile.original_name || fallbackName || storageKey,
        mimeType: storedFile.mime_type || fallbackMimeType || 'application/octet-stream',
        buffer
      });
    }

    for (const document of docs) {
      await appendStoredAttachment(document.stored_name, document.original_name, document.mime_type);
    }
    for (const verification of verifications) {
      if (verification.support_letter_file) {
        await appendStoredAttachment(verification.support_letter_file, verification.support_letter_file, null);
      }
    }

    return attachmentFiles;
  }

  async function getDecisionArtifacts(db, requestId) {
    const request = await db.get('SELECT * FROM requests WHERE id=?', requestId);
    const docs = await db.all('SELECT * FROM documents WHERE request_id=? ORDER BY uploaded_at ASC, id ASC', requestId);
    const verifications = await db.all('SELECT v.*, COALESCE(u.name, v.verifier_name) as verifier_name FROM leader_verifications v LEFT JOIN users u ON u.id=v.verified_by WHERE v.request_id=? ORDER BY v.created_at DESC, v.id DESC', requestId);
    const assignedReviewers = await db.all(`
      SELECT rr.*, u.name, COALESCE(u.reviewer_contact_email,u.email) as email
      FROM request_reviewers rr
      JOIN users u ON u.id = rr.reviewer_id
      WHERE rr.request_id=?
      ORDER BY rr.assigned_at ASC
    `, requestId);
    const reviews = await db.all('SELECT r.*, u.name as reviewer_name, COALESCE(u.reviewer_contact_email,u.email) as reviewer_email FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.request_id=? ORDER BY r.created_at ASC', requestId);
    return { request, docs, verifications, assignedReviewers, reviews, reviewSummary: reviewScoreSummary(reviews) };
  }

  async function emailFinanceDecisionPacket(db, req, requestId) {
    const appConfig = getAppConfig();
    const { request, docs, verifications, assignedReviewers, reviews, reviewSummary } = await getDecisionArtifacts(db, requestId);
    if (!request) return;
    const financeEmail = appConfig.jobs.financeTeamEmail;
    const financeCcEmails = appConfig.jobs.financeTeamCcEmails || [];
    const financeName = appConfig.jobs.financeTeamName;
    const approved = isApprovalDecision(request.decision);
    let token = request.finance_confirm_token;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      await db.run('UPDATE requests SET finance_confirm_token=? WHERE id=?', [token, request.id]);
      request.finance_confirm_token = token;
    }
    const packetBuffer = await buildFinancePacketZipBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary });
    const financeExpenseDelivery = approved
      ? await submitApprovedExpenseToFinanceSystem(db, req, requestId, {
          request,
          docs,
          verifications,
          assignedReviewers,
          reviews,
          reviewSummary
        })
      : { success: false, skipped: true, reason: 'Only approved requests are sent to the finance system.' };
    const estimatedEncodedSize = estimateBase64Size(packetBuffer.length);
    if (estimatedEncodedSize > MAX_EMAIL_SIZE_BYTES) {
      const reason = `Finance packet is too large to email (${formatBytes(packetBuffer.length)} raw, ~${formatBytes(estimatedEncodedSize)} after Base64 encoding).`;
      await logActivity(request.id, req.session && req.session.user ? req.session.user.id : null, 'Finance packet email failed', `${financeEmail}: ${reason}`);
      return { success: false, provider: 'attachment-check', reason, financeExpense: financeExpenseDelivery };
    }
    const amountForAction = approved ? money(request.amount_approved || request.amount_requested) : 'No payment action requested';
    const confirmLink = `${baseUrl(req)}/finance-confirm/${token}`;
    const paymentDetails = request.payment_details || request.direct_payment_explanation || 'No payment details provided.';
    const subject = `CCI America Committee Decision: ${request.case_id} - ${request.decision || 'Decision recorded'}`;
    const body = `Dear ${financeName},

The CCI America Financial Assistance Committee has completed review of the request below.

Case ID: ${request.case_id}
Applicant: ${request.full_name}
Category: ${request.request_category}
Committee recommendation/decision: ${request.decision || 'Pending'}
Amount requested: ${money(request.amount_requested)}
Amount approved / finance action: ${amountForAction}
Due date: ${request.due_date || 'Not provided'}
Urgency: ${request.urgency}

Payment route / direct payment possible: ${request.direct_payment_possible || 'Not provided'}
Payment details/instructions: ${paymentDetails}
Zelle name: ${request.zelle_name || 'N/A'}
Zelle email: ${request.zelle_email || 'N/A'}
Zelle phone: ${request.zelle_phone || 'N/A'}

Decision notes:
${request.decision_notes || 'No decision notes provided.'}

A finance submission packet is attached. It includes the committee summary, applicant evidence, and pastoral support letter if uploaded.

${approved ? `After payment is completed, please confirm payment using this secure link:
${confirmLink}

This confirmation will notify the admin so the applicant can be informed and asked to complete follow-up evidence.` : 'No payment is requested unless further instruction is provided by the committee.'}

Confidentiality: This information is for CCI USA Finance Team and authorized committee use only.

CCI America Financial Assistance Committee`;

    const delivery = await sendNotification({
      db,
      requestId: request.id,
      recipientName: financeName,
      recipientEmail: financeEmail,
      cc: financeCcEmails,
      subject,
      body,
      attachments: [{
        filename: `${request.case_id}-finance-submission-package.zip`,
        content: packetBuffer,
        contentType: 'application/zip'
      }]
    });
    if (!delivery.success) {
      await logActivity(request.id, req.session && req.session.user ? req.session.user.id : null, 'Finance packet email failed', `${financeEmail}: ${delivery.reason || 'Email delivery failed'}`);
      delivery.financeExpense = financeExpenseDelivery;
      return delivery;
    }

    if (delivery.preview) {
      await logActivity(request.id, req.session && req.session.user ? req.session.user.id : null, 'Finance packet previewed', `Previewed locally for ${financeEmail} with committee decision: ${request.decision}`);
      delivery.financeExpense = financeExpenseDelivery;
      return delivery;
    }

    await db.run('UPDATE requests SET finance_packet_sent_at=CURRENT_TIMESTAMP WHERE id=?', request.id);
    await logActivity(request.id, req.session && req.session.user ? req.session.user.id : null, 'Finance packet emailed', `Sent to ${financeEmail}${financeCcEmails.length ? `; cc ${financeCcEmails.join(', ')}` : ''} with committee decision: ${request.decision}`);
    delivery.financeExpense = financeExpenseDelivery;
    return delivery;
  }

  async function submitApprovedExpenseToFinanceSystem(db, req, requestId, prepared = null) {
    const appConfig = getAppConfig();
    const actorId = req.session && req.session.user ? req.session.user.id : null;
    const artifacts = prepared || await getDecisionArtifacts(db, requestId);
    const { request, docs, verifications, assignedReviewers, reviews, reviewSummary } = artifacts;
    if (!request) return { success: false, reason: 'Request not found.' };
    if (!isApprovalDecision(request.decision)) {
      return { success: false, skipped: true, reason: 'Only approved requests are sent to the finance system.' };
    }
    if (request.finance_expense_created_at) {
      return {
        success: true,
        alreadySubmitted: true,
        externalId: request.finance_expense_external_id || `WELFARE-${request.case_id}`
      };
    }
    if (!appConfig.financeExpense.enabled) {
      const reason = 'FINANCE_EXPENSE_API_URL and a finance API bearer secret are required.';
      await db.run(
        'UPDATE requests SET finance_expense_last_attempt_at=CURRENT_TIMESTAMP, finance_expense_error=? WHERE id=?',
        [reason, request.id]
      );
      await logActivity(request.id, actorId, 'Finance system submission not configured', reason);
      return { success: false, skipped: true, configuration: true, retryable: false, reason };
    }
    if (typeof fetchImpl !== 'function') {
      const reason = 'This Node.js runtime does not provide fetch for the finance API call.';
      await db.run(
        'UPDATE requests SET finance_expense_last_attempt_at=CURRENT_TIMESTAMP, finance_expense_error=? WHERE id=?',
        [reason, request.id]
      );
      await logActivity(request.id, actorId, 'Finance system submission failed', reason);
      return { success: false, configuration: true, retryable: false, reason };
    }

    try {
      const attachmentFiles = await buildFinanceExpenseAttachmentFiles(db, {
        request,
        docs,
        verifications,
        assignedReviewers,
        reviews,
        reviewSummary
      });
      const payload = buildFinanceExpensePayload({
        request,
        attachmentFiles
      });
      const submission = await postFinanceExpensePayload(payload, appConfig.financeExpense, fetchImpl);
      const externalId = submission.externalId;
      await db.run(
        'UPDATE requests SET finance_expense_created_at=CURRENT_TIMESTAMP, finance_expense_external_id=?, finance_expense_last_attempt_at=CURRENT_TIMESTAMP, finance_expense_error=NULL WHERE id=?',
        [String(externalId), request.id]
      );
      await logActivity(
        request.id,
        actorId,
        submission.duplicate ? 'Finance expense already exists' : 'Finance expense created',
        String(externalId)
      );
      return { success: true, ...submission };
    } catch (error) {
      const reason = error && error.name === 'AbortError'
        ? `Finance API request timed out after ${appConfig.financeExpense.timeoutMs}ms.`
        : (error instanceof Error ? error.message : String(error));
      const retryable = error && error.name === 'AbortError'
        ? true
        : (error instanceof FinanceApiError ? error.retryable : false);
      const configuration = error instanceof FinanceApiError ? error.configuration : false;
      const issues = error instanceof FinanceApiError ? error.issues : [];
      await db.run(
        'UPDATE requests SET finance_expense_last_attempt_at=CURRENT_TIMESTAMP, finance_expense_error=? WHERE id=?',
        [reason, request.id]
      );
      await logActivity(
        request.id,
        actorId,
        configuration ? 'Finance system submission configuration failed' : (retryable ? 'Finance system submission failed' : 'Finance system submission rejected'),
        reason
      );
      return {
        success: false,
        status: error instanceof FinanceApiError ? error.status : null,
        retryable,
        configuration,
        issues,
        reason
      };
    }
  }

  return {
    buildFinanceExpenseAttachmentFiles,
    buildFinancePacketZipBuffer,
    buildFinanceSummaryPdfBuffer,
    emailFinanceDecisionPacket,
    getDecisionArtifacts,
    submitApprovedExpenseToFinanceSystem
  };
}

module.exports = {
  FinanceApiError,
  buildFinanceAttachments,
  buildFinanceExpensePayload,
  createFinancePacketService,
  financeExpenseEndpoint,
  financeExpenseRequestHeaders,
  postFinanceExpensePayload
};
