// Build the customer requirement from vehicles actually scheduled. Carry the
// fractional requirement through Stock places across week and month boundaries.
const numberOf = d => Date.parse(d) / 86400000;
const dateOf = n => new Date(n * 86400000).toISOString().slice(0, 10);
const percentOf = (c, s) => c + s ? Math.round(c / (c + s) * 10000) / 100 : null;

export function mixCustomersWithStock(plan, stock, candidates) {
  const reserved = plan.rows.map(r => ({ day: r.plannedAu, slotOrder: r.slotOrder }));
  const booked = new Set(stock.map(r => r.slotOrder));
  const allPlaces = [...reserved, ...plan.stockPlaces].sort((a, b) => a.slotOrder - b.slotOrder);
  const stockDays = new Set(stock.map(r => r.plannedAu));
  const free = allPlaces.filter(p => !booked.has(p.slotOrder));
  const target = [];
  if (plan.percent === 100) target.push(...reserved);
  else if (plan.percent > 0 && stock.length) {
    const factor = plan.percent / (100 - plan.percent), occupied = new Set();
    const chronological = [...stock].sort((a, b) => a.slotOrder - b.slotOrder);
    const days = new Map();
    for (const p of free) { if (!days.has(p.day)) days.set(p.day, []); days.get(p.day).push(p); }
    const monthPlaces = new Map();
    for (const p of free) {
      const month = p.day.slice(0, 7);
      if (!monthPlaces.has(month)) monthPlaces.set(month, []);
      monthPlaces.get(month).push(p);
    }
    // Fill on the matching Stock day first. When integer capacity is tight
    // use nearby production places, without shifting demand to another month.
    const pending = [];
    function reserve(anchor, choices) {
      let best, distance = Infinity;
      for (const p of choices) {
        if (occupied.has(p.slotOrder)) continue;
        const delta = Math.abs(p.slotOrder - anchor.slotOrder);
        if (delta < distance) { best = p; distance = delta; }
      }
      if (!best) return false;
      occupied.add(best.slotOrder); target.push(best);
      return true;
    }
    const stockMonths = new Map();
    for (const r of chronological) {
      const month = r.plannedAu.slice(0, 7);
      if (!stockMonths.has(month)) stockMonths.set(month, []);
      stockMonths.get(month).push(r);
    }
    for (const [month, orders] of stockMonths) {
      const stockCount = orders.length;
      const low = Math.floor(stockCount * factor), high = low + 1;
      const difference = n => Math.abs(n / (stockCount + n) - plan.percent / 100);
      const customerCount = Math.min(monthPlaces.get(month)?.length || 0, difference(low) <= difference(high) ? low : high);
      orders.forEach((r, index) => {
        const needed = Math.round((index + 1) * customerCount / stockCount) - Math.round(index * customerCount / stockCount);
        for (let i = 0; i < needed; i++) if (!reserve(r, days.get(r.plannedAu) || [])) pending.push(r);
      });
    }
    // Where a day is full, choose the free date that reduces the combined
    // squared unit error across affected rolling 7- and 30-day windows.
    const residual = new Map();
    const share = plan.percent / 100;
    function addResidual(day, value) {
      const n = numberOf(day);
      residual.set(n, (residual.get(n) || 0) + value);
    }
    for (const r of stock) addResidual(r.plannedAu, -share);
    for (const p of target) addResidual(p.day, 1 - share);
    function errorChange(day) {
      const n = numberOf(day);
      let score = 0;
      for (let delta = -29; delta <= 29; delta++) {
        const distance = Math.abs(delta);
        const windows = Math.max(0, 7 - distance) / 7 + (30 - distance) / 30;
        score += windows * (residual.get(n + delta) || 0);
      }
      return score;
    }
    for (const r of pending) {
      const pool = monthPlaces.get(r.plannedAu.slice(0, 7)) || [];
      const nearby = [...new Set(pool.filter(p => !occupied.has(p.slotOrder) && Math.abs(numberOf(p.day) - numberOf(r.plannedAu)) <= 6).map(p => p.day))];
      const ranked = nearby.map(day => ({ day, error: errorChange(day) })).sort((a, b) => a.error - b.error || Number(stockDays.has(b.day)) - Number(stockDays.has(a.day)) || Math.abs(numberOf(a.day) - numberOf(r.plannedAu)) - Math.abs(numberOf(b.day) - numberOf(r.plannedAu)));
      if (ranked.length && reserve(r, days.get(ranked[0].day))) addResidual(ranked[0].day, 1 - share);
    }
    // Month rounding can leave a cross-month window more than one whole
    // customer from target. Move customer places within their own month,
    // keeping the Stock dates and monthly quantity exactly as reviewed.
    const windows = [7, 30].map(length => {
      const errors = new Map();
      for (const [day, value] of residual) for (let i = 0; i < length; i++) errors.set(day + i, (errors.get(day + i) || 0) + value);
      return { length, errors };
    });
    const penalty = value => Math.max(0, Math.abs(value) - 1) ** 2;
    function deltaCost(from, to, apply = false) {
      let difference = 0;
      for (const { length, errors } of windows) {
        const distance = Math.min(Math.abs(from - to), length);
        const left = Math.min(from, to), right = Math.max(from, to, left + length);
        const change = (from < to ? -1 : 1) * (1 - share);
        for (let i = 0; i < distance; i++) {
          for (const [day, delta] of [[left + i, change], [right + i, -change]]) {
            const before = errors.get(day) || 0, after = before + delta;
            difference += penalty(after) - penalty(before);
            if (apply) errors.set(day, after);
          }
        }
      }
      return difference;
    }
    while (windows.some(w => [...w.errors.values()].some(value => Math.abs(value) > 1 + 1e-8))) {
      let best = null, bestCost = -1e-10;
      const occupiedDays = new Map(target.map((p, i) => [p.day, i]));
      for (const [from, i] of occupiedDays) for (const [to, places] of days) {
        if (from === to || from.slice(0, 7) !== to.slice(0, 7) || !stockDays.has(to)) continue;
        const replacement = places.find(p => !occupied.has(p.slotOrder));
        if (!replacement) continue;
        const cost = deltaCost(numberOf(from), numberOf(to));
        if (cost < bestCost) { bestCost = cost; best = { from, to, i, replacement }; }
      }
      if (!best) break;
      deltaCost(numberOf(best.from), numberOf(best.to), true);
      occupied.delete(target[best.i].slotOrder);
      occupied.add(best.replacement.slotOrder);
      target[best.i] = best.replacement;
    }
  }
  target.sort((a, b) => a.slotOrder - b.slotOrder);
  const available = candidates.filter(r => target.length && r.ready <= target.at(-1).day);
  const supply = Math.min(target.length, available.length), used = new Set(), assigned = new Map();
  target.forEach((place, i) => {
    if (used.size >= Math.round((i + 1) * supply / target.length)) return;
    const r = available.find(r => !used.has(r.chassis) && r.ready <= place.day);
    if (r) { assigned.set(place.slotOrder, r); used.add(r.chassis); }
  });
  // Preserve feasible early orders if late customer readiness left gaps.
  for (const r of available) if (!used.has(r.chassis)) {
    const place = target.findLast(p => !assigned.has(p.slotOrder) && r.ready <= p.day);
    if (place) { assigned.set(place.slotOrder, r); used.add(r.chassis); }
  }
  const rows = target.map(({ day, slotOrder }) => {
    const r = assigned.get(slotOrder);
    return { slotId: 'customer-place-' + slotOrder, slotOrder, chassis: r?.chassis || '', model: r?.model || '', modelYear: String(r?.modelYear || ''), customer: r?.customer || '',
      kind: r ? 'customer' : 'customer-gap', group: r?.group || 'customers', from: r?.slug || '', to: r?.slug || '', originalDealer: r?.dealer || '', proposedDealer: r?.dealer || '',
      originalAu: r?.auEnd || '', plannedAu: day, simulatedAu: day, plannedArrival: '', signedAt: r?.signedAt, ready: r?.ready, receive: true, reallocated: false, action: r ? 'customer' : 'waitingCustomer' };
  });
  const daily = new Map();
  const get = day => { if (!daily.has(day)) daily.set(day, { stock: 0, customers: 0, waiting: 0 }); return daily.get(day); };
  for (const r of stock) get(r.plannedAu).stock++;
  for (const r of rows) get(r.plannedAu)[r.kind === 'customer' ? 'customers' : 'waiting']++;
  function sum(start, end) {
    let stock = 0, customers = 0, waiting = 0;
    for (const [day, d] of daily) if (day >= start && day <= end) { stock += d.stock; customers += d.customers; waiting += d.waiting; }
    return { stock, customers, waiting, actualPercent: percentOf(customers, stock), reservedPercent: percentOf(customers + waiting, stock) };
  }
  const quota = (q, start, end) => {
    const { stock, customers, waiting } = sum(start, end);
    return { ...q, capacity: q.slots, slots: stock + customers + waiting, stockSlots: stock, customerSlots: customers + waiting, customerOrders: customers, waiting };
  };
  const rolling = [];
  if (allPlaces.length) for (let n = numberOf(allPlaces[0].day); n <= numberOf(allPlaces.at(-1).day); n++) {
    const day = dateOf(n);
    rolling.push({ day, seven: sum(dateOf(n - 6), day), thirty: sum(dateOf(n - 29), day) });
  }
  const plannedStockPlaces = plan.stockPlaces.filter(p => booked.has(p.slotOrder));
  return { ...plan, rows, stockPlaces: plannedStockPlaces, stockSlots: plannedStockPlaces.map(p => p.day), weeks: plan.weeks.map(q => quota(q, q.week, dateOf(numberOf(q.week) + 6))),
    months: plan.months.map(q => quota(q, q.month + '-01', q.month + '-31')), rolling,
    unplanned: candidates.filter(r => !used.has(r.chassis)).map(r => ({ chassis: r.chassis, modelYear: r.modelYear, group: r.group, customer: r.customer })) };
}
