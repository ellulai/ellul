// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Builtin Tool Registry
 *
 * Registers `execute_code` as a builtin tool in the MCP gateway.
 *   - Capability: execution:code_eval (types.ts line 99)
 *   - Gate: exec (CAPABILITY_GATE line 205)
 *   - Input: { code: string }
 */

import { createHash } from 'crypto';

import type { McpGateway, ToolCallContext } from '../mcp-tool/governance/McpGateway';
import type { ToolCallResult, GovernedToolDefinition } from '../mcp-tool/governance/Types';
import { TAXONOMY_VERSION, GATEWAY_VERSION } from '../mcp-tool/governance/Types';

import type { CodeModeService } from './CodeMode';
import { generateToolTypeDefinitions } from './TypeGenerator';

export const BUILTIN_CONNECTION_ID = '__builtin__';

const EXECUTE_CODE_DEFINITION: GovernedToolDefinition = {
  name: 'execute_code',
  description:
    'Execute TypeScript code that can batch multiple tool calls via secureExecute(). ' +
    'Use for multi-step operations (3+ tool calls, data transformation). ' +
    'Each secureExecute() call goes through the same security gates as individual tool calls.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'TypeScript code to execute. Use secureExecute(toolName, args) to call tools. ' +
          'Use secureExecuteBatch([{tool, args}, ...]) for independent parallel calls. ' +
          'Return a value to send it back as the result.',
      },
    },
    required: ['code'],
  },
  outputSchema: null,
  provider: {
    providerId: BUILTIN_CONNECTION_ID,
    providerType: 'builtin' as 'mcp',
    endpoint: '',
    transport: 'stdio' as const,
    tlsFingerprint: null,
    manifestFingerprint: null,
    toolListHash: '',
  },
  capability: 'execution:code_eval',
  lifecycleStatus: 'approved',
  exposureStatus: 'agent_visible',
  definitionHash: createHash('sha256')
    .update('execute_code:code-mode-builtin')
    .digest('hex'),
  discoveredAt: new Date().toISOString(),
  classifiedAt: new Date().toISOString(),
  taxonomyVersion: TAXONOMY_VERSION,
};

/**
 * Register the execute_code builtin tool in the gateway.
 * Called once at startup, after CodeModeService is created.
 */
export function registerBuiltinTools(
  gateway: McpGateway,
  codeModeService: CodeModeService,
): void {
  gateway.registerBuiltinTool(
    'execute_code',
    EXECUTE_CODE_DEFINITION,
    async (args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> => {
      const code = args.code;
      if (!code || typeof code !== 'string') {
        return {
          status: 'error',
          errorCode: 'INVALID_INPUT',
          message: 'execute_code requires a "code" argument of type string',
          retryable: false,
          providerId: BUILTIN_CONNECTION_ID,
        };
      }

      // Generate type definitions from current approved tools
      const governedTools = gateway.getAllGovernedTools();
      const typeDefs = generateToolTypeDefinitions(governedTools);

      const result = await codeModeService.executeCode(code, context, typeDefs);

      // Map CodeModeResult → ToolCallResult
      if (result.status === 'success') {
        return {
          status: 'success',
          output: result,
          durationMs: result.durationMs,
          artifactId: createHash('sha256')
            .update(`${BUILTIN_CONNECTION_ID}:execute_code:${context.threadId}:${Date.now()}`)
            .digest('hex'),
          providerId: BUILTIN_CONNECTION_ID,
        };
      }

      if (result.status === 'tool_denied') {
        return {
          status: 'approval_required',
          requiredGate: (result.deniedTool?.gate ?? 'exec') as 'exec',
          requiredCapability: 'execution:code_eval',
          reason: result.deniedTool?.reason ?? 'Tool call denied inside code-mode execution',
          pendingArtifactId: '',
        };
      }

      return {
        status: 'error',
        errorCode: result.status === 'timeout' ? 'TIMEOUT' : 'EXECUTION_FAILED',
        message: result.error?.message ?? `Code-mode execution ${result.status}`,
        retryable: result.status === 'timeout',
        providerId: BUILTIN_CONNECTION_ID,
      };
    },
  );
}
