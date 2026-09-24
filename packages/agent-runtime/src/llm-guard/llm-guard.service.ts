import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { throwOnFailedResponse } from '../shared/throw-on-failed-response';
import { LlmGuardUnavailableError } from './errors';

export type GuardScanResult = {
  isValid: boolean;
  scanners: Record<string, number>;
};

type LlmGuardScanResponse = {
  is_valid: boolean;
  scanners: Record<string, number>;
};

const SCAN_TIMEOUT_MS = 20_000;

@Injectable()
export class LlmGuardService {
  private readonly apiUrl: string;
  private readonly authToken: string;

  constructor(configService: ConfigService) {
    this.apiUrl = configService.getOrThrow<string>('LLM_GUARD_API_URL');
    this.authToken = configService.getOrThrow<string>('LLM_GUARD_AUTH_TOKEN');
  }

  scanPrompt(prompt: string, scannersSuppress: string[] = []): Promise<GuardScanResult> {
    return this.scan('/scan/prompt', { prompt, scanners_suppress: scannersSuppress });
  }

  scanOutput(prompt: string, output: string): Promise<GuardScanResult> {
    return this.scan('/scan/output', { prompt, output, scanners_suppress: [] });
  }

  private async scan(path: string, body: Record<string, unknown>): Promise<GuardScanResult> {
    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
      });

      await throwOnFailedResponse(response, `LLM Guard ${path}`);

      const result = (await response.json()) as LlmGuardScanResponse;

      return { isValid: result.is_valid, scanners: result.scanners };
    } catch (error) {
      // Fail closed: any transport/timeout/HTTP failure here means "the scanner
      // is unavailable", never "the content passed the scan" — the caller must
      // treat this as a reason to block, not proceed unscanned.
      throw new LlmGuardUnavailableError(error);
    }
  }
}
