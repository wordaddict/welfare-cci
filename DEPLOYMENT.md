# Hosted Deployment Guide

This app now supports a deployment shape much closer to `cci`:

- PostgreSQL for application data
- Postgres-backed sessions
- Cloudinary for external file storage when configured
- Resend for production email when configured
- optional QStash-driven scheduler webhooks

It still works without Cloudinary or QStash, but those are the preferred production services.

## 1. Create the app

Example for Heroku:

```text
heroku create your-app-name
```

## 2. Add Postgres

```text
heroku addons:create heroku-postgresql:essential-0
```

Heroku will set `DATABASE_URL` automatically.

## 3. Configure file storage

Recommended, closer to `cci`:

```text
CLOUDINARY_CLOUD_NAME=<cloud-name>
CLOUDINARY_API_KEY=<api-key>
CLOUDINARY_API_SECRET=<api-secret>
CLOUDINARY_FOLDER_PREFIX=cci-welfare
```

If Cloudinary is not configured, uploaded evidence falls back to PostgreSQL-backed storage.

## 4. Configure email

Recommended, closer to `cci`:

```text
RESEND_API_KEY=<resend-api-key>
FROM_EMAIL="CCI America Financial Assistance <no-reply@your-domain>"
```

Fallback options:

```text
SENDGRID_API_KEY=<sendgrid-api-key>
```

or

```text
SMTP_HOST=<smtp-host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<smtp-user>
SMTP_PASS=<smtp-password>
MAIL_FROM="CCI America Financial Assistance <no-reply@your-domain>"
```

## 5. Set required config vars

```text
heroku config:set NODE_ENV=production
heroku config:set APP_BASE_URL=https://your-app-name.herokuapp.com
heroku config:set SESSION_SECRET=<long-random-secret>
heroku config:set ADMIN_BOOTSTRAP_NAME="CCI Welfare Admin"
heroku config:set ADMIN_BOOTSTRAP_EMAIL=<admin-email>
heroku config:set ADMIN_BOOTSTRAP_PASSWORD=<strong-password-12+-characters>
heroku config:set ADMIN_EMAIL=<admin-notification-email>
heroku config:set FINANCE_TEAM_NAME="CCI USA Finance Team"
heroku config:set FINANCE_TEAM_EMAIL=<finance-email>
heroku config:set AUTO_ASSIGN_REVIEWERS=false
```

## 6. Choose a scheduler mode

### Option A: In-process scheduler

Simplest setup:

```text
heroku config:set RUN_SCHEDULERS=true
```

Optional intervals:

```text
heroku config:set REVIEWER_SWEEP_INTERVAL_MINUTES=15
heroku config:set CLOSEOUT_SWEEP_INTERVAL_MINUTES=60
heroku config:set FOLLOWUP_CLOSEOUT_DELAY_DAYS=3
heroku config:set FOLLOWUP_REMINDER_INTERVAL_DAYS=7
```

### Option B: QStash scheduler

Set:

```text
QSTASH_TOKEN=<qstash-token>
QSTASH_CURRENT_SIGNING_KEY=<current-signing-key>
QSTASH_NEXT_SIGNING_KEY=<next-signing-key>
RUN_SCHEDULERS=false
```

Then configure schedules:

```text
npm run qstash:setup-jobs
```

### Option C: External scheduler / manual webhooks

Set:

```text
RUN_SCHEDULERS=false
INTERNAL_JOB_SECRET=<shared-secret>
```

Then trigger:

- `POST /internal/jobs/reviewer-sweep`
- `POST /internal/jobs/closeout-sweep`

with header:

```text
X-Internal-Job-Secret: <shared-secret>
```

## 7. Deploy

Build command:

```text
npm install
```

Start command:

```text
npm start
```

The included `Procfile` already uses `npm start`.

## 8. Seed local-only demo users if needed

For a new production app, rely on the bootstrap admin env vars instead of seeded local credentials.

For local development:

```text
npm run seed
```

## 9. Verify before go-live

Test all of these with dummy data:

1. Applicant registration and login.
2. Application submission with file uploads.
3. Unit Head verification for a Celeforce applicant.
4. Pastoral verification.
5. Reviewer assignment from Admin.
6. Reviewer invite delivery.
7. Reviewer acceptance and secure review link.
8. Reviewer access to uploaded evidence.
9. Reviewer submission.
10. Admin decision recording.
11. Finance packet email.
12. Finance confirmation flow.
13. Applicant payment notification.
14. Automated or webhook-triggered follow-up workflow.

## Notes

- Heroku’s filesystem is ephemeral, so local-disk uploads are no longer part of the deployment plan.
- Keep using `DATABASE_URL` instead of copying static credentials.
- If you run more than one process or dyno type, make sure only one scheduler mode is active at a time.
