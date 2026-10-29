// Compare decimal values without first rounding the source through a JS Number.
function decimalValue(source: string) {
  const [mantissa, exponent = '0'] = source.toLowerCase().split('e');
  const [integer, fraction = ''] = mantissa!.split('.');
  const sign = integer!.startsWith('-') ? '-' : '';
  const digits = (integer!.replace('-', '') + fraction).replace(/^0+/, '');
  if (!digits) return `${sign}0`;
  const coefficient = digits.replace(/0+$/, '');
  const scale =
    BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
  return `${sign}${coefficient}e${scale}`;
}

export function jsonNumberRoundtrips(value: number, source: string) {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    return false;
  return decimalValue(source) === decimalValue(JSON.stringify(value));
}
