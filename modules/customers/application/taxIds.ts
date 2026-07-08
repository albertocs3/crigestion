const nifControlLetters = "TRWAGMYFPDXBNJZSQVHLCKE";
const cifControlLetters = "JABCDEFGHI";
const cifLetterOnlyPrefixes = new Set(["K", "L", "M", "N", "P", "Q", "R", "S", "W"]);
const cifDigitOnlyPrefixes = new Set(["A", "B", "E", "H"]);

export function isValidSpanishTaxId(value: string): boolean {
  const normalized = normalizeSpanishTaxId(value);

  return (
    isValidDni(normalized) ||
    isValidNie(normalized) ||
    isValidCif(normalized)
  );
}

export function normalizeSpanishTaxId(value: string): string {
  return value
    .trim()
    .replace(/[\s.-]/g, "")
    .toLocaleUpperCase("es-ES");
}

function isValidDni(value: string): boolean {
  if (!/^\d{8}[A-Z]$/.test(value)) {
    return false;
  }

  const number = Number(value.slice(0, 8));
  const expectedLetter = nifControlLetters[number % 23];

  return value[8] === expectedLetter;
}

function isValidNie(value: string): boolean {
  if (!/^[XYZ]\d{7}[A-Z]$/.test(value)) {
    return false;
  }

  const prefixValue = { X: "0", Y: "1", Z: "2" }[value[0]];
  const number = Number(`${prefixValue}${value.slice(1, 8)}`);
  const expectedLetter = nifControlLetters[number % 23];

  return value[8] === expectedLetter;
}

function isValidCif(value: string): boolean {
  if (!/^[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]$/.test(value)) {
    return false;
  }

  const prefix = value[0];
  const digits = value.slice(1, 8).split("").map(Number);
  const control = value[8];
  const sum = digits.reduce((total, digit, index) => {
    const position = index + 1;

    if (position % 2 === 0) {
      return total + digit;
    }

    const doubled = digit * 2;
    return total + Math.floor(doubled / 10) + (doubled % 10);
  }, 0);
  const controlDigit = (10 - (sum % 10)) % 10;
  const expectedDigit = String(controlDigit);
  const expectedLetter = cifControlLetters[controlDigit];

  if (cifLetterOnlyPrefixes.has(prefix)) {
    return control === expectedLetter;
  }

  if (cifDigitOnlyPrefixes.has(prefix)) {
    return control === expectedDigit;
  }

  return control === expectedDigit || control === expectedLetter;
}
