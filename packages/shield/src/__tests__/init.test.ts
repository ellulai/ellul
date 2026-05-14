// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';

/** Slug format: sbx-{7 lowercase alphanumeric chars} */
const SLUG_REGEX = /^sbx-[a-z0-9]{7}$/;

describe('project slug validation', () => {
  const valid = ['sbx-abc1234', 'sbx-0000000', 'sbx-zzzzzzz', 'sbx-a1b2c3d'];
  const invalid = [
    'my-app',           // old-style name
    'sbx-ABC1234',      // uppercase
    'sbx-abc123',       // too short (6 chars)
    'sbx-abc12345',     // too long (8 chars)
    'sbx-abc_123',      // underscores
    'sbx-',             // no id
    'sbx',              // missing dash
    'SBX-abc1234',      // uppercase prefix
    '',                 // empty
    '../traversal',     // path traversal
    'welcome',          // old default project
  ];

  for (const slug of valid) {
    it(`accepts "${slug}"`, () => {
      expect(SLUG_REGEX.test(slug)).toBe(true);
    });
  }

  for (const slug of invalid) {
    it(`rejects "${slug}"`, () => {
      expect(SLUG_REGEX.test(slug)).toBe(false);
    });
  }
});
