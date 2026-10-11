import { BOARDS, SESSION, type BoardId } from './config.js';

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };

/** New York weekday (0 = Sunday) and minute of day. */
export function etParts(t: number) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { wd: WD[p.weekday], min: Number(p.hour) * 60 + Number(p.minute) };
}

/** US session for HT/LT: Mon–Fri 04:00–16:00 ET (no holiday calendar). D1/D2 use open24x5. */
export function sessionOpen(t: number, mode = SESSION.mode): boolean {
  if (mode === 'always') return true;
  const { wd, min } = etParts(t);
  return wd >= 1 && wd <= 5 && min >= SESSION.openMin && min < SESSION.closeMin;
}

/** A call may not still be running into the weekend (after Friday 20:00 ET). */
export function crossesWeekend(expiresAt: number, mode = SESSION.mode): boolean {
  if (mode === 'always') return false;
  const { wd, min } = etParts(expiresAt);
  return wd === 6 || wd === 0 || (wd === 5 && min > SESSION.weekendCutoffMin);
}

export function nextOpen(t: number): number {
  let x = Math.ceil(t / 60_000) * 60_000;
  for (let i = 0; i < 4 * 24 * 4 && !sessionOpen(x); i++) x += 15 * 60_000;
  // land on the exact opening minute
  while (sessionOpen(x - 60_000)) x -= 60_000;
  return x;
}

export function humanDelta(ms: number) {
  const m = Math.round(ms / 60_000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

/** Around-the-clock weekdays: Sunday 20:00 ET (Asia open) to Friday 16:00 ET. Used by the long-term boards. */
export function open24x5(t: number, mode = SESSION.mode): boolean {
  if (mode === 'always') return true;
  const { wd, min } = etParts(t);
  return (wd >= 1 && wd <= 4) || (wd === 5 && min < SESSION.closeMin) || (wd === 0 && min >= 20 * 60);
}

/** Can a call be locked on this board at t? HT/LT follow the US session; D1/D2 are open 24/5. */
export const boardOpen = (board: BoardId, t: number, mode = SESSION.mode) =>
  BOARDS[board].group === 'long' ? open24x5(t, mode) : sessionOpen(t, mode);
export const anyOpen = (t: number, mode = SESSION.mode) => sessionOpen(t, mode) || open24x5(t, mode);

function nextWhen(t: number, f: (x: number) => boolean) {
  let x = Math.ceil(t / 60_000) * 60_000;
  for (let i = 0; i < 4 * 24 * 4 && !f(x); i++) x += 15 * 60_000;
  while (f(x - 60_000)) x -= 60_000;
  return x;
}
const nyTime = (t: number) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function sessionLine(now: number) {
  if (SESSION.mode === 'always') return '🟢 Demo mode: session calendar off';
  const us = sessionOpen(now), long = open24x5(now);
  if (us) {
    const { min } = etParts(now);
    return `🟢 Market open · HT/LT until 16:00 ET (in ${humanDelta((SESSION.closeMin - min) * 60_000)}) · D1/D2 open 24/5`;
  }
  if (long) {
    const o = nextOpen(now);
    return `🟢 D1/D2 open 24/5 · HT/LT reopen ${nyTime(o)} ET (in ${humanDelta(o - now)})`;
  }
  const o = nextWhen(now, (x) => open24x5(x));
  return `🔴 Market closed · D1/D2 reopen ${nyTime(o)} ET (in ${humanDelta(o - now)}), HT/LT at 04:00 ET Monday`;
}

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** New York calendar date (YYYY-MM-DD) of an instant. */
export function etDay(t: number): string {
  const p = Object.fromEntries(dateFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** The instant of 00:00 New York at the end of the given New York date. */
export function etDayEnd(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d + 1, 3, 0);            // 23:00 EDT / 22:00 EST: still `day` in New York
  while (etDay(t) === day) t += 3600_000;             // offsets are whole hours, so this lands on 00:00
  return t;
}

/** Is this New York date a trading day for the calendar in force? */
export function isTradingDay(day: string, mode = SESSION.mode): boolean {
  if (mode === 'always') return true;
  const [y, m, d] = day.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd >= 1 && wd <= 5;
}

export function prevTradingDay(day: string, mode = SESSION.mode): string {
  const [y, m, d] = day.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  do { t -= 86_400_000; } while (!isTradingDay(new Date(t).toISOString().slice(0, 10), mode));
  return new Date(t).toISOString().slice(0, 10);
}
