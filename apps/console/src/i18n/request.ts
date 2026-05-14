// SPDX-License-Identifier: MIT

import { createRequestConfig } from "@ellul.ai/i18n/request";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";

export default createRequestConfig({
  surface: "console",
  loadMessages,
});
