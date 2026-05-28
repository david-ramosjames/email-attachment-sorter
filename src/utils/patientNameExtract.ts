/** Tokens from a person's name for case/folder matching (e.g. Galeas, Montoya, Lourdes). */
export function tokensFromPersonName(fullName: string): string[] {
  return [
    ...new Set(
      fullName
        .toLowerCase()
        .replace(/[^a-z\s'-]/g, ' ')
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3)
    ),
  ];
}

/**
 * Extract patient/client names from email body or PDF text.
 * Handles ProCare-style emails and affidavit headers.
 */
export function extractPatientNamesFromText(text: string): string[] {
  const names: string[] = [];
  const add = (raw: string) => {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 4 && /[A-Za-z]/.test(cleaned)) {
      names.push(cleaned);
    }
  };

  for (const m of text.matchAll(/Patient:\s*([A-Za-z][A-Za-z\s.'-]{2,80})/gi)) {
    add(m[1]);
  }

  const attachedAre = text.match(
    /Attached are\s+(.+?)\s+records?\s+and\s+billing/i
  );
  if (attachedAre) add(attachedAre[1]);

  const pleaseFind = text.match(
    /Please find attached\s+(.+?)(?:'s)?\s+(?:records?|billing)/i
  );
  if (pleaseFind) add(pleaseFind[1]);

  const recordsFor = text.match(
    /records?\s+(?:for|of)\s+([A-Za-z][A-Za-z\s.'-]{4,60})/i
  );
  if (recordsFor) add(recordsFor[1]);

  const representsPi = text.match(
    /represents\s+([A-Za-z][A-Za-z\s.'-]{4,80}?)\s+in\s+a\s+personal\s+injury/i
  );
  if (representsPi) add(representsPi[1]);

  const employeeRequest = text.match(
    /Employee Records Request\s*[-–:]\s*([A-Za-z][A-Za-z\s.'-]{4,60})/i
  );
  if (employeeRequest) add(employeeRequest[1]);

  const employmentOf = text.match(
    /employment\s+of\s+([A-Z][A-Za-z\s.'-]{4,60})/i
  );
  if (employmentOf) add(employmentOf[1]);

  const printedName = text.match(
    /([A-Z][A-Z\s.'-]{6,50})\s*\n\s*\(Printed Name of Signature\)/i
  );
  if (printedName) add(printedName[1]);

  return [...new Set(names)];
}

export function allPatientNameTokens(names: string[]): string[] {
  const tokens = new Set<string>();
  for (const name of names) {
    for (const t of tokensFromPersonName(name)) {
      tokens.add(t);
    }
  }
  return [...tokens];
}
