require('dotenv').config();

const { getAppConfig } = require('../src/config');

try {
  const config = getAppConfig();
  const summary = {
    nodeEnv: config.nodeEnv,
    port: config.port,
    appBaseUrl: config.appBaseUrl || null,
    database: {
      configured: !!config.databaseUrl,
      ssl: config.databaseSsl
    },
    email: {
      provider: config.email.provider,
      from: config.email.from,
      disabled: config.email.disabled
    },
    storage: {
      provider: config.storage.provider,
      cloudinaryFolderPrefix: config.storage.cloudinary.folderPrefix || null
    },
    jobs: {
      runSchedulers: config.jobs.runSchedulers,
      reviewerSweepIntervalMinutes: config.jobs.reviewerSweepIntervalMinutes,
      closeoutSweepIntervalMinutes: config.jobs.closeoutSweepIntervalMinutes,
      hasInternalJobSecret: !!config.jobs.internalJobSecret,
      hasQstashToken: !!config.jobs.qstash.token,
      hasQstashSigningKeys: !!(config.jobs.qstash.currentSigningKey && config.jobs.qstash.nextSigningKey)
    }
  };

  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error('Environment validation failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
