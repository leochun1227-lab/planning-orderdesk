// Receive window (2026-11-06): the nightly report arrives in the Inbox around 00:05 and may not be
// moved to the CRM Report folder yet, so the reader looks in both. Only mail received from 00:00
// Sydney of the scan day up to the scan time counts (00:00-00:20 for the nightly run); the window
// is never longer than 30 minutes, so a manual verification during the day still sees only the
// last 30 minutes and never an old report.
export const MAIL_WINDOW_MS=30*60*1000;
const sydneyParts=date=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
function sydneyOffsetMs(date){const p=sydneyParts(date);return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(date.getTime()/1000)*1000;}
/** 00:00 Australia/Sydney of the Sydney day containing `date`. */
export function sydneyMidnight(date=new Date()){
  const p=sydneyParts(date),local=Date.UTC(+p.year,+p.month-1,+p.day);
  let t=local-sydneyOffsetMs(date);t=local-sydneyOffsetMs(new Date(t));
  return new Date(t);
}
/** Window for a scan ending at `end`: from Sydney midnight, at most 30 minutes. */
export function mailWindow(end=new Date()){
  const start=new Date(Math.max(sydneyMidnight(end).getTime(),end.getTime()-MAIL_WINDOW_MS));
  return {windowStartUtc:start.toISOString(),windowEndUtc:end.toISOString()};
}
/** The nightly task runs at 00:20; a start delayed by a few minutes (computer waking) still counts. */
export function isScheduledMinute(date=new Date()){
  const p=sydneyParts(date);
  return p.hour==='00'&&+p.minute>=20&&+p.minute<=29;
}
export function isFreshMail(receivedAt,start,end){
  const value=Date.parse(receivedAt),lower=Date.parse(start),upper=Date.parse(end);
  if(!Number.isFinite(value)||!Number.isFinite(lower)||!Number.isFinite(upper))return false;
  return lower===Date.parse(mailWindow(new Date(upper)).windowStartUtc)&&value>=lower&&value<=upper;
}
