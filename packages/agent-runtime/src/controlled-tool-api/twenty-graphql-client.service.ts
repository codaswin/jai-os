import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type TwentyGraphqlClient } from './types';

@Injectable()
export class TwentyGraphqlClientService implements TwentyGraphqlClient {
  constructor(private readonly configService: ConfigService) {}

  async request<TResult>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<TResult> {
    const apiUrl = this.configService.getOrThrow<string>('TWENTY_API_URL');
    const apiKey = this.configService.getOrThrow<string>('TWENTY_API_KEY');

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');

      throw new Error(
        `Twenty GraphQL request failed: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 500)}` : ''}`,
      );
    }

    const body = (await response.json()) as {
      data?: TResult;
      errors?: { message: string }[];
    };

    if (body.errors?.length) {
      throw new Error(
        `Twenty GraphQL error: ${body.errors.map((error) => error.message).join(', ')}`,
      );
    }

    if (body.data === undefined) {
      throw new Error('Twenty GraphQL response had neither data nor errors');
    }

    return body.data;
  }
}
