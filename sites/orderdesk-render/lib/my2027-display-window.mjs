// A model counts only while at least one whole MY2027 Stock unit is projected
// on the yard. Use the dealer's handover mix, consuming older units first.
export const displayWindow = { start: '2027-03-31', end: '2027-04-07', followUp: '2027-04-30' };
const dayNumber = day => Math.floor(Date.parse(day) / 86400000);
const modelKey = name => String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');

export function dealerDisplayWindow(settings, yard, handovers, today) {
  if (settings.slug === 'traralgon' || today > displayWindow.followUp) return null;
  const models = settings.models.filter(m => /^(SRC|SRP)/.test(m));
  const start = dayNumber(today), opening = Math.max(start, dayNumber(displayWindow.start)), closing = Math.max(start, dayNumber(displayWindow.end)), followUp = dayNumber(displayWindow.followUp);
  const shares = new Map();
  for (const [name, count] of Object.entries(handovers || {})) {
    const k = modelKey(name);
    shares.set(k, (shares.get(k) || 0) + Math.max(0, Number(count) || 0));
  }
  const total = [...shares.values()].reduce((sum, n) => sum + n, 0);
  const ledger = new Map(models.map(m => [m, { rates: settings.weeklyStock / 7 * (total ? (shares.get(m) || 0) / total : 1 / Math.max(1, settings.models.length)), days: new Map(), cache: new Map() }]));
  function add(vehicle, day, quantity = 1) {
    const book = ledger.get(modelKey(vehicle.model));
    if (!book || !day || day > displayWindow.followUp) return;
    const when = Math.max(start, dayNumber(day)), values = book.days.get(when) || [0, 0];
    values[String(vehicle.modelYear) === '2027' ? 1 : 0] += quantity;
    if (values[0] || values[1]) book.days.set(when, values);
    else book.days.delete(when);
    book.cache.clear();
  }
  for (const v of yard) add(v, today);

  function projection(book, extraDay = 0) {
    if (book.cache.has(extraDay)) return book.cache.get(extraDay);
    const days = new Set([...book.days.keys(), opening, closing, followUp]);
    if (extraDay) days.add(extraDay);
    let older = 0, current = 0, previous = start - 1, openingQty = 0, closingQty = 0;
    const demandThrough = day => Math.floor((day - start + 1) * book.rates + 1e-9);
    function sell(count) {
      const oldSold = Math.min(older, count);
      older -= oldSold;
      current = Math.max(0, current - (count - oldSold));
    }
    for (const when of [...days].sort((a, b) => a - b)) {
      sell(demandThrough(when - 1) - demandThrough(previous));
      const [oldIn, newIn] = book.days.get(when) || [0, 0];
      older += oldIn;
      current += newIn + Number(when === extraDay);
      sell(demandThrough(when) - demandThrough(when - 1));
      if (when === opening) openingQty = current;
      if (when === closing) closingQty = current;
      previous = when;
    }
    const result = { opening: openingQty, closing: closingQty, april: current };
    book.cache.set(extraDay, result);
    return result;
  }
  return {
    add,
    gain(vehicle, arrival) {
      if (String(vehicle.modelYear) !== '2027' || !arrival || arrival > displayWindow.followUp) return 0;
      const book = ledger.get(modelKey(vehicle.model));
      if (!book) return 0;
      const before = projection(book);
      if (before.closing && before.opening && before.april) return 0;
      const after = projection(book, Math.max(start, dayNumber(arrival)));
      return 4 * Number(!before.closing && after.closing > 0) + 2 * Number(!before.opening && after.opening > 0) + Number(!before.april && after.april > 0);
    },
    report() {
      const counts = models.map(model => ({ model, ...projection(ledger.get(model)) }));
      return { ...displayWindow, target: models.length, atStart: counts.filter(r => r.opening > 0).length, atEnd: counts.filter(r => r.closing > 0).length,
        inApril: counts.filter(r => r.april > 0).length, missing: counts.filter(r => !r.closing).map(r => r.model), models: counts };
    },
  };
}
