const { sendEmailDetailed } = require('./email');

async function sendNotification({ db, requestId, recipientName, recipientEmail, subject, body, attachments = [] }) {
  const saved = await db.run(
    'INSERT INTO notifications (request_id, recipient_name, recipient_email, subject, body, status) VALUES (?,?,?,?,?,?)',
    [requestId || null, recipientName || '', recipientEmail, subject, body, 'Queued']
  );

  const result = await sendEmailDetailed({
    to: recipientEmail,
    subject,
    text: body,
    recipientName,
    attachments
  });

  if (result.success) {
    const status = result.preview ? 'Previewed' : 'Sent';
    await db.run(
      'UPDATE notifications SET status=?, provider=?, provider_message_id=?, sent_at=CURRENT_TIMESTAMP WHERE id=?',
      [status, result.provider || null, result.messageId || null, saved.lastID]
    );
    return;
  }

  await db.run(
    'UPDATE notifications SET status=?, provider=?, provider_message_id=?, error=? WHERE id=?',
    ['Failed', result.provider || null, result.messageId || null, result.reason || 'Email delivery failed', saved.lastID]
  );
  console.error('Email failed:', result.reason);
}

module.exports = { sendNotification };
