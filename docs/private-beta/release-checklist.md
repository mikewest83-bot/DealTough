# DealTough Tester Invite Checklist

For the owner, before inviting testers. Ticking a box here is a note to yourself, not
proof that the step was done.

## Product

- [ ] `https://dealtoughai.com/health` returns `ok: true` and the expected engine version.
- [ ] The latest Railway deployment of the `dealtough` service is SUCCESS.
- [ ] Paste Listing, Manual Entry, and Sell Something each run end to end on a real item.
- [ ] A vehicle listing with a VIN returns a result for the correct year, make, and model.
- [ ] `known-limitations.md` still matches how the product behaves.

## Tester access

- [ ] Each tester's exact email is added to `TESTER_EMAILS` on the Railway `dealtough`
      service.
- [ ] Each tester has signed up with that same email and sees the Plus allowance.
- [ ] Testers have been told the site is public and that their analyses are saved to
      their account.

## Privacy

- [ ] Testers are told not to paste passwords, payment details, or other people's
      personal information.
- [ ] Feedback and screenshots are checked for personal data before they are shared.
- [ ] No credentials or `.env` contents appear in any document, issue, or log excerpt.

## Running the test

- [ ] Testers have the tester guide and the feedback template.
- [ ] There is one place for testers to send feedback and report problems.
- [ ] The number of testers and the end date are set.
- [ ] What counts as success, and what would make you stop, is written down.

## Ending the test

- [ ] Remove testers from `TESTER_EMAILS` when the test ends. This is a variable change
      and takes effect without a redeploy; their accounts return to the free allowance.
