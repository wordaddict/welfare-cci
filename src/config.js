const { z } = require('zod');

const emptyToUndefined = (value) => {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
};

const boolFromString = (defaultValue = false) => z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}, z.boolean());

const optionalString = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = () => z.preprocess(emptyToUndefined, z.string().url().optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: boolFromString(false).default(false),
  APP_BASE_URL: optionalUrl(),
  SESSION_SECRET: optionalString(),
  FROM_EMAIL: optionalString(),
  MAIL_FROM: optionalString(),
  RESEND_API_KEY: optionalString(),
  SENDGRID_API_KEY: optionalString(),
  SMTP_HOST: optionalString(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: boolFromString(false).default(false),
  SMTP_USER: optionalString(),
  SMTP_PASS: optionalString(),
  DISABLE_EMAIL_NOTIFICATIONS: boolFromString(false).default(false),
  ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.string().email().default('admin@cci.local')),
  FINANCE_TEAM_NAME: z.preprocess(emptyToUndefined, z.string().default('CCI USA Finance Team')),
  FINANCE_TEAM_EMAIL: z.preprocess(emptyToUndefined, z.string().email().default('finance@cci.local')),
  CLOUDINARY_CLOUD_NAME: optionalString(),
  CLOUDINARY_API_KEY: optionalString(),
  CLOUDINARY_API_SECRET: optionalString(),
  CLOUDINARY_FOLDER_PREFIX: z.preprocess(emptyToUndefined, z.string().default('cci-welfare')),
  QSTASH_TOKEN: optionalString(),
  QSTASH_CURRENT_SIGNING_KEY: optionalString(),
  QSTASH_NEXT_SIGNING_KEY: optionalString(),
  QSTASH_SKIP_URL_VERIFICATION: boolFromString(false).default(false),
  INTERNAL_JOB_SECRET: optionalString(),
  AUTO_ASSIGN_REVIEWERS: boolFromString(false).default(false),
  RUN_SCHEDULERS: boolFromString(true).default(true),
  DISABLE_REVIEWER_SCHEDULER: boolFromString(false).default(false),
  DISABLE_CLOSEOUT_SCHEDULER: boolFromString(false).default(false),
  REVIEWER_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  CLOSEOUT_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  FOLLOWUP_CLOSEOUT_DELAY_DAYS: z.coerce.number().min(0).default(3),
  FOLLOWUP_REMINDER_INTERVAL_DAYS: z.coerce.number().min(0).default(7)
}).superRefine((env, ctx) => {
  const hasSmtp = !!env.SMTP_HOST || !!env.SENDGRID_API_KEY;
  const hasResend = !!env.RESEND_API_KEY;

  if (env.NODE_ENV === 'production') {
    if (!env.APP_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_BASE_URL'],
        message: 'APP_BASE_URL is required in production.'
      });
    }
    if (!env.SESSION_SECRET || env.SESSION_SECRET === 'dev-secret-change-me') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET must be a strong value in production.'
      });
    }
    if (!hasResend && !hasSmtp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_KEY'],
        message: 'Configure RESEND_API_KEY, SENDGRID_API_KEY, or SMTP_* in production.'
      });
    }
  }
});

let cachedConfig;

function formatZodIssues(error) {
  return error.issues
    .map((issue) => {
      const path = issue.path && issue.path.length ? issue.path.join('.') : 'config';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
}

function buildEmailConfig(env) {
  const from = env.FROM_EMAIL || env.MAIL_FROM || 'CCI America Financial Assistance <no-reply@cci.local>';
  const provider = env.RESEND_API_KEY
    ? 'resend'
    : (env.SMTP_HOST || env.SENDGRID_API_KEY ? 'smtp' : 'preview');

  const smtp = env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
      }
    : (env.SENDGRID_API_KEY
        ? {
            host: 'smtp.sendgrid.net',
            port: 587,
            secure: false,
            auth: { user: 'apikey', pass: env.SENDGRID_API_KEY }
          }
        : null);

  return {
    provider,
    from,
    resendApiKey: env.RESEND_API_KEY,
    smtp,
    disabled: env.DISABLE_EMAIL_NOTIFICATIONS
  };
}

function buildStorageConfig(env) {
  return {
    provider: env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET ? 'cloudinary' : 'database',
    cloudinary: {
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      apiKey: env.CLOUDINARY_API_KEY,
      apiSecret: env.CLOUDINARY_API_SECRET,
      folderPrefix: env.CLOUDINARY_FOLDER_PREFIX
    }
  };
}

function buildJobsConfig(env) {
  return {
    runSchedulers: env.RUN_SCHEDULERS,
    reviewerSweepIntervalMinutes: env.REVIEWER_SWEEP_INTERVAL_MINUTES,
    closeoutSweepIntervalMinutes: env.CLOSEOUT_SWEEP_INTERVAL_MINUTES,
    disableReviewerScheduler: env.DISABLE_REVIEWER_SCHEDULER,
    disableCloseoutScheduler: env.DISABLE_CLOSEOUT_SCHEDULER,
    internalJobSecret: env.INTERNAL_JOB_SECRET,
    autoAssignReviewers: env.AUTO_ASSIGN_REVIEWERS,
    adminEmail: env.ADMIN_EMAIL,
    financeTeamName: env.FINANCE_TEAM_NAME,
    financeTeamEmail: env.FINANCE_TEAM_EMAIL,
    qstash: {
      token: env.QSTASH_TOKEN,
      currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
      skipUrlVerification: env.QSTASH_SKIP_URL_VERIFICATION
    },
    followupCloseoutDelayDays: env.FOLLOWUP_CLOSEOUT_DELAY_DAYS,
    followupReminderIntervalDays: env.FOLLOWUP_REMINDER_INTERVAL_DAYS
  };
}

function getAppConfig() {
  if (cachedConfig) return cachedConfig;
  let env;
  try {
    env = envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Environment validation failed:\n${formatZodIssues(error)}`);
    }
    throw error;
  }
  cachedConfig = {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: env.DATABASE_SSL,
    appBaseUrl: env.APP_BASE_URL,
    sessionSecret: env.SESSION_SECRET || 'dev-secret-change-me',
    email: buildEmailConfig(env),
    storage: buildStorageConfig(env),
    jobs: buildJobsConfig(env)
  };
  return cachedConfig;
}

module.exports = { getAppConfig };
