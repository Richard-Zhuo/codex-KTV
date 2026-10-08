// Safe V06 live observations on 2026-10-08 established seconds, not an official
// provider guarantee. Bound dispatch/processing/read delay and integer rounding.
export const KTVSKY_COUNTDOWN_TOLERANCE_SECONDS=10;
export function verifyRemainingCountdown({requestedCountdownSeconds,sentAt,observedAt,
  remainingCountdownSeconds,previousObservation}={}) {
  if(typeof sentAt!=='string'||typeof observedAt!=='string'||sentAt.length>32||observedAt.length>32)return false;
  const sent=Date.parse(sentAt),observed=Date.parse(observedAt);
  if(!Number.isSafeInteger(requestedCountdownSeconds)||requestedCountdownSeconds<=0||
      !Number.isSafeInteger(remainingCountdownSeconds)||remainingCountdownSeconds<=0||
      remainingCountdownSeconds>requestedCountdownSeconds||!Number.isFinite(sent)||
      !Number.isFinite(observed)||observed<sent)return false;
  const elapsed=(observed-sent)/1000;
  if(Math.abs(remainingCountdownSeconds-(requestedCountdownSeconds-elapsed))>
      KTVSKY_COUNTDOWN_TOLERANCE_SECONDS)return false;
  if(previousObservation){
    const previousAt=Date.parse(previousObservation.observedAt);
    const previous=previousObservation.remainingCountdownSeconds;
    if(!verifyRemainingCountdown({requestedCountdownSeconds,sentAt,observedAt:previousObservation.observedAt,
        remainingCountdownSeconds:previous})||observed<=previousAt||remainingCountdownSeconds>previous||
        Math.abs((previous-remainingCountdownSeconds)-(observed-previousAt)/1000)>
          KTVSKY_COUNTDOWN_TOLERANCE_SECONDS)return false;
  }
  return true;
}
