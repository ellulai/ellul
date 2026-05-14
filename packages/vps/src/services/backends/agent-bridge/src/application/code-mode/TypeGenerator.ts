// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Type Generator
 *
 * Converts GovernedToolDefinition[] → TypeScript type documentation
 * for the system prompt. The agent sees typed secureExecute() signatures
 * and generates correct tool calls.
 *
 * Walks each tool's inputSchema (JSON Schema) and produces documentation-style
 * type strings. NOT executable TypeScript — included as a comment block in
 * the system prompt.
 */

import type { GovernedToolDefinition } from './Types';

/**
 * Generate TypeScript type documentation for all approved tools.
 * Output format:
 *
 * ```
 * // Available tools for secureExecute():
 * //
 * // secureExecute("db_query", { sql: string, params?: unknown[] }) → Promise<unknown>
 * // secureExecute("file_read", { path: string }) → Promise<unknown>
 * ```
 */
export function generateToolTypeDefinitions(tools: GovernedToolDefinition[]): string {
  if (tools.length === 0) return '';

  const lines = tools
    .filter(t => t.lifecycleStatus === 'approved' && t.exposureStatus === 'agent_visible')
    .map(tool => {
      const argsType = schemaToInlineType(tool.inputSchema);
      return `secureExecute("${tool.name}", ${argsType}) → Promise<unknown>`;
    });

  if (lines.length === 0) return '';

  return [
    'Available tools for secureExecute():',
    '',
    ...lines.map(l => `  ${l}`),
  ].join('\n');
}

// ── JSON Schema → Inline TypeScript Type ──

function schemaToInlineType(schema: Record<string, unknown>): string {
  if (!schema || typeof schema !== 'object') return '{}';

  const type = schema.type as string | undefined;
  if (!type || type !== 'object') return '{}';

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || typeof properties !== 'object') return '{}';

  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  const fields = Object.entries(properties).map(([key, propSchema]) => {
    const tsType = jsonSchemaToTsType(propSchema);
    const optional = required.has(key) ? '' : '?';
    return `${sanitizeKey(key)}${optional}: ${tsType}`;
  });

  if (fields.length === 0) return '{}';
  return `{ ${fields.join(', ')} }`;
}

function jsonSchemaToTsType(schema: Record<string, unknown>): string {
  if (!schema || typeof schema !== 'object') return 'unknown';

  // Enum
  if (Array.isArray(schema.enum)) {
    return (schema.enum as unknown[])
      .map(v => (typeof v === 'string' ? `"${v}"` : String(v)))
      .join(' | ');
  }

  // Ref / anyOf / oneOf — fallback
  if (schema.$ref || schema.anyOf || schema.oneOf) return 'unknown';

  const type = schema.type as string | undefined;
  if (!type) return 'unknown';

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) {
        return `${jsonSchemaToTsType(items)}[]`;
      }
      return 'unknown[]';
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      if (!properties) return 'Record<string, unknown>';

      const required = new Set(
        Array.isArray(schema.required) ? (schema.required as string[]) : [],
      );

      const fields = Object.entries(properties).map(([key, propSchema]) => {
        const tsType = jsonSchemaToTsType(propSchema);
        const optional = required.has(key) ? '' : '?';
        return `${sanitizeKey(key)}${optional}: ${tsType}`;
      });

      return `{ ${fields.join(', ')} }`;
    }
    default:
      return 'unknown';
  }
}

function sanitizeKey(key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
}
