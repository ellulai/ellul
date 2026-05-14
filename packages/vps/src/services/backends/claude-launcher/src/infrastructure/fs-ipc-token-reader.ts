// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import * as fs from "fs";
import type { IpcTokenReader } from "../application/ports";

/** Reads the shield-IPC service token from /run/shield/internal-<service>.token. */
export class FsIpcTokenReader implements IpcTokenReader {
  constructor(private readonly tokenPath: string) {}
  read(): string {
    const value = fs.readFileSync(this.tokenPath, "utf8").trim();
    if (!value) {
      throw new Error(`empty token file: ${this.tokenPath}`);
    }
    return value;
  }
}
