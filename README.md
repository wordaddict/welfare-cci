# CCI America Financial Assistance App - v36work

This build keeps the v35 welfare workflow and changes reviewer access for real-world online use.

## Access model

Only two roles use password login:

- Applicant
- Admin

The following roles do **not** log in:

- Reviewer
- Pastor
- MAP Leader / other verification contact
- Celeforce Unit Head
- Finance contact

They receive secure, case-specific links by email. Reviewer contact emails are stored separately from login identities, so the same real email can also belong to an Applicant/Admin account.

## Reviewer workflow

1. Admin adds reviewer name/email under **Admin > Reviewers**.
2. Admin opens a case and assigns up to two reviewers.
3. Once pastoral verification is complete, each assigned reviewer receives an invitation link.
4. The invitation page shows only limited case information.
5. If the reviewer accepts, the system generates a different secure token and emails a second review link.
6. The second link opens the confidential reviewer workspace. No account/password is required.
7. After the reviewer submits, the review link stops exposing case materials and displays a submission confirmation.
8. Admin sees reviewer invitation, acceptance, review-link, and submission status in the case file.

By default `AUTO_ASSIGN_REVIEWERS=false`, so Admin controls reviewer selection. Set it to `true` only if you want the old automatic fill/replacement behavior.

## Local setup

```bash
cp .env.example .env
npm install
npm run seed
npm start
```

Open:

```text
http://localhost:3000
```

Local test accounts created by `npm run seed`:

- Admin: `admin@cci.local` / `admin123`
- Applicant: `applicant@cci.local` / `applicant123`

No reviewer login accounts are seeded.

## Production hosting

See `DEPLOYMENT.md` before going live.

The app supports persistent paths through:

- `DATABASE_PATH`
- `SESSION_DIR`
- `UPLOAD_DIR`

This is essential because the app stores SQLite data and uploaded evidence. Do not deploy it to an ephemeral filesystem without a persistent disk/volume.

## Email

For local use, leave `SMTP_HOST` blank and email previews will print in Terminal.

For production, configure the SMTP variables in `.env.example`. Real email is required for the link-based reviewer, pastoral, leadership, finance, and close-out workflows.

## Production Admin account

On a fresh hosted database, set:

- `ADMIN_BOOTSTRAP_NAME`
- `ADMIN_BOOTSTRAP_EMAIL`
- `ADMIN_BOOTSTRAP_PASSWORD`

The bootstrap password must be at least 12 characters. The bootstrap is used only when no active Admin account exists.

## Important security notes

- Never commit `.env`, the SQLite database, uploaded evidence, or session files to GitHub.
- Use HTTPS in production.
- Use a long random `SESSION_SECRET`.
- Reviewer links are confidential bearer links. They should not be forwarded.
- Uploaded evidence is not served from a public static directory. Admin uses authenticated access; reviewers use their active case-specific review token.
# welfare-cci
