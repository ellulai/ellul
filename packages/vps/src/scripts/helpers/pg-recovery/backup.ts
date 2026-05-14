// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/helpers/pg-recovery/backup-encrypted.sh';

export function getPgBackupScript(): string {
  return content;
}
