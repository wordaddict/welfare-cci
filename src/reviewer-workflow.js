const crypto = require('crypto');
const reviewerRepository = require('./repositories/reviewer-repository');
const { startScheduledLoop } = require('./scheduler');

const REVIEWER_SWEEP_LOCK_KEY = 32011;

function createReviewerWorkflow({
  appConfig,
  baseUrl,
  getDb,
  logActivity,
  sendNotification,
  withAdvisoryLock
}) {
  async function notifyAdminReviewerCoverageGap(db, req, request, slotsRemaining, autoAssignedCount) {
    await logActivity(
      request.id,
      req && req.session && req.session.user ? req.session.user.id : null,
      'Reviewer auto-assignment incomplete',
      `Auto-assigned ${autoAssignedCount} reviewer(s). ${slotsRemaining} reviewer slot(s) still need attention.`
    );

    if (!req) return;

    const delivery = await sendNotification({
      db,
      requestId: request.id,
      recipientName: 'CCI Welfare Admin',
      recipientEmail: appConfig.jobs.adminEmail,
      subject: `Reviewer coverage incomplete: ${request.case_id}`,
      body: `Automatic reviewer assignment could not fully cover ${request.case_id}.

Auto-assigned reviewer slots: ${autoAssignedCount}
Reviewer slots still open: ${slotsRemaining}

Please add more active reviewers in the Reviewer Directory or assign the remaining reviewer slots manually from the Admin portal.

CCI America Financial Assistance Committee`
    });

    if (!delivery.success) {
      await logActivity(request.id, null, 'Reviewer coverage notification failed', delivery.reason || 'Email delivery failed');
    }
  }

  async function ensureTwoReviewerInvites(db, req, requestId) {
    const request = await reviewerRepository.getRequestById(db, requestId);
    if (!request) return 0;

    const leaderResponse = await reviewerRepository.hasLeaderVerification(db, requestId);
    if (!leaderResponse) return 0;

    const completedReviews = await reviewerRepository.countReviewsForRequest(db, requestId);
    if ((completedReviews.count || 0) >= 2) return 0;

    const reminderHours = request.urgency === 'Emergency' ? 12 : 48;
    const replaceHours = request.urgency === 'Emergency' ? 24 : 72;

    const pendingActive = await reviewerRepository.listPendingActiveReviewerAssignments(db, requestId);
    let notificationsQueued = 0;

    const now = Date.now();
    for (const inv of pendingActive) {
      const notifiedAt = inv.notified_at ? new Date(inv.notified_at).getTime() : now;
      const ageHours = (now - notifiedAt) / 36e5;
      if (ageHours >= replaceHours) {
        await reviewerRepository.expireReviewerAssignment(db, inv.id);
        await logActivity(requestId, null, 'Reviewer invitation expired', `${inv.email} did not respond within ${replaceHours} hours.`);
        if (!appConfig.jobs.autoAssignReviewers) {
          const delivery = await sendNotification({
            db,
            requestId,
            recipientName: 'CCI Welfare Admin',
            recipientEmail: appConfig.jobs.adminEmail,
            subject: `Reviewer replacement needed: ${request.case_id}`,
            body: `${inv.name} (${inv.email}) did not respond to the review invitation within the allowed window. Please assign a replacement reviewer from the Admin portal.`
          });
          if (!delivery.success) {
            await logActivity(requestId, null, 'Reviewer replacement email failed', delivery.reason || 'Email delivery failed');
          }
        }
      } else if (ageHours >= reminderHours && !inv.reminder_sent_at) {
        const acceptLink = `${baseUrl(req)}/review-invite/${inv.invite_token}`;
        const delivery = await sendNotification({
          db,
          requestId,
          recipientName: inv.name,
          recipientEmail: inv.email,
          subject: `Reminder: review availability requested for ${request.case_id}`,
          body: `Dear ${inv.name},

This is a reminder that you were invited to review confidential financial assistance request ${request.case_id}.

Please accept or decline using the secure link below:
${acceptLink}

If there is no response within the review window, another reviewer may be contacted.

CCI America Financial Assistance Committee`
        });
        if (delivery.success) {
          await reviewerRepository.markReviewerReminderSent(db, inv.id);
          await logActivity(requestId, inv.reviewer_id, 'Reviewer reminder sent', `Reminder sent after ${reminderHours} hours.`);
        } else {
          await logActivity(requestId, inv.reviewer_id, 'Reviewer reminder email failed', delivery.reason || 'Email delivery failed');
        }
      }
    }

    const active = await reviewerRepository.listActiveReviewerAssignments(db, requestId);
    const needed = Math.max(0, 2 - active.length);
    let autoAssignedCount = 0;

    if (needed > 0 && appConfig.jobs.autoAssignReviewers) {
      const candidates = await reviewerRepository.listReviewerAutoAssignCandidates(db, requestId, needed);

      for (const reviewer of candidates) {
        const token = crypto.randomBytes(24).toString('hex');
        const result = await reviewerRepository.insertReviewerAssignmentIgnore(db, {
          requestId,
          reviewerId: reviewer.id,
          assignedBy: req && req.session && req.session.user ? req.session.user.id : null,
          inviteToken: token
        });
        if (result && result.changes > 0) autoAssignedCount += 1;
      }

      const remainingSlots = Math.max(0, needed - autoAssignedCount);
      if (remainingSlots > 0) {
        await notifyAdminReviewerCoverageGap(db, req, request, remainingSlots, autoAssignedCount);
      }
    }

    const pending = await reviewerRepository.listPendingReviewerNotifications(db, requestId);

    for (const reviewer of pending) {
      const token = reviewer.invite_token || crypto.randomBytes(24).toString('hex');
      if (!reviewer.invite_token) {
        await reviewerRepository.updateReviewerInviteToken(db, reviewer.assignment_id, token);
      }
      const inviteLink = `${baseUrl(req)}/review-invite/${token}`;
      const delivery = await sendNotification({
        db,
        requestId,
        recipientName: reviewer.name,
        recipientEmail: reviewer.email,
        subject: `Review availability requested: ${request.case_id}`,
        body: `Dear ${reviewer.name},

A confidential financial assistance request (${request.case_id}) is ready for review.

Please accept or decline this review request using the secure link below:
${inviteLink}

Only two reviewers are needed for each case. If you decline or do not respond within the review window, another reviewer will be contacted.

Review window:
- Emergency cases: reminder after 12 hours, replacement after 24 hours.
- Other cases: reminder after 48 hours, replacement after 72 hours.

CCI America Financial Assistance Committee`
      });
      if (delivery.success) {
        await reviewerRepository.markReviewerNotified(db, reviewer.assignment_id);
        notificationsQueued += 1;
      } else {
        await logActivity(requestId, reviewer.id, 'Reviewer invite email failed', delivery.reason || 'Email delivery failed');
      }
    }

    const activeAfter = await reviewerRepository.countActiveReviewerAssignments(db, requestId);
    if ((activeAfter.count || 0) > 0) {
      await reviewerRepository.updateRequestStatus(db, requestId, 'Assigned to Reviewers');
    }
    return notificationsQueued;
  }

  async function notifyAssignedReviewers(db, req, requestId) {
    return ensureTwoReviewerInvites(db, req, requestId);
  }

  async function runReviewerInvitationSweep(reason = 'scheduled') {
    const lock = await withAdvisoryLock(REVIEWER_SWEEP_LOCK_KEY, async () => {
      const db = await getDb();
      const requests = await reviewerRepository.listRequestsForReviewerSweep(db);

      let totalNotifications = 0;
      let errors = 0;
      for (const request of requests) {
        try {
          const notified = await ensureTwoReviewerInvites(db, null, request.id);
          totalNotifications += Number(notified || 0);
        } catch (err) {
          console.error(`[reviewer-sweep] ${request.case_id}:`, err.message);
          await logActivity(request.id, null, 'Reviewer sweep error', err.message);
          errors += 1;
        }
      }

      if (requests.length) {
        console.log(`[reviewer-sweep] ${reason}: checked ${requests.length} request(s), queued ${totalNotifications} notification(s).`);
      }

      return {
        job: 'reviewer-sweep',
        reason,
        checked: requests.length,
        notificationsQueued: totalNotifications,
        errors
      };
    });

    if (!lock.locked) {
      return { job: 'reviewer-sweep', reason, skipped: true, skipReason: 'lock-not-acquired' };
    }

    return lock.result;
  }

  function startReviewerScheduler() {
    if (!appConfig.jobs.runSchedulers) {
      console.log('[reviewer-scheduler] skipped because RUN_SCHEDULERS=false');
      return;
    }
    if (appConfig.jobs.disableReviewerScheduler) {
      console.log('[reviewer-scheduler] disabled');
      return;
    }

    const minutes = Math.max(1, Number(appConfig.jobs.reviewerSweepIntervalMinutes || 15));
    console.log(`[reviewer-scheduler] running every ${minutes} minute(s).`);
    console.log(`[reviewer-scheduler] auto reviewer assignment is ${appConfig.jobs.autoAssignReviewers ? 'enabled' : 'disabled'}.`);
    if (appConfig.jobs.qstash.token) {
      console.log('[reviewer-scheduler] QStash is configured. Set RUN_SCHEDULERS=false if you want webhook-driven jobs only.');
    }

    startScheduledLoop({
      label: 'reviewer-scheduler',
      startupDelayMs: 10000,
      intervalMs: minutes * 60 * 1000,
      run: runReviewerInvitationSweep
    });
  }

  return {
    ensureTwoReviewerInvites,
    notifyAssignedReviewers,
    runReviewerInvitationSweep,
    startReviewerScheduler
  };
}

module.exports = { createReviewerWorkflow };
