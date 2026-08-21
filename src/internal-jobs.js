const express = require('express');
const { getAppConfig } = require('./config');
const { hasQstashReceiverConfig, verifyQstashSignature } = require('./qstash');

const appConfig = getAppConfig();

async function authorizeInternalJobRequest(req, rawBody, baseUrl) {
  if (appConfig.jobs.internalJobSecret) {
    const suppliedSecret = req.get('x-internal-job-secret');
    if (suppliedSecret === appConfig.jobs.internalJobSecret) return true;
  }

  if (!hasQstashReceiverConfig()) return false;

  return verifyQstashSignature({
    signature: req.get('upstash-signature'),
    body: rawBody,
    url: new URL(req.originalUrl, baseUrl(req)).toString(),
    upstashRegion: req.get('upstash-region')
  });
}

function mountInternalJobRoutes(app, { baseUrl, runReviewerInvitationSweep, runApplicantCloseoutSweep }) {
  app.post('/internal/jobs/reviewer-sweep', express.text({ type: '*/*' }), async (req, res) => {
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const authorized = await authorizeInternalJobRequest(req, rawBody, baseUrl);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });
    const summary = await runReviewerInvitationSweep('webhook');
    return res.json(summary);
  });

  app.post('/internal/jobs/closeout-sweep', express.text({ type: '*/*' }), async (req, res) => {
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const authorized = await authorizeInternalJobRequest(req, rawBody, baseUrl);
    if (!authorized) return res.status(401).json({ error: 'Unauthorized' });
    const summary = await runApplicantCloseoutSweep('webhook');
    return res.json(summary);
  });
}

module.exports = { mountInternalJobRoutes };
