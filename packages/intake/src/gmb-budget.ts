/** GMB review text we want to feed into prompts while respecting token budgets. */
export interface ReviewForBudget {
  text?: { text?: string } | null;
}

export interface ReviewBudget {
  maxReviews: number;
  maxChars: number;
}

/**
 * Keep full review text for as many reviews as fit under the character ceiling.
 * Reviews are selected in input order; if a review's text would push the total
 * over the ceiling it is dropped rather than truncated, because truncating a
 * testimonial mid-sentence produces misleading signal. Logs when reviews are
 * skipped so we can tune budgets from real data.
 */
export function budgetGmbReviews<T extends ReviewForBudget>(
  reviews: T[] | undefined,
  budget: ReviewBudget,
): T[] {
  if (!reviews || reviews.length === 0) return [];
  const selected: T[] = [];
  let chars = 0;
  for (const review of reviews.slice(0, budget.maxReviews)) {
    const text = review.text?.text ?? "";
    if (chars + text.length > budget.maxChars && selected.length > 0) {
      console.log(
        `[intake] GMB review budget: stopped after ${selected.length} reviews (${chars} chars); ${reviews.length - selected.length} remaining`,
      );
      break;
    }
    selected.push(review);
    chars += text.length;
  }
  return selected;
}
