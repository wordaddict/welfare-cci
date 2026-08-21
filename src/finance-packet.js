const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { money } = require('./helpers');
const { isApprovalDecision, reviewScoreSummary } = require('./request-assessment');

function briefText(value, limit = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Not provided';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trim()}…` : text;
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
  const margin = 36;
  const red = '#e30613';
  const dark = '#0b1020';
  const muted = '#5f6b7d';
  const line = '#e6e8ef';
  const soft = '#f6f7f9';
  const maroon = '#2b071f';
  const cciLogo = path.join(__dirname, '..', 'public', 'cci-america-logo.png');
  const tmakLogo = path.join(__dirname, '..', 'public', 'tmak-logo.jpg');
  const primaryLeader = verifications && verifications.length ? verifications[0] : null;
  const approvedAmount = request.amount_approved ? money(request.amount_approved) : (request.decision && request.decision.includes('Approval') ? money(request.amount_requested) : 'Pending');
  const interp = scoreInterpretation(reviewSummary);
  const scoreText = reviews.length ? `${reviewSummary.averageRounded}/21 (${reviewSummary.averagePercent}%)` : 'Pending';
  const supportLetter = primaryLeader && primaryLeader.support_letter_file ? 'Yes' : 'No / not uploaded';
  const applicantEvidence = (docs || []).map(d => d.original_name).filter(Boolean);
  const leaderEvidence = primaryLeader && primaryLeader.support_letter_file ? ['Pastoral support letter uploaded'] : [];
  const evidenceSummary = [...applicantEvidence, ...leaderEvidence].length
    ? [...applicantEvidence, ...leaderEvidence].join('; ')
    : 'No evidence uploaded';

  function label(text, x, y, opts = {}) {
    doc.font('Helvetica-Bold').fontSize(opts.size || 6.8).fillColor(opts.color || muted).text(String(text || '').toUpperCase(), x, y, opts.text || { characterSpacing: 1.2 });
  }

  function value(text, x, y, opts = {}) {
    doc.font(opts.bold === false ? 'Helvetica' : 'Helvetica-Bold').fontSize(opts.size || 9).fillColor(opts.color || dark).text(String(text || 'Not provided'), x, y, opts.text || {});
  }

  function pill(text, x, y, w, fill, stroke, color) {
    doc.roundedRect(x, y, w, 20, 10).fillAndStroke(fill, stroke);
    doc.font('Helvetica-Bold').fontSize(7.4).fillColor(color).text(text, x, y + 6, { width: w, align: 'center' });
  }

  function panel(x, y, w, h, title) {
    doc.roundedRect(x, y, w, h, 9).strokeColor(line).lineWidth(0.7).stroke();
    if (title) doc.font('Helvetica-Bold').fontSize(9.2).fillColor(dark).text(title, x + 10, y + 9, { width: w - 20 });
  }

  function smallBox(x, y, w, h, lab, val) {
    doc.roundedRect(x, y, w, h, 6).fill(soft);
    label(lab, x + 8, y + 7);
    value(briefText(val, 42), x + 8, y + 19, { size: 8, text: { width: w - 16 } });
  }

  if (fs.existsSync(cciLogo)) doc.image(cciLogo, margin, 22, { width: 24 });
  label('CCI America', margin + 42, 21, { size: 7 });
  value('Committee Approval Summary', margin + 42, 34, { size: 12 });
  label('Case ID', pageW - 185, 20, { text: { width: 150, align: 'right' } });
  value(request.case_id, pageW - 185, 34, { size: 12, text: { width: 150, align: 'right' } });
  doc.font('Helvetica-Bold').fontSize(7.2).fillColor(muted).text(`Generated ${new Date().toLocaleDateString()}`, pageW - 185, 51, { width: 150, align: 'right' });
  doc.moveTo(margin, 72).lineTo(pageW - margin, 72).strokeColor(line).lineWidth(0.8).stroke();

  doc.circle(margin + 3, 96, 4).fill(red);
  label('Confidential approval memo', margin + 13, 91, { color: '#b00010', size: 7.6 });
  value(briefText(request.full_name, 30), margin, 111, { size: 26 });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(muted).text(`${request.request_category} · Requested ${money(request.amount_requested)} · Total need ${money(request.total_amount_needed || request.amount_requested)}`, margin, 142, { width: 390 });
  pill(request.urgency || 'Standard', pageW - 160, 91, 70, request.urgency === 'Emergency' ? '#fff0f1' : '#f3f4f6', '#ffb6bd', '#b00010');
  pill(request.status || 'New Request', pageW - 82, 91, 58, '#f4f5f7', '#d8dde6', dark);

  const barY = 166;
  doc.roundedRect(margin, barY, pageW - margin * 2, 46, 9).fill(maroon);
  const colW = (pageW - margin * 2) / 4;
  const items = [
    ['Committee decision', request.decision || 'Pending'],
    ['Approved amount', approvedAmount],
    ['Payment route', request.direct_payment_possible || 'Not provided'],
    ['Due date', request.due_date || 'Not provided']
  ];
  items.forEach(([lab, val], index) => {
    const x = margin + index * colW;
    if (index) doc.moveTo(x, barY).lineTo(x, barY + 46).strokeColor('#58344b').lineWidth(0.5).stroke();
    label(lab, x + 9, barY + 10, { color: '#ffd2d7', size: 6.2 });
    value(briefText(val, 25), x + 9, barY + 25, { color: 'white', size: 10 });
  });

  panel(margin, 224, pageW - margin * 2, 54, 'Payment / implementation instruction');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text('Payment details:', margin + 10, 244, { continued: true });
  doc.font('Helvetica').fillColor(dark).text(` ${briefText(request.direct_payment_possible === 'Yes' ? request.payment_details : `${request.direct_payment_explanation || ''} Zelle: ${request.zelle_name || 'N/A'} / ${request.zelle_email || 'N/A'} / ${request.zelle_phone || 'N/A'}`, 120)}`);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text('Decision notes:', margin + 10, 259, { continued: true });
  doc.font('Helvetica').fillColor(dark).text(` ${briefText(request.decision_notes, 100)}`);

  const gap = 10;
  const half = (pageW - margin * 2 - gap) / 2;
  let y = 290;
  panel(margin, y, half, 88, 'Applicant snapshot');
  smallBox(margin + 10, y + 28, (half - 30) / 2, 25, 'Email', request.email);
  smallBox(margin + 20 + (half - 30) / 2, y + 28, (half - 30) / 2, 25, 'Phone', request.phone);
  smallBox(margin + 10, y + 58, (half - 30) / 2, 25, 'Community', request.cci_community_name);
  smallBox(margin + 20 + (half - 30) / 2, y + 58, (half - 30) / 2, 25, 'CCI connection', `${request.connection_duration} · Membership: ${request.membership_status === 'Yes' ? 'Official member' : 'Not yet official'} · Celeforce: ${request.worker_status === 'Yes' ? 'Worker' : 'No'}`);

  panel(margin + half + gap, y, half, 88, 'Need and risk');
  doc.font('Helvetica-Bold').fontSize(7.8).fillColor(dark).text('Situation:', margin + half + gap + 10, y + 28, { continued: true });
  doc.font('Helvetica').text(` ${briefText(request.situation, 65)}`);
  doc.font('Helvetica-Bold').fontSize(7.8).text('Risk if not supported:', margin + half + gap + 10, y + 45, { continued: true });
  doc.font('Helvetica').text(` ${briefText(request.consequence, 65)}`);
  doc.font('Helvetica-Bold').fontSize(7.8).text('Applicant effort:', margin + half + gap + 10, y + 62, { continued: true });
  doc.font('Helvetica').text(` ${briefText(request.applicant_effort, 65)}`);

  y = 390;
  panel(margin, y, half, 92, 'Pastoral verification');
  smallBox(margin + 10, y + 28, (half - 30) / 2, 25, 'Pastor', `${request.leader_name} · Pastor`);
  smallBox(margin + 20 + (half - 30) / 2, y + 28, (half - 30) / 2, 25, 'Membership / Celeforce', primaryLeader ? `${primaryLeader.member_confirmed || 'N/A'} / ${primaryLeader.worker_confirmed || 'N/A'}` : 'Pending');
  smallBox(margin + 10, y + 58, (half - 30) / 2, 25, 'Support letter', supportLetter);
  doc.font('Helvetica-Bold').fontSize(7.6).fillColor(dark).text('Pastor comments:', margin + 20 + (half - 30) / 2, y + 59, { continued: true });
  doc.font('Helvetica').fillColor(dark).text(` ${primaryLeader ? briefText(primaryLeader.decision_comments || primaryLeader.pastoral_context, 28) : 'Pending'}`, { width: (half - 30) / 2 });

  panel(margin + half + gap, y, half, 92, 'Review outcome');
  doc.roundedRect(margin + half + gap + 10, y + 28, half - 20, 28, 6).fillAndStroke('#fff4f5', '#ffc7ce');
  doc.rect(margin + half + gap + 10, y + 28, 3, 28).fill(red);
  value(scoreText, margin + half + gap + 20, y + 35, { size: 12 });
  value(interp, margin + half + gap + half - 100, y + 37, { size: 8, color: '#b00010', text: { width: 78, align: 'right' } });
  doc.font('Helvetica-Bold').fontSize(7.8).fillColor(dark).text('Urgency reason:', margin + half + gap + 10, y + 63, { continued: true });
  doc.font('Helvetica').fillColor(dark).text(` ${briefText(request.urgency_reason, 50)}`);
  doc.font('Helvetica-Bold').fontSize(7.8).text('Reviews received:', margin + half + gap + 10, y + 78, { continued: true });
  doc.font('Helvetica').text(` ${reviews.length} of ${assignedReviewers.length} assigned`);

  y = 494;
  panel(margin, y, pageW - margin * 2, 107, 'Reviewer recommendation summary');
  const tx = margin + 10;
  const ty = y + 34;
  const widths = [130, 60, 112, 74, 160];
  const heads = ['Reviewer', 'Score', 'Recommendation', 'Amount', 'Key note'];
  let x = tx;
  heads.forEach((heading, index) => {
    label(heading, x, ty, { size: 6.2 });
    x += widths[index];
  });
  doc.moveTo(tx, ty + 14).lineTo(pageW - margin - 10, ty + 14).strokeColor(line).lineWidth(0.7).stroke();
  const rows = reviews.slice(0, 4);
  if (!rows.length) {
    value('No reviewer assessments submitted yet.', tx, ty + 26, { bold: false, size: 8.2 });
  } else {
    rows.forEach((review, index) => {
      const yy = ty + 25 + index * 18;
      x = tx;
      const vals = [review.reviewer_name, `${review.score_total || 0}/21`, review.recommended_decision, money(review.recommended_amount), briefText(review.notes, 28)];
      vals.forEach((val, innerIndex) => {
        value(val, x, yy, { size: 7.7, text: { width: widths[innerIndex] - 6 } });
        x += widths[innerIndex];
      });
      if (index < rows.length - 1) doc.moveTo(tx, yy + 13).lineTo(pageW - margin - 10, yy + 13).strokeColor('#f0f1f5').lineWidth(0.5).stroke();
    });
  }

  panel(margin, 612, pageW - margin * 2, 36, 'Evidence included with finance packet');
  doc.font('Helvetica').fontSize(7.2).fillColor(dark).text(briefText(evidenceSummary, 185), margin + 10, 632, { width: pageW - margin * 2 - 20 });

  doc.moveTo(margin, 665).lineTo(pageW - margin, 665).strokeColor(line).lineWidth(0.7).stroke();
  doc.font('Helvetica-Bold').fontSize(6.8).fillColor(muted).text('Confidential: For CCI USA Finance Team and authorized committee use only. · © 2026 CCI America.', margin, 676, { width: 390 });
  if (fs.existsSync(tmakLogo)) doc.image(tmakLogo, pageW - 142, 669, { width: 27 });
  doc.font('Helvetica-Bold').fontSize(6.8).fillColor(muted).text('Developed by TMAK Consultancy', pageW - 112, 676, { width: 76, align: 'right' });
}

