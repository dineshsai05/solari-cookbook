# Atherton demo evaluation notes

Checked against the captured portal text on September 29, 2026.

- The permit was found by searching the town's portal for permits applied for
  on or after June 1, 2026 and picking one still under review with pending
  rows. Two rows ("7WATER EFFIC LANDSCAPE" and "8TREE PRTECTN IN PLACE") had
  no status or completion date at capture time.
- Atherton's public detail pages return Group, Type, Status, dates and
  Reviewer but no Remarks or Notes, and the permit page lists no attachments.
  The adapter records empty notes, skips the sandbox because there is nothing
  to extract, and skips the checklist with an explanation in the report.
- The second capture, about a minute after the first, reported no change.
  A real change will show up as a `changed: true` diff on a later run.
- Reviewer names are public record on the portal. No contact details are
  captured; the Contacts tab is never opened.
