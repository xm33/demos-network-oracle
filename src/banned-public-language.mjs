// Shared §3.1 public-language ban. One pattern so the guards cannot drift.
//
// "validator-quality" (hyphenated) is the criteria page's disavowal and is not
// this phrase. Sentences that reject a banned word stay on the page; callers
// strip the allowed disavowals before testing, as public-api-v11 does.

export const BANNED_PUBLIC_LANGUAGE =
  /\b(approved|certified|trusted|recommended|safe|best|scores?|scoring|ranking|ranked|network truth|canonical truth|canonical public record|sanctions-clean|compliant|ready|validator quality)\b/i;

// Characterizing a reading. The field name validator_growth is not this list.
export const CHARACTERIZATION =
  /\b(adoption|organic demand|transactions settled|this rail is real)\b/i;

export const ALLOWED_DISAVOWALS = [
  "Neither is a score or a go/no-go.",
  "DNO informs context; it does not advise, predict, score, certify, or decide action.",
  "The Demos Network Oracle observes whether attestation authority endpoints are reachable. This is infrastructure observability, not certification. The Oracle does not verify commerce claims, certify legal compliance, or recommend transactions.",
  "never a validator-quality metric",
];

export function stripDisavowals(text) {
  let out = String(text);
  for (const phrase of ALLOWED_DISAVOWALS) out = out.split(phrase).join("");
  return out;
}

export function publicLanguageHit(text) {
  const stripped = stripDisavowals(text);
  return BANNED_PUBLIC_LANGUAGE.test(stripped) || CHARACTERIZATION.test(stripped);
}
