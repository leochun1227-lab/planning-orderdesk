// These retained Stock orders must never receive an automatic Cancellation proposal.
// Only a protection flag is exposed; the private rule list is not sent to the client.
import { createHash } from 'node:crypto';
const normalized = value => String(value || '').toUpperCase().replace(/[-\s]/g, '');
const protectedStock = new Set([
  'be968ab08924ecc69f940e49c086e662e9f3972cd9979b1e9866f171cf530018',
  '4b88ae1d228a987bf50e620b4f7ee4e9255bcd6de9af62654c05d3755c8375a1',
  'c5b74e9e9a8571f8842eb5110114e7e5e656a6b0be9af59a1bd165a83620fc27',
  '539706cc290409080d7a55db9978d6635b3f44b670d34f6432b66ea669ff3625',
  'cd1e46891a0d8d2a90210f133aef1c3066672396d2c78fecba6f13745ccef307',
  '76485a15d954ddcbe4411fbe88f5eb47ad431b99380e347ccee70fdd9b5c601d',
  '69c47d7928a9e7f2407db43239033ec8ce0c79d585f1b2becd5861abedeb1592',
  'e083a8cd26a12b22f70570d5a81b582576c0a091be8ef99f8b63a2ceb2bb02e3',
  'dbf67a1656ea9702277cff1f04c9fb723646646d1e5e6a4fe59671c67d4938d2',
  'e3cd69a8f11d65e1e829eb388463d20cc8feebc7ef233afe2327ca7803381a35',
  'e1386240884da8e23335a463cb3853a50317cfdf33a8ab991257bb6dc498e6f6',
  'c8136670eb5f60fc8f5e0c7f0bf793914f754a1223fcdb51bc73f16e6a78571d',
  '06666b33c04c69abdc0083d26d4b8234eeea28f4207ceb2bb6ae03f03a9f06ea',
  'c3980635a566ae27d42e2f0dde3b0572186708978d22ba6909279be3f1c50afa',
  '233da170faa377e381f3279d687db1d2d6bb394dca613c7394293c731bc377ab',
  '7cbd1a249d1811c0f80452c92f800c7345907db69d5bbb547b948d767294685b',
  '10d33f1822a8756bf9d3373f352be2c203db1c27b2d2c6a7711a07854460bcea',
  '61d9f89e762b69b2ae0505dfd1a45e8cbb25cc89197e7da14790b4844e988a26',
  'e75d7eb135776cfecebad09e6530ef9380e8be1fe9d460fb4047fdbaa444205b',
  'd9b11fa365d8564988fe5023948c4ce9f9a15617d32616b4a7f90beced0d4dfb',
  '18f40e6235bc3719e28115715b08b600ba577bfe34480839a8494640bd07ec66'
]);
export const createProtectionCheck = digests => value => digests.has(createHash('sha256').update(normalized(value)).digest('hex'));
const protectedCheck = createProtectionCheck(protectedStock);
export const isCancellationProtected = value => /^[A-Z]{3}[0-9]{6}$/.test(normalized(value)) && protectedCheck(value);
