// Colour rules of Planning Schedule 2025 (4) › Orderlist, reproduced from its conditional
// formatting (priority order, stopIfTrue respected). Pure functions shared by the web
// schedule view and the tests.

export const DEALER_COLORS = {
  'slacks creek': ['#92D050', '#000'], 'snowy stock': ['#00B0F0', '#000'], 'newcastle caravans': ['#FF7C80', '#000'],
  'newcastle caravans & rv': ['#FF7C80', '#000'], bundaberg: ['#009999', '#fff'], gympie: ['#156082', '#fff'],
  geelong: ['#96DCF8', '#000'], 'destiny rv': ['#F6C6AD', '#000'], 'green show': ['#D9F2D0', '#000'],
  warrnambool: ['#4D4D4D', '#fff'], dario: ['#FF00FF', '#000'], 'newcastle rv': ['#0D0D0D', '#fff'],
  toowoomba: ['#A50021', '#fff'], launceston: ['#CCCCFF', '#000'], heatherbrae: ['#FFDF79', '#000'],
  vanari: ['#0070C0', '#fff'], abco: ['#FF0000', '#fff'], frankston: ['#FF9933', '#000'],
  'cmg campers': ['#F2CFEE', '#000'], bendigo: ['#7030A0', '#fff'], 'forest glen': ['#00B050', '#000'],
  townsville: ['#80350E', '#fff'], 'st james': ['#BFBFBF', '#000'], traralgon: ['#3ED2B9', '#000'],
  auswide: ['#FFFF00', '#000'], wangaratta: ['#99FF66', '#000'], 'caravans wa': [null, '#50164A'],
};
export function dealerColor(dealer) {
  const c = DEALER_COLORS[String(dealer || '').trim().toLowerCase()];
  return c ? { background: c[0], color: c[1] } : null;
}

// Column A alert colours, highest priority first.
export const ALERTS = {
  greyNoRequest: { bg: '#808080', fg: '#fff', zh: '已签字未发 PO（无交付日期客户车，100 周内）', en: 'Signed, PO not sent (customer, no request date, <100 wks)' },
  grey: { bg: '#808080', fg: '#fff', zh: '已签字未发 PO（25 周内）', en: 'Signed, PO not sent (<25 wks)' },
  peach: { bg: '#FBE3D6', fg: '#000', zh: '未发 Longtree 且未发图（25 周内）', en: 'Not sent to Longtree, no plans (<25 wks)' },
  red: { bg: '#FF0000', fg: '#fff', zh: '空位未填订单（21 周内）', en: 'Empty slot (<21 wks)' },
  yellow: { bg: '#FFFF00', fg: '#000', zh: '已发 Longtree，图纸未发经销商（26 周内）', en: 'Plans not sent to dealer (<26 wks)' },
  blue: { bg: '#0070C0', fg: '#fff', zh: '图纸 Waiting，等待签字（26 周内）', en: 'Plans waiting, awaiting signature (<26 wks)' },
  lightBlue: { bg: '#00B0F0', fg: '#fff', zh: '已发图，等待签字（26 周内）', en: 'Plans sent, awaiting signature (<26 wks)' },
  green: { bg: '#92D050', fg: '#fff', zh: '已签字，Price Date 为 No（22 周内）', en: 'Signed, price date No (<22 wks)' },
};

const DAY = 86400000;
const serial = iso => Date.parse(iso + 'T00:00:00Z') / DAY;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Excel-like cell values of one schedule row ("No" for an order's missing milestone). */
export function excelCells({ forecastDate, order }) {
  const no = v => (v === null || v === undefined || v === '' ? 'No' : v);
  if (!order) return { A: forecastDate, B: '', D: '', J: '', K: '', L: '', M: '', N: '', O: '', P: '' };
  return {
    A: forecastDate, B: order.requestDate === 'ASAP' ? '' : order.requestDate ?? '', D: order.productionStatus || '',
    J: order.customer || '', K: no(order.receivedAt), L: no(order.sentLongtreeAt), M: no(order.specAt),
    N: no(order.signedAt), O: no(order.purchaseAt), P: order.priceVersion ?? '',
  };
}

/** Which ALERTS key colours column A (null = none). `today` is a Sydney YYYY-MM-DD. */
export function alertFor(cells, today) {
  if (!isDate(cells.A)) return null;
  const t = serial(today), a = serial(cells.A);
  const monday = t - ((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7);   // TODAY()-WEEKDAY(TODAY(),3)
  const weeks = (a - monday) / 7;
  const s = v => String(v ?? '');
  const B = s(cells.B);
  const noRequestDate = !/fixed/i.test(B) && !/[\/0-9]/.test(B);
  if (weeks < 100 && s(cells.N) !== 'No' && s(cells.O) === 'No' && s(cells.J).slice(-5).toLowerCase() !== 'stock' && noRequestDate) return 'greyNoRequest';
  if (weeks < 25 && s(cells.N) !== 'No' && s(cells.O) === 'No') return 'grey';
  if (weeks < 25 && s(cells.L) === 'No' && s(cells.M) === 'No') return 'peach';
  if ((a - t) / 7 < 21 && s(cells.K) === '') return 'red';
  if (weeks < 26 && s(cells.M) === 'No' && s(cells.L) !== 'No') return 'yellow';
  if (weeks < 26 && s(cells.M) === 'Waiting' && s(cells.N) === 'No') return 'blue';
  if (weeks < 26 && s(cells.M) !== 'No' && s(cells.N) === 'No') return 'lightBlue';
  if (weeks < 22 && s(cells.N) !== 'No' && s(cells.P) === 'No') return 'green';
  return null;
}

/** Yellow bold row highlight: due within 110 days, not signed, has a request date. */
export function dueUnsigned(cells, today) {
  return isDate(cells.A) && serial(cells.A) <= serial(today) + 110 && cells.N === 'No' && String(cells.B ?? '') !== '';
}

/** Request date far from forecast while Longtree production has started (B column). */
export function requestMismatch(cells) {
  if (cells.D !== 'Production Commenced Longtree' || !isDate(cells.B) || !isDate(cells.A)) return false;
  return Math.abs(serial(cells.B) - serial(cells.A)) >= 45;
}
