import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopClient } from '@solarisdk/desktop';
import type { Snapshot } from './portal-snapshot.js';
import type { PortalAnalysisResult } from './portal-analysis.js';

// Many permit coordinators track cases in a spreadsheet. This step writes the
// snapshot into a CSV on a Solari Desktop, opens it in LibreOffice Calc on the
// real screen, and keeps a screenshot as evidence. The desktop is destroyed
// afterwards. It receives the tracker file only, never API keys.

const cell = (v: unknown) => { const raw = String(v ?? ''); const s = /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function trackerCsv(snapshot: Snapshot, analysis: PortalAnalysisResult | null): string {
  const header = ['permit', 'overall_status', 'review', 'reviewer', 'outcome', 'submitted', 'completed', 'due', 'has_notes', 'response_in_packet', 'captured_at'];
  const rows = snapshot.reviews.map(r => {
    const item = analysis?.items.find(i => i.reviewRecordId === r.recordId);
    return [snapshot.permitNumber, snapshot.permit.status, r.type, r.reviewer, r.status, r.submitted, r.completed, r.dueDate, r.notes.trim() ? 'yes' : 'no', item ? item.responseStatus : '', snapshot.capturedAt];
  });
  return [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export async function updateTrackerOnDesktop(apiKey: string, csv: string, out: string, event: (name: string, detail?: unknown) => Promise<void>) {
  const client = new DesktopClient({ apiKey, baseUrl: 'https://api.getsolari.com', callTimeoutMs: 180_000 });
  const desktop = await client.create({ template: 'default', resolution: '1280x720', timeoutMs: 5 * 60_000 });
  await event('desktop_created', { id: desktop.sessionId, streamUrl: desktop.streamUrl });
  let app = 'libreoffice';
  try {
    await desktop.connect();
    for (let i = 0; i < 30; i++) { if ((await desktop.health()).ready) break; await new Promise(r => setTimeout(r, 1000)); }
    const dir = '/tmp/permit-pilot'; const path = `${dir}/tracker.csv`;
    await desktop.fs.mkdir(dir).catch(() => undefined);
    await desktop.fs.write(path, csv);
    const check = await desktop.exec('wc', { args: ['-l', path], timeoutMs: 30_000 });
    if (check.exitCode !== 0) throw new Error('Tracker file was not written on the desktop');
    await event('desktop_tracker_written', { lines: Number(check.stdout.trim().split(/\s+/)[0]) });
    try {
      await desktop.open('libreoffice', ['--calc', '--norestore', path]);
      await new Promise(r => setTimeout(r, 12_000));
      // LibreOffice shows its Text Import dialog for CSV files; the defaults are right.
      await desktop.keyboard.press('Return');
      await new Promise(r => setTimeout(r, 6_000));
      // First launch also shows a Tip of the Day dialog over the sheet.
      await desktop.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 2_000));
    } catch {
      app = 'mousepad';
      await desktop.open('mousepad', [path]);
      await new Promise(r => setTimeout(r, 6_000));
    }
    const shot = await desktop.screenshot({ format: 'png' });
    await writeFile(join(out, 'desktop-tracker.png'), shot);
    await event('desktop_tracker_opened', { app, screenshotBytes: shot.length });
    return { app, screenshot: 'desktop-tracker.png' };
  } finally {
    // kill() releases the machine; destroy() is the belt to that suspenders.
    try { await desktop.kill(); } catch { /* fall through to destroy */ }
    await client.destroy(desktop.sessionId).catch(() => undefined);
    await event('desktop_destroyed');
  }
}
