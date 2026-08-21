require('dotenv').config();

const { getAppConfig } = require('../src/config');
const { getCloseoutSweepJobUrl, getQstashClient, getReviewerSweepJobUrl } = require('../src/qstash');

const REVIEWER_SCHEDULE_ID = 'cci-welfare-reviewer-sweep';
const CLOSEOUT_SCHEDULE_ID = 'cci-welfare-closeout-sweep';

function cronFromMinutes(minutes) {
  const value = Number(minutes || 0);
  if (value <= 0) throw new Error('Sweep interval must be a positive number of minutes.');
  if (value === 60) return '0 * * * *';
  if (value < 60 && 60 % value === 0) return `*/${value} * * * *`;
  if (value === 1440) return '0 0 * * *';
  throw new Error(`Unsupported sweep interval for QStash cron conversion: ${value} minute(s). Use a divisor of 60, 60, or 1440.`);
}

async function upsertSchedule({ scheduleId, destination, cron, job }) {
  const client = getQstashClient();
  try {
    await client.schedules.delete(scheduleId);
  } catch {
    // Safe to ignore when the schedule does not exist yet.
  }

  return client.schedules.create({
    scheduleId,
    destination,
    cron,
    method: 'POST',
    body: JSON.stringify({ job }),
    headers: {
      'Content-Type': 'application/json'
    },
    retries: 3,
    label: ['cci-welfare', job]
  });
}

async function setupSchedules() {
  const config = getAppConfig();
  if (!config.appBaseUrl) {
    throw new Error('APP_BASE_URL is required to configure QStash schedules.');
  }

  const reviewerCron = cronFromMinutes(config.jobs.reviewerSweepIntervalMinutes);
  const closeoutCron = cronFromMinutes(config.jobs.closeoutSweepIntervalMinutes);

  const reviewerResult = await upsertSchedule({
    scheduleId: REVIEWER_SCHEDULE_ID,
    destination: getReviewerSweepJobUrl(),
    cron: reviewerCron,
    job: 'reviewer-sweep'
  });

  const closeoutResult = await upsertSchedule({
    scheduleId: CLOSEOUT_SCHEDULE_ID,
    destination: getCloseoutSweepJobUrl(),
    cron: closeoutCron,
    job: 'closeout-sweep'
  });

  console.log(JSON.stringify({
    reviewer: {
      scheduleId: reviewerResult.scheduleId,
      destination: getReviewerSweepJobUrl(),
      cron: reviewerCron
    },
    closeout: {
      scheduleId: closeoutResult.scheduleId,
      destination: getCloseoutSweepJobUrl(),
      cron: closeoutCron
    }
  }, null, 2));
}

setupSchedules().catch((error) => {
  console.error('Failed to configure QStash schedules:', error);
  process.exit(1);
});
