// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { Clock, RandomBytes } from "../application/ports";
import * as crypto from "crypto";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  iso(): string {
    return new Date().toISOString();
  }
}

export class CryptoRandomBytes implements RandomBytes {
  hex(byteCount: number): string {
    return crypto.randomBytes(byteCount).toString("hex");
  }
}
