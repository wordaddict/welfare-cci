# v36work Test Checklist

## Login model
- [ ] Applicant can register and log in.
- [ ] Admin can log in.
- [ ] Login page shows only Applicant and Admin.
- [ ] Reviewer credentials cannot be used to log in.

## Reviewer Directory
- [ ] Admin > Reviewers opens.
- [ ] Admin can add reviewer name/email without creating a password.
- [ ] Admin can deactivate/reactivate a reviewer.
- [ ] Reviewer appears in case assignment dropdown.

## Two-link reviewer workflow
- [ ] Admin assigns reviewer.
- [ ] After pastoral verification, reviewer receives invitation link.
- [ ] Invitation page does not show full applicant details.
- [ ] Accepting invitation sends a separate secure review link.
- [ ] Reviewer does not need to log in.
- [ ] Review link shows assigned case only.
- [ ] Documents open through token-protected reviewer file route.
- [ ] Reviewer submits automated/pre-filled assessment.
- [ ] After submission the same link shows only "Review Submitted".
- [ ] Admin sees Review submitted status.

## Decline/reminder
- [ ] Decline is recorded.
- [ ] With AUTO_ASSIGN_REVIEWERS=false, Admin is notified to choose replacement.
- [ ] Reminder scheduler sends reminders to non-responding invited reviewers.

## Existing workflow regression
- [ ] Membership/MAP evidence logic works.
- [ ] Celeforce leadership verification works before pastoral verification.
- [ ] Pastoral verification works.
- [ ] Automated preliminary review remains /21.
- [ ] Admin decision works.
- [ ] Finance secure payment confirmation works.
- [ ] Applicant Decision stage becomes complete after payment confirmation.
- [ ] Applicant support email is sent after finance confirmation.
- [ ] Admin can send close-out immediately.
- [ ] Automated close-out still sends after configured delay.
