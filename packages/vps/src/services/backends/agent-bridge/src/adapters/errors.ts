// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Schema } from "effect";

export class ProviderAdapterValidationError extends Schema.TaggedErrorClass<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

export class ProviderAdapterSessionNotFoundError extends Schema.TaggedErrorClass<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

export class ProviderAdapterSessionClosedError extends Schema.TaggedErrorClass<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

export class ProviderAdapterRequestError extends Schema.TaggedErrorClass<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

export class ProviderAdapterProcessError extends Schema.TaggedErrorClass<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

export class ProviderUnsupportedError extends Schema.TaggedErrorClass<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

export class ProviderSessionNotFoundError extends Schema.TaggedErrorClass<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown provider thread: ${this.threadId}`;
  }
}

export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

export type ProviderServiceError =
  | ProviderUnsupportedError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError;
