# Online Deployment Guide

## Recommended first deployment: Render with a persistent disk

This app is a Node.js/Express application using SQLite and local uploaded files. Therefore the hosting service must provide a persistent disk/volume.

A `render.yaml` file is included as a starting point.

### 1. Put the project on GitHub

Create a **private** GitHub repository and push this project. The included `.gitignore` excludes `.env`, databases, uploaded evidence, and `node_modules`.

### 2. Create the web service

Connect the GitHub repository to your hosting provider. For Render you can use the included Blueprint or create a Node web service manually.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Health check:

```text
/health
```

### 3. Attach persistent storage

Mount a persistent disk, for example at:

```text
/var/data
```

Then configure:

```text
DATABASE_PATH=/var/data/financial_support.sqlite
SESSION_DIR=/var/data/sessions
UPLOAD_DIR=/var/data/uploads
```

Without persistent storage, application records and uploaded documents can disappear after a redeploy/restart.

### 4. Set production environment variables

At minimum:

```text
NODE_ENV=production
SESSION_SECRET=<long-random-secret>
APP_BASE_URL=https://your-real-domain.example
ADMIN_BOOTSTRAP_NAME=CCI Welfare Admin
ADMIN_BOOTSTRAP_EMAIL=<admin-email>
ADMIN_BOOTSTRAP_PASSWORD=<strong-password-12+-characters>
ADMIN_EMAIL=<admin-notification-email>
FINANCE_TEAM_NAME=CCI USA Finance Team
FINANCE_TEAM_EMAIL=<finance-email>
AUTO_ASSIGN_REVIEWERS=false
```

Configure SMTP as well:

```text
SMTP_HOST=<smtp-host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<smtp-user>
SMTP_PASS=<smtp-password-or-app-password>
MAIL_FROM=CCI America Financial Assistance <no-reply@your-domain>
```

### 5. Verify before accepting real applications

Test all of these using non-sensitive dummy information:

1. Applicant registration/login.
2. Application submission and document upload.
3. Unit Head verification for a Celeforce applicant.
4. Pastoral verification.
5. Admin adds reviewers and assigns two reviewers.
6. Reviewer receives invite.
7. Reviewer accepts invite.
8. Separate review link arrives.
9. Reviewer can open documents only through the secure review link.
10. Reviewer submits review.
11. Two completed reviews appear for Admin.
12. Admin records decision.
13. Finance receives packet and secure payment-confirmation link.
14. Finance confirms payment.
15. Applicant receives support-processed email and Decision turns complete/green in tracking.
16. Admin can send close-out immediately, or wait for the automated 3-day close-out request.

## SQLite production note

SQLite is suitable for a modest internal workflow when the app runs as one web-service instance and the database lives on persistent storage. If usage grows substantially or you plan to run multiple application instances, migrate the database layer to PostgreSQL before scaling horizontally.
