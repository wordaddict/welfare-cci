const { Client, Receiver, SignatureError } = require('@upstash/qstash');
const { z } = require('zod');
const { getAppConfig } = require('./config');

const receiverSchema = z.object({
  currentSigningKey: z.string().min(1),
  nextSigningKey: z.string().min(1)
});

const clientSchema = z.object({
  token: z.string().min(1),
  appBaseUrl: z.string().url()
});

function hasQstashReceiverConfig() {
  const config = getAppConfig();
  return !!(config.jobs.qstash.currentSigningKey && config.jobs.qstash.nextSigningKey);
}

function hasQstashClientConfig() {
  const config = getAppConfig();
  return !!(config.jobs.qstash.token && config.appBaseUrl);
}

function getQstashReceiver() {
  const config = getAppConfig();
  const env = receiverSchema.parse({
    currentSigningKey: config.jobs.qstash.currentSigningKey,
    nextSigningKey: config.jobs.qstash.nextSigningKey
  });
  return new Receiver({
    currentSigningKey: env.currentSigningKey,
    nextSigningKey: env.nextSigningKey
  });
}

async function verifyQstashSignature({ signature, body, url, upstashRegion }) {
  if (!signature || !hasQstashReceiverConfig()) return false;

  try {
    const config = getAppConfig();
    await getQstashReceiver().verify({
      signature,
      body,
      url: config.jobs.qstash.skipUrlVerification ? undefined : url,
      upstashRegion: upstashRegion || undefined
    });
    return true;
  } catch (error) {
    if (error instanceof SignatureError) return false;
    throw error;
  }
}

function getQstashClient() {
  const config = getAppConfig();
  const env = clientSchema.parse({
    token: config.jobs.qstash.token,
    appBaseUrl: config.appBaseUrl
  });

  return new Client({
    token: env.token
  });
}

function getReviewerSweepJobUrl() {
  const config = getAppConfig();
  return new URL('/internal/jobs/reviewer-sweep', config.appBaseUrl).toString();
}

function getCloseoutSweepJobUrl() {
  const config = getAppConfig();
  return new URL('/internal/jobs/closeout-sweep', config.appBaseUrl).toString();
}

module.exports = {
  getCloseoutSweepJobUrl,
  getQstashClient,
  getReviewerSweepJobUrl,
  hasQstashClientConfig,
  hasQstashReceiverConfig,
  verifyQstashSignature
};