function buildFinanceSummaryPdfBuffer({ request, docs = [], verifications, assignedReviewers, reviews, reviewSummary }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, bufferPages: false });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawFinanceSummaryPdf({ doc, request, docs, verifications, assignedReviewers, reviews, reviewSummary });
    doc.end();
  });
}

function createFinancePacketService({ baseUrl, getDb, logActivity, sendNotification, appendStoredFileToArchive, getStoredFileByKey }) {
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
          appendStoredFileToArchive(archive, storedFile, `Applicant evidence/${file.original_name}`);
        }

        const leader = verifications && verifications.length ? verifications[0] : null;
        if (leader && leader.support_letter_file) {
          const supportLetter = await getStoredFileByKey(db, leader.support_letter_file);
          appendStoredFileToArchive(archive, supportLetter, `Pastoral support letter/${supportLetter ? supportLetter.original_name : leader.support_letter_file}`);
        }

        await archive.finalize();
      })().catch(reject);
    });
  }

  async function getDecisionArtifacts(db, requestId) {
    const request = await db.get('SELECT * FROM requests WHERE id=?', requestId);
    const docs = await db.all('SELECT * FROM documents WHERE request_id=?', requestId);
    const verifications = await db.all('SELECT v.*, COALESCE(u.name, v.verifier_name) as verifier_name FROM leader_verifications v LEFT JOIN users u ON u.id=v.verified_by WHERE v.request_id=? ORDER BY v.created_at DESC', requestId);
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
    const { request, docs, verifications, assignedReviewers, reviews, reviewSummary } = await getDecisionArtifacts(db, requestId);
    if (!request) return;
    const financeEmail = process.env.FINANCE_TEAM_EMAIL || 'finance@cci.local';
    const financeName = process.env.FINANCE_TEAM_NAME || 'CCI USA Finance Team';
    const approved = isApprovalDecision(request.decision);
    let token = request.finance_confirm_token;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      await db.run('UPDATE requests SET finance_confirm_token=? WHERE id=?', [token, request.id]);
      request.finance_confirm_token = token;
    }
    const packetBuffer = await buildFinancePacketZipBuffer({ request, docs, verifications, assignedReviewers, reviews, reviewSummary });
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

    await sendNotification({
      db,
      requestId: request.id,
      recipientName: financeName,
      recipientEmail: financeEmail,
      subject,
      body,
      attachments: [{ filename: `${request.case_id}-finance-submission-package.zip`, content: packetBuffer }]
    });
    await db.run('UPDATE requests SET finance_packet_sent_at=CURRENT_TIMESTAMP WHERE id=?', request.id);
    await logActivity(request.id, req.session && req.session.user ? req.session.user.id : null, 'Finance packet emailed', `Sent to ${financeEmail} with committee decision: ${request.decision}`);
  }

  return {
    buildFinancePacketZipBuffer,
    buildFinanceSummaryPdfBuffer,
    emailFinanceDecisionPacket,
    getDecisionArtifacts
  };
}

module.exports = {
  createFinancePacketService
};
