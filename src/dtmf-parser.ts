export interface DtmfCommand {
  type: 'dtmf';
  sequence: string;
  description: string;
}

export interface DtmfParser {
  parseCommand(text: string): DtmfCommand | null;
  extractDtmfSequence(text: string): string | null;
}

export class StandardDtmfParser implements DtmfParser {
  private readonly patterns = [
    // "Send DTMF 1-2-3-star" or "transmit DTMF 456#"
    /(?:send|transmit|dial)\s+dtmf\s+([\d\*\#A-D\s\-\.pound star hash]+)/i,
    
    // "DTMF 123*" or "DTMF one two three star"
    /^dtmf\s+([\d\*\#A-D\s\-\.pound star hash]+)/i,
    
    // "Repeater code 142*" or "access code 456"
    /(?:repeater\s+|access\s+)?code\s+([\d\*\#A-D\s\-\.]+)/i,
    
    // "Send tones 123"
    /(?:send|transmit)\s+tones?\s+([\d\*\#A-D\s\-\.]+)/i,
  ];

  parseCommand(text: string): DtmfCommand | null {
    const sequence = this.extractDtmfSequence(text);
    
    if (sequence && this.isValidDtmfSequence(sequence)) {
      return {
        type: 'dtmf',
        sequence,
        description: this.generateDescription(text, sequence)
      };
    }
    
    return null;
  }

  extractDtmfSequence(text: string): string | null {
    for (const pattern of this.patterns) {
      const match = text.match(pattern);
      if (match) {
        const rawSequence = match[1];
        const normalized = this.normalizeSequence(rawSequence);
        
        if (this.isValidDtmfSequence(normalized)) {
          return normalized;
        }
      }
    }
    
    return null;
  }

  private normalizeSequence(input: string): string {
    return input
      .toLowerCase()
      .trim()
      // Convert spelled-out symbols
      .replace(/\bstar\b/g, '*')
      .replace(/\bpound\b/g, '#')
      .replace(/\bhash\b/g, '#')
      .replace(/\basterisk\b/g, '*')
      // Convert spelled-out numbers
      .replace(/\bone\b/g, '1')
      .replace(/\btwo\b/g, '2')
      .replace(/\bthree\b/g, '3')
      .replace(/\bfour\b/g, '4')
      .replace(/\bfive\b/g, '5')
      .replace(/\bsix\b/g, '6')
      .replace(/\bseven\b/g, '7')
      .replace(/\beight\b/g, '8')
      .replace(/\bnine\b/g, '9')
      .replace(/\bzero\b/g, '0')
      // Remove separators and whitespace
      .replace(/[\s\-\.]/g, '')
      // Convert to uppercase for A-D
      .toUpperCase();
  }

  private isValidDtmfSequence(sequence: string): boolean {
    return /^[0-9A-D*#]+$/.test(sequence) && sequence.length > 0 && sequence.length <= 20;
  }

  private generateDescription(originalText: string, sequence: string): string {
    const lower = originalText.toLowerCase();
    
    if (lower.includes('repeater')) {
      return `repeater code ${sequence}`;
    }
    if (lower.includes('access')) {
      return `access code ${sequence}`;
    }
    if (lower.includes('autopatch')) {
      return `autopatch sequence ${sequence}`;
    }
    
    return `DTMF sequence ${sequence}`;
  }
}

// Factory function
export function createDtmfParser(): DtmfParser {
  return new StandardDtmfParser();
}