import type { AsrStreamAdapter, AsrStreamEvent, AsrStreamRequest, VoiceAudioFrame } from "./contracts";
import type { AsrProviderProfile } from "./providerProfiles";

export interface VoiceAsrTransportSession {
  events: AsyncIterable<AsrStreamEvent>;
  send(frame: VoiceAudioFrame): Promise<void>;
  finish(): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceAsrTransport {
  open(input: {
    profile: AsrProviderProfile;
    sessionId: string;
    turnId: string;
    operationId: string;
    language: string;
    format: AsrStreamRequest["format"];
    signal: AbortSignal;
  }): Promise<VoiceAsrTransportSession>;
}

export class TransportAsrStreamAdapter implements AsrStreamAdapter {
  readonly profileId: string;

  constructor(private readonly profile: AsrProviderProfile, private readonly transport: VoiceAsrTransport) {
    this.profileId = profile.id;
  }

  async *transcribe(request: AsrStreamRequest): AsyncIterable<AsrStreamEvent> {
    if (!this.profile.acceptedSampleRates.includes(request.format.sampleRate)
      || !this.profile.acceptedFormats.includes(request.format.encoding)) {
      throw new Error(`${this.profile.providerName} 不支持当前音频格式。`);
    }
    const session = await this.transport.open({
      profile: this.profile,
      sessionId: request.sessionId,
      turnId: request.turnId,
      operationId: request.operationId,
      language: request.language,
      format: request.format,
      signal: request.signal,
    });
    let senderError: unknown;
    const sender = (async () => {
      for await (const frame of request.frames) {
        if (request.signal.aborted) break;
        await session.send(frame);
      }
      if (!request.signal.aborted) await session.finish();
    })().catch(async (error: unknown) => {
      senderError = error;
      await session.close();
    });
    try {
      for await (const event of session.events) yield event;
      await sender;
      if (senderError) throw senderError;
    } finally {
      await session.close();
    }
  }
}
