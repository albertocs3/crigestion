export function normalizeDateInputValue(value: FormDataEntryValue | null): string {
  const text = String(value ?? "").trim().replace(/[\u200e\u200f]/g, "");

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return text.slice(0, 10);
  }

  const spanishDate = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);

  if (spanishDate) {
    const [, day, month, year] = spanishDate;

    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return text;
}
