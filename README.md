# CCI America Financial Assistance App - v36work

This build keeps the welfare workflow and now leans much closer to the production shape of `cci`: PostgreSQL, external-ready file storage, production email delivery, and scheduler hooks for hosted jobs.

## Stack

- Node.js
- Express
- EJS
- PostgreSQL
- Postgres-backed sessions
- Cloudinary-ready file storage with database fallback
- Resend-ready email delivery with SMTP fallback
- Optional QStash-backed scheduled jobs

## Access model

Only two roles use password login:

- Applicant
- Admin

The following roles do not log in:

- Reviewer
- Pastor
- MAP Leader / other verification contact
- Celeforce Unit Head
- Finance contact

They receive secure, case-specific email links.

## Local setup

```bash
cp .env.local.example .env
npm install
npm run env:check
npm run seed
npm start
```

Open `http://localhost:3000`.

Local demo accounts created by `npm run seed`:

- Admin: `admin@cci.local` / `admin123`
- Applicant: `applicant@cci.local` / `applicant123`

## Production hosting

See [DEPLOYMENT.md](/Users/michealadeyinka/Downloads/v36work/DEPLOYMENT.md) for the hosted setup.

Useful env profiles:

- [`.env.local.example`](/Users/michealadeyinka/Downloads/v36work/.env.local.example) for local development
- [`.env.production.example`](/Users/michealadeyinka/Downloads/v36work/.env.production.example) for hosted setup
- [`.env.example`](/Users/michealadeyinka/Downloads/v36work/.env.example) as the full reference sheet

Required production pieces:

- `DATABASE_URL`
- `SESSION_SECRET`
- `APP_BASE_URL`
- email delivery through `RESEND_API_KEY`, `SENDGRID_API_KEY`, or `SMTP_*`

Recommended production pieces:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Optional production scheduler pieces:

- `RUN_SCHEDULERS=true` for in-process scheduling
- or `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- or `INTERNAL_JOB_SECRET` for authenticated external job calls

You can validate your current env at any time with:

```bash
npm run env:check
```

## Email

For local use, leave Resend/SMTP unset and email previews will print in Terminal.

For production, configure either:

- `RESEND_API_KEY` with `FROM_EMAIL`
- or `SENDGRID_API_KEY`
- or `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`

## Files

If Cloudinary is configured, uploads are stored there and streamed back through the app’s authorized routes.

If Cloudinary is not configured, uploads fall back to PostgreSQL-backed storage so Heroku deployments still work.

## Background jobs

The app supports:

- in-process schedulers for reviewer sweeps and close-out reminders
- internal webhook endpoints at `/internal/jobs/reviewer-sweep` and `/internal/jobs/closeout-sweep`
- optional QStash schedule setup via `npm run qstash:setup-jobs`

## Production Admin account

On a fresh database, set:

- `ADMIN_BOOTSTRAP_NAME`
- `ADMIN_BOOTSTRAP_EMAIL`
- `ADMIN_BOOTSTRAP_PASSWORD`

The bootstrap password must be at least 12 characters.

## Important security notes

- Never commit `.env`.
- Use HTTPS in production.
- Use a long random `SESSION_SECRET`.
- Reviewer links are confidential bearer links and should not be forwarded.
- Uploaded evidence is not publicly exposed; Admin access requires authentication and reviewer access requires a live case-specific token.
