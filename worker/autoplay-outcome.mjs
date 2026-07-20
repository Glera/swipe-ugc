// Honest classification of a fixed-seed autoplay run that did not prove a WIN.
//
// The gate loop and the RESULT builder both use these exact predicates, so a
// terminal loss reached long before the deadline can never be recorded as an
// exhausted budget: 'timeout' means the run really ran out of budget without a
// terminal event, 'terminal_loss' means the playable itself reported a loss,
// and 'mixed' means the two flake-retry runs disagreed.

export const AUTOPLAY_FAILURE_KINDS = Object.freeze(['terminal_loss', 'timeout']);

function outcomeError(message) {
  const error = new Error(String(message).replace(/\s+/g, ' ').trim().slice(0, 2000));
  error.code = 'autoplay_outcome_invalid';
  return error;
}

// The single source of truth for "the playable reported a terminal loss".
// Mirrors the completion probe: a completion-like event whose success is
// explicitly false.
export function isTerminalLossEvent(event) {
  return /complet|lost|lose/i.test(String(event?.type || '')) && event?.success === false;
}

// Classifies one unproven run from the exact evidence the gate loop observed.
// A terminal loss wins over the deadline: it ended the run, the budget did not.
export function autoplayRunFailureKind({ events = [] } = {}) {
  return (Array.isArray(events) && events.some((event) => isTerminalLossEvent(event)))
    ? 'terminal_loss'
    : 'timeout';
}

// Combines per-run failure kinds into the RESULT-level outcome:
// identical kinds keep their name; two runs that disagree are 'mixed'.
export function combineAutoplayFailureKinds(kinds) {
  if (!Array.isArray(kinds) || kinds.length < 1 || kinds.length > 2
    || kinds.some((kind) => !AUTOPLAY_FAILURE_KINDS.includes(kind))) {
    throw outcomeError('autoplay failure kinds must be one or two of terminal_loss/timeout');
  }
  const unique = [...new Set(kinds)];
  return unique.length === 1 ? unique[0] : 'mixed';
}
