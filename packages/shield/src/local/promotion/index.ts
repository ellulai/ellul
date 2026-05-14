// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

export type {
  PromotionPayload,
  EncryptedPromotionPayload,
  ImportReceipt,
  PromotionTokenClaims,
  PromotionInitResponse,
  PromotionInventory,
  PromotionSecret,
  PromotionRule,
} from './types';

export {
  PROMOTION_LIMITS,
  validatePayloadLimits,
  PromotionValidationError,
} from './types';

export {
  executePromotion,
  getPromotionInventory,
  isPromotionInProgress,
} from './executor';
