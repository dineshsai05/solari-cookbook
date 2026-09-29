'use strict';
const stages = [
  ['Search the public portal', 'portal-search-form.png', 'The agent enters the permit number in the city’s public search form.'],
  ['Find the matching permit', 'portal-search.png', 'The search result is checked against the requested permit before any record is read.'],
  ['Read the permit status', 'portal-permit-info.png', 'The overall status and milestones are captured separately from historical review outcomes.'],
  ['Collect departmental reviews', 'portal-reviews.png', 'Each review row is recorded with its department, dates and outcome.'],
  ['Open the reviewer’s comments', 'portal-review-detail.png', 'The original comment text becomes evidence for the report. Applicant responses remain separate assertions.'],
  ['Export a coordinator tracker', 'desktop-tracker.png', 'In this recorded run, the tracker CSV was opened in LibreOffice on a Solari Desktop. Live trials export the CSV without this optional desktop step.'],
];
const trail = document.getElementById('trail');
stages.forEach(([title, file, detail], index) => {
  const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-pressed', String(index === 0));
  const number = document.createElement('span'); number.textContent = String(index + 1); button.append(number, document.createTextNode(title));
  button.addEventListener('click', () => {
    trail.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    document.getElementById('stage-title').textContent = title; document.getElementById('stage-detail').textContent = detail;
    const image = document.getElementById('capture-image'); image.src = 'pinecrest/' + file; image.alt = title + ' — recorded Pinecrest capture';
    document.getElementById('capture-link').href = image.src;
  }); trail.append(button);
});
const liveButton = document.getElementById('live-button');
liveButton.addEventListener('click', e => { if (liveButton.getAttribute('aria-disabled') === 'true') e.preventDefault(); });
async function checkLive() {
  const status = document.getElementById('live-status'), expiry = document.getElementById('live-expiry');
  try {
    const response = await fetch('live.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('No live host configured');
    const config = await response.json(); const url = new URL(config.url);
    const expires = Date.parse(config.expiresAt);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.preview.getsolari.com') || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('Trial host has expired');
    const health = new URL(url); health.pathname = '/healthz';
    const healthResponse = await fetch(health, { signal: AbortSignal.timeout(8000), credentials: 'omit' });
    if (!healthResponse.ok) throw new Error('Live host unavailable');
    const state = await healthResponse.json(); if (!state.ok || !state.live) throw new Error('Live captures paused');
    status.textContent = 'Live trial available · Pinecrest and Atherton'; liveButton.textContent = 'Open the live trial ↗';
    liveButton.href = url.href; liveButton.target = '_blank'; liveButton.rel = 'noopener'; liveButton.setAttribute('aria-disabled', 'false');
    expiry.textContent = 'Temporary trial host available until ' + new Date(expires).toLocaleString() + '. Download results before it expires. Up to ' + state.dailyLimit + ' runs per day across this host.';
  } catch {
    status.textContent = 'The live trial is currently offline.'; liveButton.textContent = 'Explore the recorded example';
    liveButton.href = '#explore'; liveButton.removeAttribute('target'); liveButton.setAttribute('aria-disabled', 'false');
    expiry.textContent = 'The full example report, walkthrough and downloads remain available. Contact Dinesh using the feedback link to arrange a fresh capture.';
  }
}
checkLive();
