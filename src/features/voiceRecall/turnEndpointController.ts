export interface TurnEndpointConfig {
  likelyCompleteSilenceMs: number;
  incompleteUtteranceSilenceMs: number;
  longTurnWarningMs: number;
}

export const DEFAULT_TURN_ENDPOINT_CONFIG: TurnEndpointConfig = {
  likelyCompleteSilenceMs: 1_800,
  incompleteUtteranceSilenceMs: 4_000,
  longTurnWarningMs: 45_000,
};

const looksIncomplete = (text: string): boolean =>
  /(?:因为|所以|然后|以及|或者|首先|其次|比如|包括|也就是|但是|而且|一是|二是|三是|and|or|because|for example)[，、,:：;；\s]*$/i.test(text.trim());

export class TurnEndpointController {
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private longTurnTimer?: ReturnType<typeof setTimeout>;
  private partialText = "";
  private speaking = false;

  constructor(
    private readonly handlers: { onEndpoint: () => void; onLongTurn: () => void },
    private readonly config: TurnEndpointConfig = DEFAULT_TURN_ENDPOINT_CONFIG,
  ) {}

  startTurn() {
    this.reset();
    this.longTurnTimer = setTimeout(this.handlers.onLongTurn, this.config.longTurnWarningMs);
  }

  updatePartial(text: string) {
    this.partialText = text;
  }

  onSpeechStart() {
    this.speaking = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  onSpeechEnd() {
    this.speaking = false;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    const delay = looksIncomplete(this.partialText)
      ? this.config.incompleteUtteranceSilenceMs
      : this.config.likelyCompleteSilenceMs;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      if (!this.speaking) this.handlers.onEndpoint();
    }, delay);
  }

  finishManually() {
    this.reset();
    this.handlers.onEndpoint();
  }

  reset() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.longTurnTimer) clearTimeout(this.longTurnTimer);
    this.silenceTimer = undefined;
    this.longTurnTimer = undefined;
    this.partialText = "";
    this.speaking = false;
  }
}
