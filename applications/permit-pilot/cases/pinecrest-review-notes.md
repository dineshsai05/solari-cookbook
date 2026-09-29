# Pinecrest demo evaluation notes

Checked against the captured portal text on September 29, 2026. The
deterministic layers (review rows, verbatim notes, attachment labels, diff,
replay) matched the portal exactly. The AI-linked checklist is a draft and
these are its known soft spots:

- The applicant's answer sheet is dated to the March 2025 cycle and quotes the
  March 25 building note and March 19 zoning note. The January 8 building
  comment number 1 has the same wording, so the model marks it
  `applicant_asserted` too. That is defensible but the sheet does not name the
  January cycle; read the response as answering the March re-review.
- Only one answer sheet is in the packet. The January comments about the fence
  foundation, rolling gate, picket fence details and GFCI protection have no
  response text in the packet. `no_response_in_packet` means exactly that; the
  March 18 resubmission's revised drawings are listed but were not read.
- "S-01 Rev 2" is cited from the sheet's title block, which shows revision 2
  dated 4/7/2025. Nothing verifies what changed on the drawing.
- Later APPROVED rows in the same discipline are shown by the host as a chain.
  They are separate reviews, not proof that a specific comment was satisfied.
- The attachment timestamp hint is parsed from the portal key and corroborated
  by the three review submission dates; it is not a portal-labelled upload date.

Desktop step, verified September 29, 2026: the tracker CSV was written to a
Solari Desktop, opened in LibreOffice Calc, and screenshotted with all 17 rows
visible. The first attempt was partly covered by LibreOffice's Tip of the Day
dialog; the step now dismisses it before the screenshot.
