const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const { getAppConfig } = require('./config');

let smtpTransporter;
let resendClient;

function getSmtpTransporter() {
  const config = getAppConfig();
  if (!config.email.smtp) return null;
  if (!smtpTransporter) smtpTransporter = nodemailer.createTransport(config.email.smtp);
  return smtpTransporter;
}

function getResendClient() {
  const config = getAppConfig();
  if (!config.email.resendApiKey) return null;
  if (!resendClient) resendClient = new Resend(config.email.resendApiKey);
  return resendClient;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTextAsHtmlParagraphs(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p style="margin:0 0 16px 0;">${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

function buildDefaultHtml({ subject, recipientName, text }) {
  return `
    <div style="margin:0; padding:24px 12px; background:#f5f7fb; font-family:Arial, sans-serif; color:#111827;">
      <div style="max-width:680px; margin:0 auto;">
        <div style="background:#ffffff; border:1px solid #d1d5db; border-radius:20px; padding:32px 28px;">
          <h2 style="margin:0 0 24px 0; font-size:28px; line-height:1.2; color:#111827;">${escapeHtml(subject)}</h2>
          ${recipientName ? `<p style="margin:0 0 18px 0; font-size:16px; line-height:1.7; color:#374151;">Hello ${escapeHtml(recipientName)},</p>` : ''}
          <div style="font-size:16px; line-height:1.75; color:#374151;">
            ${formatTextAsHtmlParagraphs(text)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function mapResendAttachments(attachments = []) {
  return attachments.map((attachment) => {
    const mapped = {
      filename: attachment.filename,
      path: attachment.path,
      content_type: attachment.contentType,
      content_id: attachment.contentId
    };

    if (attachment.content !== undefined) {
      mapped.content = Buffer.isBuffer(attachment.content)
        ? attachment.content.toString('base64')
        : attachment.content;
    }

    return mapped;
  });
}

function mapNodemailerAttachments(attachments = []) {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    content: attachment.content,
    path: attachment.path,
    contentType: attachment.contentType
  }));
}

async function sendEmailDetailed({ to, subject, text, html, recipientName, attachments = [] }) {
  const config = getAppConfig();
  if (config.email.disabled) {
    console.log('Email notifications disabled via DISABLE_EMAIL_NOTIFICATIONS. Email would be sent:', { to, subject });
    return { success: true, provider: 'disabled', reason: 'DISABLE_EMAIL_NOTIFICATIONS=true', preview: true };
  }

  const htmlBody = html || buildDefaultHtml({ subject, recipientName, text });
  const resend = getResendClient();
  if (resend) {
    try {
      const response = await resend.emails.send({
        from: config.email.from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: htmlBody,
        text,
        attachments: attachments.length ? mapResendAttachments(attachments) : undefined
      });
      if (response.error) {
        return {
          success: false,
          provider: 'resend',
          reason: response.error.message || response.error.name || 'Resend error'
        };
      }
      return {
        success: true,
        provider: 'resend',
        messageId: response.data ? response.data.id : undefined
      };
    } catch (error) {
      return {
        success: false,
        provider: 'resend',
        reason: error instanceof Error ? error.message : 'Unknown Resend error'
      };
    }
  }

  const transporter = getSmtpTransporter();
  if (transporter) {
    try {
      const result = await transporter.sendMail({
        from: config.email.from,
        to,
        subject,
        text,
        html: htmlBody,
        attachments: mapNodemailerAttachments(attachments)
      });
      return {
        success: true,
        provider: 'smtp',
        messageId: result.messageId
      };
    } catch (error) {
      return {
        success: false,
        provider: 'smtp',
        reason: error instanceof Error ? error.message : 'Unknown SMTP error'
      };
    }
  }

  console.log('\n--- EMAIL PREVIEW ---');
  console.log('To:', to);
  console.log('Subject:', subject);
  console.log(text);
  if (attachments.length) {
    console.log('Attachments:', attachments.map((attachment) => attachment.filename || attachment.path || 'attachment').join(', '));
  }
  console.log('--- END EMAIL PREVIEW ---\n');

  return { success: true, provider: 'preview', preview: true };
}

module.exports = { buildDefaultHtml, sendEmailDetailed };
