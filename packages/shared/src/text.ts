const BASIC_PUNCTUATION =
  /[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\u2010-\u2015\u2018\u2019\u201c\u201d]/gu

export function normalizeFreeTextAnswer(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(BASIC_PUNCTUATION, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export interface FreeTextMatchResult {
  readonly matched: boolean
  readonly normalizedSubmission: string
  readonly matchedAcceptedAnswer?: string
}

export function matchFreeTextAnswer(
  submission: string,
  acceptedAnswers: readonly string[],
): FreeTextMatchResult {
  const normalizedSubmission = normalizeFreeTextAnswer(submission)
  if (normalizedSubmission.length === 0) {
    return { matched: false, normalizedSubmission }
  }

  for (const acceptedAnswer of acceptedAnswers) {
    if (normalizeFreeTextAnswer(acceptedAnswer) === normalizedSubmission) {
      return {
        matched: true,
        normalizedSubmission,
        matchedAcceptedAnswer: acceptedAnswer,
      }
    }
  }
  return { matched: false, normalizedSubmission }
}

export function isFreeTextAnswerMatch(
  submission: string,
  acceptedAnswers: readonly string[],
): boolean {
  return matchFreeTextAnswer(submission, acceptedAnswers).matched
}
