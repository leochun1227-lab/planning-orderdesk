export const MAIL_WINDOW_MS=30*60*1000;
export function isScheduledMinute(date=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  return parts.hour==='00'&&parts.minute==='20';
}
export function isFreshMail(receivedAt,start,end){
  const value=Date.parse(receivedAt),lower=Date.parse(start),upper=Date.parse(end);
  return Number.isFinite(value)&&Number.isFinite(lower)&&Number.isFinite(upper)&&upper-lower===MAIL_WINDOW_MS&&value>=lower&&value<=upper;
}
