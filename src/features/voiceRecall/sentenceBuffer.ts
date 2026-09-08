export class SpeakableSentenceBuffer {
  private buffer = "";

  append(delta: string): string[] {
    this.buffer += delta;
    const sentences: string[] = [];
    let boundary = -1;
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      const next = this.buffer[index + 1] ?? "";
      const decimalPoint = char === "." && /\d/.test(this.buffer[index - 1] ?? "") && /\d/.test(next);
      const abbreviationPoint = char === "." && /[A-Za-z]/.test(this.buffer[index - 1] ?? "") && /[A-Za-z]/.test(next);
      if (!decimalPoint && !abbreviationPoint && /[。！？!?；;\n]/.test(char)) {
        const sentence = this.buffer.slice(boundary + 1, index + 1).trim();
        if (sentence) sentences.push(sentence);
        boundary = index;
      }
    }
    if (boundary >= 0) this.buffer = this.buffer.slice(boundary + 1);
    return sentences;
  }

  flush(): string | undefined {
    const value = this.buffer.trim();
    this.buffer = "";
    return value || undefined;
  }
}
