export function normalizeDateInputValue(value: FormDataEntryValue | null): string {
  const text = String(value ?? "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const spanishDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);

  if (spanishDate) {
    const [, day, month, year] = spanishDate;

    return `${year}-${month}-${day}`;
  }

  return text;
}
