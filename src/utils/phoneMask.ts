/**
 * Remove phone/fax numbers from text before matching RJL case numbers.
 * Prevents area codes (e.g. 512 from 512-253-4512) matching case_number "512".
 */
export function maskPhoneAndFaxNumbers(text: string): string {
  return (
    text
      // US phones: (512) 253-4512, 512-253-4512, 512.253.4512, +1-512-253-4512
      .replace(
        /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s/.]?\d{3}[-.\s/.]?\d{4}\b/g,
        ' '
      )
      // Toll-free / fax IDs: +8007764737, 8007764737
      .replace(/\+?\d{10,}\b/g, ' ')
      // Remaining dashed 10-digit groups
      .replace(/\b\d{3}[-\s/.]\d{3}[-\s/.]\d{4}\b/g, ' ')
  );
}

/** True if string is only digits and looks like a phone/fax id (not a case number). */
export function isPhoneLikeNumber(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  if (value.length >= 10) return true;
  if (value.length === 7) return true;
  return false;
}
