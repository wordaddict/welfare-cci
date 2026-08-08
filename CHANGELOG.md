# Changelog

## v36work

- Only Applicant and Admin use password login.
- Added Admin Reviewer Directory with name/email contacts and activation controls.
- Reviewer contacts are stored as non-login identities; their real email can also belong to an Applicant/Admin account.
- Admin manually assigns reviewers to a case.
- Reviewer invitation is now a first secure link with limited case information.
- Accepting an invitation sends a separate secure review link.
- Review link opens one assigned case only and does not require a password.
- Reviewer document access is protected by the active case-specific review token.
- After review submission, the review link no longer exposes case materials.
- Admin can resend invitation/review links or remove an incomplete assignment.
- Reviewer declines/expired invitations notify Admin when automatic assignment is disabled.
- Admin is notified after two independent reviews are completed.
- Added production storage environment variables for SQLite, sessions, and uploads.
- Added production Admin bootstrap settings.
- Added /health endpoint, secure production session requirements, origin validation, and login throttling.
- Added Dockerfile, render.yaml, deployment guide, and GitHub-safe .gitignore.
