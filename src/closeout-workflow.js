const { startScheduledLoop } = require('./scheduler');
const closeoutRepository = require('./repositories/closeout-repository');

const CLOSEOUT_SWEEP_LOCK_KEY = 32012;

function createCloseoutWorkflow({
  appConfig,
  baseUrl,
  getDb,
  logActivity,
  money,
  sendNotification,
  withAdvisoryLock
}) {
  function followupDelayDays() {
    const n = Number(appConfig.jobs.followupCloseoutDelayDays);
    return Number.isFinite(n) && n >= 0 ? n : 3;
  }

  function followupReminderDays() {
    const n = Number(appConfig.jobs.followupReminderIntervalDays);
    return Number.isFinite(n) && n >= 0 ? n : 7;
  }

  async function sendApplicantPaymentNotice(db, req, request, paymentInfo = {}) {
    const trackingLink = `${baseUrl(req)}/track/${request.tracking_token}`;
    const amountProcessed = paymentInfo.amount || request.payment_confirmation_amount || request.amount_approved || request.amount_requested;
    const method = paymentInfo.method || request.payment_confirmation_method || 'as arranged by the finance team';
    const reference = paymentInfo.reference || request.payment_confirmation_reference || 'not provided';

    const delivery = await sendNotification({
      db,
      requestId: request.id,
      recipientName: request.full_name,
      recipientEmail: request.email,
      subject: `Your CCI America financial assistance request has been approved: ${request.case_id}`,
      body: `Dear ${request.full_name},

We are pleased to let you know that your financial assistance request has been approved and the approved support has now been processed.

Case ID: ${request.case_id}
Request category: ${request.request_category}
Decision: ${request.decision}
Amount processed: ${money(amountProcessed)}
Payment method/platform: ${method}
Payment reference: ${reference}

We are glad to have been able to support you at this time of need. We will continue to keep you in our prayers, and we wish you all the very best.

For record-keeping and stewardship purposes, a short close-out form will normally be sent after 3 days. There is no action needed from you right now. When you receive the close-out request, kindly complete it and upload any available receipt or confirmation related to the support provided.

You may continue to track your request here:
${trackingLink}

With care,
CCI America Financial Assistance Committee`
    });

    if (!delivery.success) {
      await logActivity(request.id, null, 'Applicant payment update email failed', delivery.reason || 'Email delivery failed');
      return delivery;
    }

    await closeoutRepository.markApplicantPaymentNotified(db, request.id);
    await logActivity(request.id, null, 'Applicant payment update email sent', 'Applicant received supportive payment/update email. Close-out request will be sent later.');
    return delivery;
  }

  async function sendApplicantCloseoutRequest(db, req, request) {
    const trackingLink = `${baseUrl(req)}/track/${request.tracking_token}`;
    const delivery = await sendNotification({
      db,
      requestId: request.id,
      recipientName: request.full_name,
      recipientEmail: request.email,
      subject: `Close-out form for your CCI America financial assistance request: ${request.case_id}`,
      body: `Dear ${request.full_name},

We hope the support provided has been helpful.

As part of our regular record-keeping and stewardship process, please complete the short close-out form for your request. This helps the committee keep accurate records and complete the case file responsibly.

Case ID: ${request.case_id}
Request category: ${request.request_category}
Amount processed: ${money(request.payment_confirmation_amount || request.amount_approved || request.amount_requested)}

Please use your tracking page to complete the close-out form and upload any available receipt, payment confirmation, or related evidence:
${trackingLink}

Completing the close-out form helps keep your request record complete and may be considered when reviewing any future assistance requests.

Thank you,
CCI America Financial Assistance Committee`
    });

    if (!delivery.success) {
      await logActivity(request.id, null, 'Applicant close-out form email failed', delivery.reason || 'Email delivery failed');
      return delivery;
    }

    await closeoutRepository.markApplicantFollowupRequested(db, request.id);
    await logActivity(request.id, null, 'Applicant close-out form requested', 'Close-out/follow-up request email sent after payment confirmation.');
    return delivery;
  }

  async function sendApplicantCloseoutReminder(db, req, request) {
    const trackingLink = `${baseUrl(req)}/track/${request.tracking_token}`;
    const count = Number(request.applicant_followup_reminder_count || 0) + 1;
    const delivery = await sendNotification({
      db,
      requestId: request.id,
      recipientName: request.full_name,
      recipientEmail: request.email,
      subject: `Reminder: close-out form for ${request.case_id}`,
      body: `Dear ${request.full_name},

This is a gentle reminder to complete the short close-out form for your CCI America financial assistance request.

Case ID: ${request.case_id}
Request category: ${request.request_category}
Amount processed: ${money(request.payment_confirmation_amount || request.amount_approved || request.amount_requested)}

Please complete the form through your tracking page and upload any available receipt, payment confirmation, or related evidence:
${trackingLink}

This helps CCI America keep accurate records and complete the case file responsibly.

Thank you,
CCI America Financial Assistance Committee`
    });

    if (!delivery.success) {
      await logActivity(request.id, null, 'Applicant close-out reminder email failed', delivery.reason || 'Email delivery failed');
      return delivery;
    }

    await closeoutRepository.markApplicantFollowupReminderSent(db, request.id, count);
    await logActivity(request.id, null, 'Applicant close-out reminder sent', `Weekly close-out reminder #${count} sent.`);
    return delivery;
  }

  async function runApplicantCloseoutSweep(reason = 'scheduled') {
    const lock = await withAdvisoryLock(CLOSEOUT_SWEEP_LOCK_KEY, async () => {
      const db = await getDb();
      const delay = followupDelayDays();
      const reminderInterval = followupReminderDays();
      const requests = await closeoutRepository.listRequestsForCloseoutSweep(db);

      const now = Date.now();
      let sent = 0;
      let reminded = 0;
      let errors = 0;
      for (const request of requests) {
        try {
          if (Number(request.applicant_followup_count || 0) > 0) continue;
          const confirmedAt = request.payment_confirmed_at ? new Date(request.payment_confirmed_at).getTime() : now;
          const ageDays = (now - confirmedAt) / 86400000;
          if (!request.applicant_followup_requested_at) {
            if (ageDays >= delay) {
              const delivery = await sendApplicantCloseoutRequest(db, null, request);
              if (delivery && delivery.success) sent += 1;
            }
            continue;
          }

          const lastReminderAt = request.applicant_followup_reminder_sent_at || request.applicant_followup_requested_at;
          const lastReminderTime = lastReminderAt ? new Date(lastReminderAt).getTime() : confirmedAt;
          const daysSinceLastReminder = (now - lastReminderTime) / 86400000;
          if (daysSinceLastReminder >= reminderInterval) {
            const delivery = await sendApplicantCloseoutReminder(db, null, request);
            if (delivery && delivery.success) reminded += 1;
          }
        } catch (err) {
          console.error(`[closeout-sweep] ${request.case_id}:`, err.message);
          await logActivity(request.id, null, 'Close-out sweep error', err.message);
          errors += 1;
        }
      }
      if (requests.length || sent || reminded) {
        console.log(`[closeout-sweep] ${reason}: checked ${requests.length} request(s), sent ${sent} close-out request(s), sent ${reminded} reminder(s).`);
      }
      return {
        job: 'closeout-sweep',
        reason,
        checked: requests.length,
        closeoutRequestsSent: sent,
        remindersSent: reminded,
        errors
      };
    });

    if (!lock.locked) {
      return { job: 'closeout-sweep', reason, skipped: true, skipReason: 'lock-not-acquired' };
    }

    return lock.result;
  }

  function startApplicantCloseoutScheduler() {
    if (!appConfig.jobs.runSchedulers) {
      console.log('[closeout-scheduler] skipped because RUN_SCHEDULERS=false');
      return;
    }
    if (appConfig.jobs.disableCloseoutScheduler) {
      console.log('[closeout-scheduler] disabled');
      return;
    }
    const minutes = Math.max(1, Number(appConfig.jobs.closeoutSweepIntervalMinutes || 60));
    console.log(`[closeout-scheduler] running every ${minutes} minute(s); close-out delay ${followupDelayDays()} day(s); reminder interval ${followupReminderDays()} day(s).`);
    if (appConfig.jobs.qstash.token) {
      console.log('[closeout-scheduler] QStash is configured. Set RUN_SCHEDULERS=false if you want webhook-driven jobs only.');
    }

    startScheduledLoop({
      label: 'closeout-scheduler',
      startupDelayMs: 15000,
      intervalMs: minutes * 60 * 1000,
      run: runApplicantCloseoutSweep
    });
  }

  return {
    sendApplicantPaymentNotice,
    sendApplicantCloseoutRequest,
    runApplicantCloseoutSweep,
    startApplicantCloseoutScheduler
  };
}

module.exports = { createCloseoutWorkflow };
